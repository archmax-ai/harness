/**
 * The declarative case schema: one YAML document per `*.test.yaml` file,
 * parsed and validated fail-closed. Unknown keys are errors — a typo'd
 * assertion must never silently pass — and every rejection names the file and
 * the offending location so the author can fix it without running anything.
 *
 * A case is one conversation on one session: `steps` is a single flat,
 * sequential list in which actions (`send`, `decide`, `deliver`) and assertions
 * (`reachedState`, `reply`, `grade`, …) are peers. An assertion evaluates
 * against the view of the nearest action above it; an assertion with no
 * preceding action is a schema error. A case file carries no version of its
 * own: the authoring surface is versioned once, by `runtime.version`.
 *
 * Everything is zod: leaf shapes are strict objects, each step key maps to one
 * schema in {@link STEP_SCHEMAS}, and a single-key dispatcher names an unknown
 * key and lists the known ones. `validateWorkflow` and the runner share it.
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { regexFromString } from "../core/match.js";
import type { ToolMockSpec } from "../core/tool-mocks.js";
import {
  CaseSchemaError,
  caseIdForFile,
  type CaseAction,
  type CaseExpectation,
  type CaseDocument,
  type CaseStep,
  type CaseWorkspaceEntry,
  type ReplyToken,
} from "./case-document.js";

// The document model and its path helpers are re-exported so every importer
// of the grammar sees one module.
export {
  CaseSchemaError,
  TEST_FILE_EXTENSIONS,
  caseIdForFile,
  collectFileReferences,
  isTestFile,
  normalizeFixturePath,
  stripTestExtension,
} from "./case-document.js";
export type {
  CaseAction,
  CaseDocument,
  CaseExpectation,
  CaseStep,
  CaseTriggerDecl,
  CaseWorkspaceEntry,
  ReplyToken,
} from "./case-document.js";
import { VARIABLE_NAME_PATTERN } from "../machine/variables.js";

/**
 * Length budgets for the two prose fields. `title` is a label the CLI prints
 * beside a verdict, so it has to fit a terminal line; `description` states the
 * scenario and what is asserted in a sentence or two. Longer rationale belongs
 * in a YAML comment above the document. Measured on whitespace-collapsed text
 * so a folded (`>-`) and a literal (`|`) block of the same prose score alike.
 */
export const CASE_TITLE_MAX_LENGTH = 60;
export const CASE_DESCRIPTION_MAX_LENGTH = 200;

const collapseWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

const action = (a: CaseAction): CaseStep => ({ kind: "action", action: a });
const assertion = (e: CaseExpectation): CaseStep => ({ kind: "assert", expect: e });

// ---------------------------------------------------------------------------
// Leaf vocabulary

/** A `/pattern/flags` string is a regex; a malformed one is a static error, never a literal. */
function checkRegexString(raw: string, ctx: z.RefinementCtx, path: PropertyKey[] = []): void {
  try {
    regexFromString(raw);
  } catch (err) {
    ctx.addIssue({
      code: "custom",
      path,
      message: `malformed regex ${JSON.stringify(raw)}: ${(err as Error).message}`,
    });
  }
}

/** Reject malformed regex strings anywhere inside a matcher value (tool input, `whenInput`). */
function checkMatcherStrings(value: unknown, ctx: z.RefinementCtx, path: PropertyKey[] = []): void {
  if (typeof value === "string") return checkRegexString(value, ctx, path);
  if (Array.isArray(value)) value.forEach((v, i) => checkMatcherStrings(v, ctx, [...path, i]));
  else if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) checkMatcherStrings(v, ctx, [...path, k]);
  }
}

const matcherSchema = z
  .record(z.string(), z.unknown())
  .superRefine((value, ctx) => checkMatcherStrings(value, ctx));

/** `includes`/`excludes` accept a single token or a list of tokens; `/pattern/flags` compiles to a regex. */
const replyTokens = z
  .union([z.string(), z.array(z.string())])
  .transform((value, ctx): ReplyToken[] => {
    const list = typeof value === "string" ? [value] : value;
    return list.map((raw, i) => {
      try {
        const regex = regexFromString(raw);
        return regex ? { raw, regex } : { raw };
      } catch (err) {
        ctx.addIssue({
          code: "custom",
          path: typeof value === "string" ? [] : [i],
          message: `malformed regex ${JSON.stringify(raw)}: ${(err as Error).message}`,
        });
        return { raw };
      }
    });
  });

const literalTrue = (key: string) => z.literal(true, { error: `'${key}' takes the literal true` });
const slug = (what: string) =>
  z.string({ error: `takes a ${what} string` }).min(1, `takes a ${what} string`);

const toolCall = (key: "calledTool" | "notCalledTool" | "blockedTool") =>
  z
    .strictObject({ name: z.string().min(1), input: matcherSchema.optional() })
    .transform((v) => assertion({ assert: key, name: v.name, ...(v.input && { input: v.input }) }));

/**
 * `grade`: a model scores the turn against `closedQA`; `atLeast` decides the
 * outcome.
 */
const gradeSchema = z
  .strictObject({ closedQA: z.string().min(1), atLeast: z.number().min(0).max(1) })
  .transform((v) => assertion({ assert: "grade", closedQA: v.closedQA, atLeast: v.atLeast }));

// ---------------------------------------------------------------------------
// The step registry: one zod schema per step key, each yielding a CaseStep.

const ACTION_SCHEMAS: Record<string, z.ZodType<CaseStep>> = {
  send: slug("user message").transform((message) => action({ action: "send", message })),
  decide: z
    .strictObject({ to: z.string().min(1), comment: z.string().optional() })
    .transform((v) =>
      action({
        action: "decide",
        to: v.to,
        ...(v.comment !== undefined && { comment: v.comment }),
      }),
    ),
  /**
   * A firing delivered into a park: the trigger id the resumed session adopts
   * and the variables the event carried. Any id is deliverable, so only its
   * presence is checked; variable names are checked here so an unaddressable
   * name fails at parse time rather than mid-run.
   */
  deliver: z
    .strictObject({
      trigger: z.string().min(1),
      variables: z.record(z.string().regex(VARIABLE_NAME_PATTERN), z.unknown()).optional(),
    })
    .transform((v) =>
      action({
        action: "deliver",
        trigger: v.trigger,
        ...(v.variables && { variables: v.variables }),
      }),
    ),
};

type ParkPin = { channel?: "decision" | "input"; state?: string };
const parkedPinSchema = z.strictObject({
  channel: z.enum(["decision", "input"]).optional(),
  state: z.string().min(1).optional(),
});

/** Re-issue a nested parse's failures on the outer context (paths preserved), yielding `null` on failure. */
function forward<T>(
  result: z.ZodSafeParseResult<T>,
  ctx: z.RefinementCtx,
  prefix: PropertyKey[] = [],
): T | null {
  if (result.success) return result.data;
  for (const issue of result.error.issues) {
    ctx.addIssue({
      code: "custom",
      path: [...prefix, ...issue.path],
      message: renderIssue({ ...issue, path: [] }),
    });
  }
  return null;
}

const ASSERTION_SCHEMAS: Record<string, z.ZodType<CaseStep>> = {
  succeeded: literalTrue("succeeded").transform(() => assertion({ assert: "succeeded" })),
  usedNoTools: literalTrue("usedNoTools").transform(() => assertion({ assert: "usedNoTools" })),
  noTraversal: literalTrue("noTraversal").transform(() => assertion({ assert: "noTraversal" })),
  /**
   * `true` asserts a park in either channel; naming one pins it, so a wait
   * flow cannot pass by parking at a human state instead. The mapping form
   * also pins *where* the session parked — which `reachedState` cannot express,
   * since parking commits no transition.
   */
  parked: z.unknown().transform((raw, ctx) => {
    let pin: ParkPin | null = null;
    if (raw === true) pin = {};
    else if (raw === "decision" || raw === "input") pin = { channel: raw };
    else if (isPlainObject(raw)) pin = forward(parkedPinSchema.safeParse(raw), ctx);
    else {
      ctx.addIssue({
        code: "custom",
        message:
          "'parked' takes the literal true, 'decision' | 'input' to pin the channel, " +
          "or a mapping { channel?, state? } to pin where the session parked",
      });
    }
    if (!pin) return z.NEVER;
    return assertion({
      assert: "parked",
      ...(pin.channel && { channel: pin.channel }),
      ...(pin.state && { state: pin.state }),
    });
  }),
  reachedState: slug("state slug").transform((state) =>
    assertion({ assert: "reachedState", state }),
  ),
  triggerArrival: slug("trigger id").transform((trigger) =>
    assertion({ assert: "triggerArrival", trigger }),
  ),
  reply: z
    .strictObject({ includes: replyTokens.optional(), excludes: replyTokens.optional() })
    .refine((v) => v.includes !== undefined || v.excludes !== undefined, {
      message: "declare at least one of 'includes'/'excludes'",
    })
    .transform((v) =>
      assertion({ assert: "reply", includes: v.includes ?? [], excludes: v.excludes ?? [] }),
    ),
  calledTool: toolCall("calledTool"),
  notCalledTool: toolCall("notCalledTool"),
  blockedTool: toolCall("blockedTool"),
  /** `status` defaults to `ok`: the interesting assertion is almost always "it ran and worked". */
  ranWorkflow: z
    .strictObject({
      workflow: z.string().min(1),
      status: z.enum(["ok", "error"]).optional(),
      count: z.number().int().nonnegative().optional(),
    })
    .transform((v) =>
      assertion({
        assert: "ranWorkflow",
        workflow: v.workflow,
        status: v.status ?? "ok",
        ...(v.count !== undefined && { count: v.count }),
      }),
    ),
  trail: z
    .strictObject({
      to: z.string().optional(),
      kind: z.string().optional(),
      reason: z.string().optional(),
      count: z.number().int().nonnegative(),
    })
    .refine((v) => v.to !== undefined || v.kind !== undefined || v.reason !== undefined, {
      message: "declare at least one of 'to'/'kind'/'reason' to match against",
    })
    .transform((v) =>
      assertion({
        assert: "trail",
        ...(v.to !== undefined && { to: v.to }),
        ...(v.kind !== undefined && { stepKind: v.kind }),
        ...(v.reason !== undefined && { reason: v.reason }),
        count: v.count,
      }),
    ),
  variables: z
    .strictObject({
      expect: z.record(z.string(), z.unknown()),
      /** Per-name dotted path into a structured value, e.g. `items.0.sku`. */
      path: z.record(z.string(), z.string()).optional(),
      /** Per-name expected lock state. */
      locked: z.record(z.string(), z.boolean()).optional(),
    })
    .transform((v) =>
      assertion({
        assert: "variables",
        expect: v.expect,
        ...(v.path && { path: v.path }),
        ...(v.locked && { locked: v.locked }),
      }),
    ),
  grade: gradeSchema,
};

/** Every step key the grammar knows, actions first. */
export const STEP_SCHEMAS: Record<string, z.ZodType<CaseStep>> = {
  ...ACTION_SCHEMAS,
  ...ASSERTION_SCHEMAS,
};

/**
 * The single-key dispatcher: a step is a mapping with exactly one key, and that
 * key selects its schema. An unknown key is named alongside the known ones —
 * which a bare union could not do.
 */
const stepSchema = z.unknown().transform((raw, ctx): CaseStep => {
  if (!isPlainObject(raw)) {
    ctx.addIssue({
      code: "custom",
      message:
        "a step is a single-key mapping — an action ('send', 'decide', 'deliver') or an assertion " +
        "(e.g. '- send: \"hi\"' then '- reachedState: done')",
    });
    return z.NEVER;
  }
  const keys = Object.keys(raw);
  if (keys.length !== 1) {
    ctx.addIssue({
      code: "custom",
      message: `a step declares exactly one key, got [${keys.join(", ") || "none"}]`,
    });
    return z.NEVER;
  }
  const key = keys[0] as string;
  const schema = STEP_SCHEMAS[key];
  if (!schema) {
    ctx.addIssue({
      code: "custom",
      message:
        `unknown step '${key}' (actions: ${Object.keys(ACTION_SCHEMAS).join(", ")}; ` +
        `assertions: ${Object.keys(ASSERTION_SCHEMAS).join(", ")})`,
    });
    return z.NEVER;
  }
  return forward(schema.safeParse(raw[key]), ctx, [key]) ?? z.NEVER;
});

// ---------------------------------------------------------------------------
// The document

const workspaceEntry = z.unknown().transform((content, ctx): CaseWorkspaceEntry => {
  // A single-key `{ from: <path> }` mapping is a file reference; everything
  // else (strings, mappings, lists, scalars) is inline content.
  if (isPlainObject(content) && Object.keys(content).length === 1 && "from" in content) {
    const from = content.from;
    if (typeof from !== "string" || from.length === 0) {
      ctx.addIssue({ code: "custom", message: "'from' takes a tests/-relative file path string" });
      return z.NEVER;
    }
    return { source: "file", from };
  }
  return { source: "inline", content };
});

const mockSchema = z
  .strictObject({
    tool: z.string().min(1),
    whenInput: matcherSchema.optional(),
    result: z.unknown(),
  })
  .transform((m): ToolMockSpec => ({
    name: m.tool,
    ...(m.whenInput && { whenInput: m.whenInput }),
    result: m.result,
  }));

const TITLE_REQUIRED =
  "'title' is required: a short one-line label for the case (e.g. 'Unknown requester is rejected at entry')";
const DESCRIPTION_REQUIRED =
  "'description' is required: one or two sentences stating the scenario driven and what is asserted";

const documentSchema = z
  .strictObject({
    title: z.string({ error: TITLE_REQUIRED }),
    description: z.string({ error: DESCRIPTION_REQUIRED }),
    skip: z
      .string({ error: "'skip' takes a reason string" })
      .min(1, "'skip' takes a reason string")
      .optional(),
    trigger: z.strictObject({ id: z.string().min(1) }).optional(),
    /** Case-level variable seeds, applied as the session's seeded `variables` (locked). */
    variables: z
      .record(
        z.string().regex(VARIABLE_NAME_PATTERN, {
          error:
            "is not a valid variable name (lowercase letters, digits and underscores, starting with a letter)",
        }),
        z.unknown(),
      )
      .optional(),
    workspace: z
      .record(z.string().min(1, "workspace paths must be non-empty"), workspaceEntry)
      .optional(),
    mocks: z.array(mockSchema, { error: "'mocks' must be a list" }).optional(),
    steps: z.array(stepSchema, { error: "'steps' must be a list" }).optional(),
  })
  .superRefine((doc, ctx) => {
    const issue = (path: PropertyKey[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    if (typeof doc.title === "string") {
      if (doc.title.trim().length === 0) issue([], TITLE_REQUIRED);
      // Trimmed, so a `|` block holding one line is fine — only genuine multi-line prose is rejected.
      else if (doc.title.trim().includes("\n"))
        issue(["title"], "'title' is a single line — put the detail in 'description'");
      else if (collapseWhitespace(doc.title).length > CASE_TITLE_MAX_LENGTH) {
        issue(
          ["title"],
          `'title' must be at most ${CASE_TITLE_MAX_LENGTH} characters (got ${collapseWhitespace(doc.title).length}) — ` +
            "keep it a label; put the detail in 'description'",
        );
      }
    }
    if (typeof doc.description === "string") {
      const length = collapseWhitespace(doc.description).length;
      if (length === 0) issue([], DESCRIPTION_REQUIRED);
      else if (length > CASE_DESCRIPTION_MAX_LENGTH) {
        issue(
          ["description"],
          `'description' must be at most ${CASE_DESCRIPTION_MAX_LENGTH} characters (got ${length}) — ` +
            "keep it to one or two sentences; longer rationale belongs in a YAML comment above the document",
        );
      }
    }
    // Assertions evaluate against the nearest action above them, so the first
    // step that is not an action has nothing to evaluate against.
    let hasAction = false;
    for (const [i, step] of (doc.steps ?? []).entries()) {
      if (!step || typeof step !== "object") continue;
      if (step.kind === "action") hasAction = true;
      else if (!hasAction) {
        issue(
          ["steps", i],
          `assertion '${step.expect.assert}' has no preceding action — put a 'send', 'decide', or 'deliver' step before it`,
        );
      }
    }
  });

const TOP_LEVEL_KEYS = Object.keys(documentSchema.shape);

/** Render a zod path the way the docs address steps: `steps[2].reply.includes[0]`. */
function renderPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>(
    (acc, seg) =>
      typeof seg === "number" ? `${acc}[${seg}]` : acc ? `${acc}.${String(seg)}` : String(seg),
    "",
  );
}

function renderIssue(issue: z.core.$ZodIssue): string {
  const at = renderPath(issue.path);
  const prefix = at ? `${at}: ` : "";
  if (issue.code === "unrecognized_keys") {
    const known = issue.path.length === 0 ? ` (known: ${TOP_LEVEL_KEYS.join(", ")})` : "";
    return `${prefix}unknown key ${issue.keys.map((k) => `'${k}'`).join(", ")}${known}`;
  }
  // A record key that failed its own schema: say why, not "invalid key".
  if (issue.code === "invalid_key")
    return `${prefix}${issue.issues.map((i) => i.message).join("; ")}`;
  return `${prefix}${issue.message}`;
}

/** Parse and validate one case document. Throws {@link CaseSchemaError} on any structural violation. */
export function parseCaseDocument(file: string, source: string, testsDir: string): CaseDocument {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (err) {
    throw new CaseSchemaError(file, null, `YAML parse error: ${(err as Error).message}`);
  }
  if (!isPlainObject(raw)) {
    throw new CaseSchemaError(
      file,
      null,
      "a test case is a YAML mapping (title, description, steps, ...)",
    );
  }
  const result = documentSchema.safeParse(raw);
  if (!result.success) {
    throw new CaseSchemaError(file, null, result.error.issues.map(renderIssue).join("; "));
  }
  const doc = result.data;
  return {
    file,
    id: caseIdForFile(file, testsDir),
    title: collapseWhitespace(doc.title),
    description: collapseWhitespace(doc.description),
    ...(doc.skip !== undefined && { skip: doc.skip }),
    ...(doc.trigger !== undefined && { trigger: doc.trigger }),
    ...(doc.variables !== undefined && { variables: doc.variables }),
    workspace: doc.workspace ?? {},
    mocks: doc.mocks ?? [],
    steps: doc.steps ?? [],
  };
}

// ---------------------------------------------------------------------------
// The inverse: a document back to its YAML

/** A step as its YAML form: the single-key mapping the grammar reads. */
function serializeStep(step: CaseStep): Record<string, unknown> {
  if (step.kind === "action") {
    const a = step.action;
    switch (a.action) {
      case "send":
        return { send: a.message };
      case "decide":
        return { decide: { to: a.to, ...(a.comment !== undefined && { comment: a.comment }) } };
      case "deliver":
        return { deliver: { trigger: a.trigger, ...(a.variables && { variables: a.variables }) } };
    }
  }
  const e = step.expect;
  const tokens = (list: ReplyToken[]) => list.map((t) => t.raw);
  switch (e.assert) {
    case "succeeded":
    case "usedNoTools":
    case "noTraversal":
      return { [e.assert]: true };
    case "parked":
      if (e.state) return { parked: { ...(e.channel && { channel: e.channel }), state: e.state } };
      return { parked: e.channel ?? true };
    case "reachedState":
      return { reachedState: e.state };
    case "triggerArrival":
      return { triggerArrival: e.trigger };
    case "reply":
      return {
        reply: {
          ...(e.includes.length > 0 && { includes: tokens(e.includes) }),
          ...(e.excludes.length > 0 && { excludes: tokens(e.excludes) }),
        },
      };
    case "calledTool":
    case "notCalledTool":
    case "blockedTool":
      return { [e.assert]: { name: e.name, ...(e.input && { input: e.input }) } };
    case "ranWorkflow":
      return {
        ranWorkflow: { workflow: e.workflow, status: e.status, ...(e.count !== undefined && { count: e.count }) },
      };
    case "trail":
      return {
        trail: {
          ...(e.to !== undefined && { to: e.to }),
          ...(e.stepKind !== undefined && { kind: e.stepKind }),
          ...(e.reason !== undefined && { reason: e.reason }),
          count: e.count,
        },
      };
    case "variables":
      return {
        variables: { expect: e.expect, ...(e.path && { path: e.path }), ...(e.locked && { locked: e.locked }) },
      };
    case "grade":
      return { grade: { closedQA: e.closedQA, atLeast: e.atLeast } };
  }
}

/**
 * The YAML of a {@link CaseDocument}: the inverse of {@link parseCaseDocument},
 * in the grammar's own key order (`title`, `description`, `skip`, `trigger`,
 * `variables`, `workspace`, `mocks`, `steps`), so an editor that parses a file,
 * edits the document and writes it back changes only what it edited. `file` and
 * `id` are the file's, not the document's, and are not written. A reply token
 * keeps its `/pattern/flags` spelling.
 * Comments are not part of the document and are not preserved — a host that
 * keeps a leading comment re-attaches it. Holds `parse(serialize(doc))` deep-equal
 * to `doc` for every document the grammar accepts.
 */
export function serializeCaseDocument(doc: CaseDocument): string {
  const out: Record<string, unknown> = {
    title: doc.title,
    description: doc.description,
    ...(doc.skip !== undefined && { skip: doc.skip }),
    ...(doc.trigger !== undefined && { trigger: { id: doc.trigger.id } }),
    ...(doc.variables !== undefined && { variables: doc.variables }),
  };
  if (Object.keys(doc.workspace).length > 0) {
    out.workspace = Object.fromEntries(
      Object.entries(doc.workspace).map(([path, entry]) => [
        path,
        entry.source === "file" ? { from: entry.from } : entry.content,
      ]),
    );
  }
  if (doc.mocks.length > 0) {
    out.mocks = doc.mocks.map((m) => ({
      tool: m.name,
      ...(m.whenInput && { whenInput: m.whenInput }),
      result: m.result,
    }));
  }
  if (doc.steps.length > 0) out.steps = doc.steps.map(serializeStep);
  // No line folding: a long `send` stays one line, as an author would write it.
  return stringifyYaml(out, { lineWidth: 0 });
}

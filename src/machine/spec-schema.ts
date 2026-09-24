/**
 * The complete `workflow.yaml` schema, in Zod — the one source for every rule a
 * single document has to satisfy. Two layers: the **shape** (`machineSpecSchema`,
 * every object `.strict()` so a misspelled key is an error naming the key) and
 * the **cross-references inside the document** (`refineSpec`), which run once
 * the shape holds. `types.ts` infers its types from here; `load-spec.ts` and
 * `validate` both parse through `parseMachineSpec`. Warnings live in `lint-spec.ts`.
 */
import { z } from "zod";
import { normalizeAllowEntry } from "./allow.js";
import { normalizeHooks } from "../lifecycle/hook-shape.js";
import { isSlug } from "./slug.js";
import { MANUAL_TRIGGER, parseSessionPath, stateTriggerIds } from "./triggers.js";
import {
  parseReferences,
  referenceError,
  TITLE_VARIABLE,
  TRIGGER_VARIABLE,
  VARIABLE_NAME_PATTERN,
} from "./variables.js";

// --- Shared scalars ------------------------------------------------------------

const NON_EMPTY = "must be a non-empty string";

const nonEmptyString = z
  .string({ error: NON_EMPTY })
  .refine((value) => value.trim() !== "", NON_EMPTY);

const POSITIVE = "must be a positive number";

const positiveInt = z.number({ error: POSITIVE }).int(POSITIVE).positive(POSITIVE);

/**
 * A model id, and only an id: the one spelling of "which model runs this" in the
 * schema, shared by `settings.model`, a state's `model` and a rubric's. Never an
 * endpoint, credentials or sampling knobs — a declared id is resolved over the
 * endpoint and credentials the assembly is already configured with, so an object
 * value is refused with the sentence that says where those belong. The id itself
 * is opaque: only the endpoint can judge it, so a new model needs no release.
 */
const modelId = z
  .string({
    error:
      "must be a model id string (e.g. 'gpt-5-mini'). Only the id is declared here — the " +
      "endpoint, credentials and sampling (temperature, max tokens) are the assembly's " +
      "configuration (ARCHMAX_* or a host's modelFactory), not a workflow's.",
  })
  .refine((value) => value.trim() !== "", NON_EMPTY);

/** A run-variable name: snake_case, never dotted. */
const variableName = z
  .string({ error: (issue) => `'${String(issue.input)}' is not a valid run-variable name` })
  .regex(VARIABLE_NAME_PATTERN, {
    error: (issue) =>
      `'${String(issue.input)}' is not a valid run-variable name. Use lowercase letters, ` +
      `digits and underscores, starting with a letter (e.g. 'order_id').`,
  });

/** A skill slug: a bundle directory name, never a path or glob. */
const skillSlug = z
  .string({ error: (issue) => `is not a skill slug: ${JSON.stringify(issue.input)}` })
  .refine(isSlug, {
    error: (issue) =>
      `'${String(issue.input)}' is not a skill slug. Entries are bundle directory names in ` +
      `kebab-case (e.g. 'order-data') — never paths or globs; scope paths within an enabled ` +
      `skill with a 'tools.allow' entry instead.`,
  });

/**
 * A mount name: a key of the host's mount table with its slashes stripped
 * (`reference`, `catalogs/eu`, `AGENTS.md`) — the token a `mounts` list governs
 * by. Interior separators are kept, so a nested key is nameable; a glob, a
 * leading slash and a `..` segment are refused, because a mount list names
 * mounts and a path pattern is what `tools.allow` takes.
 */
const mountName = z
  .string({ error: (issue) => `is not a mount name: ${JSON.stringify(issue.input)}` })
  .refine((value) => isMountName(value), {
    error: (issue) =>
      `'${String(issue.input)}' is not a mount name. Entries are the keys of the workspace's ` +
      `mount table with their slashes stripped (e.g. 'reference' or 'catalogs/eu') — never ` +
      `globs, leading slashes or '..' segments; scope paths within an enabled mount with a ` +
      `'tools.allow' entry instead.`,
  });

/**
 * How a state may use a mount it is given: `read` refuses writes there,
 * `read_write` permits them where the host declared the mount writable.
 *
 * The host's `readOnly` posture is a **ceiling**, not a default to argue with: a
 * mount served read-only stays read-only wherever it appears, and `read_write`
 * on one is inert (reported by `validate`). What this key adds is the other
 * direction — narrowing a writable mount to reads in the states that only need
 * to read it — which is the direction every level of this schema may move.
 */
export const mountAccessSchema = z.enum(["read", "read_write"], {
  error: (issue) =>
    `unknown mount access '${String(issue.input)}' (expected 'read' or 'read_write')`,
});

/**
 * One entry of a mounts **grant** list: a bare mount name, taking the write
 * posture the host declared, or a mapping naming the access this level gives.
 * A `forbid` entry is a name only — a denial is total, so it has no access to
 * qualify.
 */
const MOUNT_GRANT_ENTRY =
  "must be a mount name, or '{ mount: <name>, access: read | read_write }' to name the access " +
  "this level gives";

export const mountGrantEntrySchema = z.union(
  [
    mountName,
    z
      .object({
        mount: mountName,
        access: mountAccessSchema.optional(),
      })
      .strict(),
  ],
  {
    error: (issue) => `${MOUNT_GRANT_ENTRY}; got ${JSON.stringify(issue.input)}`,
  },
);

const MOUNT_GRANT_LIST =
  "must be a list of mount names, each optionally as " +
  "'{ mount: <name>, access: read | read_write }'";

/** Whether a string is a well-formed mount name. */
function isMountName(value: string): boolean {
  if (value === "" || value !== value.trim()) return false;
  if (/[*?[\]{}]/.test(value)) return false;
  if (value.startsWith("/") || value.endsWith("/")) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** A dotted session path over the run's variables (`triggers.-1.conversationId`). */
const sessionPath = z
  .string({
    error:
      "must be a dotted path string (e.g. 'conversation_id' or 'triggers.-1.conversationId').",
  })
  .superRefine((value, ctx) => {
    const parsed = parseSessionPath(value);
    if (parsed.error) ctx.addIssue({ code: "custom", message: parsed.error });
  });

/**
 * @see SpecMetadata
 *
 * One loose, named slot for host data the runtime never reads (an authoring UI's
 * canvas state, a node's position) — rather than a `.catchall()`, which would
 * switch off the strictness this file exists for. Accepted at three positions:
 * the spec root, a state, and a rubric declaration.
 */
export const specMetadataSchema = z.looseObject({});

/**
 * @see RubricDeclaration
 *
 * A grading rubric: the standard a state's exit is measured against, declared
 * **inline on the hook that applies it**. `instructions` is the only required
 * key — the same word a state uses for the prose telling a model what to do.
 *
 * There is deliberately no name: a rubric is not a first-order item a hook
 * points at, it is part of the state's own declaration, so reading the state
 * tells you the whole standard without a lookup. The cost is duplication when
 * two states want the same grader, which is accepted: a state is legible on its
 * own, and nothing silently changes what one state grades against by editing
 * something elsewhere. There is no `title` either (nothing routes to a rubric)
 * and no `description`; a host label goes in `metadata`.
 */
export const rubricDeclarationSchema = z
  .object({
    instructions: nonEmptyString,
    max_iterations: z.number().int().min(0).optional(),
    model: modelId.optional(),
    metadata: specMetadataSchema.optional(),
  })
  .strict();

// --- Hooks ---------------------------------------------------------------------

/** Keys a hook may carry *alongside* its kind, which therefore never name one. */
const RESERVED_HOOK_KEYS = new Set(["max_iterations"]);

const HOOK_SCRIPT_PATH = /^hooks\/[^/].*\.(js|mjs)$/;

/**
 * Whether a hook script path stays inside the workflow's `hooks/` directory.
 * Checked by segment, not only by prefix: `hooks/../escape.js` satisfies a naive
 * "starts with hooks/" rule while resolving outside it.
 */
function isConfinedHookScript(path: string): boolean {
  return HOOK_SCRIPT_PATH.test(path) && !path.split("/").includes("..");
}

const hookScriptPath = z
  .string()
  .refine(
    isConfinedHookScript,
    "must be a workflow-relative path inside 'hooks/' ending in .js or .mjs, with " +
      "no '..' segment (e.g. 'hooks/check-requester.js'). Runtime scripts the agent " +
      "runs with archmax_run live in a skill bundle instead.",
  );

/**
 * The one wording for a hook that is not a usable tagged object.
 *
 * Deliberately free of per-key special cases: a retired spelling
 * (`subagent`, `max_corrections`) is reported as the unrecognized key it is, the
 * way a typo is, so the schema carries no memory of every name it ever had.
 */
function describeHookInput(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return "must be a { script } or { rubric } entry";
  }
  const record = input as Record<string, unknown>;
  const kinds = Object.keys(record).filter((key) => !RESERVED_HOOK_KEYS.has(key));
  if (kinds.length !== 1) {
    return "must be a single-key tagged object (plus an optional 'max_iterations' sidecar)";
  }
  return (
    "must be a hook: { script: 'hooks/<file>.js' }, { rubric: { instructions: … } }, or " +
    "{ <custom-kind>: '<target>' } for an executor registered at assembly"
  );
}

/**
 * One lifecycle hook. The built-in kinds are strict; the custom-kind branch (a
 * record of strings, for an executor registered at assembly) is fenced so it
 * cannot rescue a malformed built-in — `{ script: <bad path> }` must fail the
 * script branch and stay failed.
 */
export const hookSchema = z.union(
  [
    z
      .object({ script: hookScriptPath, max_iterations: z.number().int().min(0).optional() })
      .strict(),
    // A rubric hook carries the whole grader inline, so its budget is declared
    // inside the declaration rather than as a sidecar beside it: there is only
    // one place to put it, which is the point of inlining.
    z.object({ rubric: rubricDeclarationSchema }).strict(),
    z
      .record(z.string(), z.string())
      .refine(
        (value) =>
          !("script" in value) &&
          !("rubric" in value) &&
          Object.keys(value).filter((key) => !RESERVED_HOOK_KEYS.has(key)).length === 1,
        { error: (issue) => describeHookInput(issue.input) },
      ),
  ],
  { error: (issue) => describeHookInput(issue.input) },
);

/** @see HookSpec */
export const hookSpecSchema = z.union([hookSchema, z.array(hookSchema)], {
  error: (issue) =>
    Array.isArray(issue.input)
      ? "every entry must be a { script } or { rubric } entry"
      : describeHookInput(issue.input),
});

// --- States --------------------------------------------------------------------

/** @see TransitionType */
export const transitionTypeSchema = z.enum(["approve", "reject", "refine", "none"], {
  error: (issue) =>
    `unknown type '${String(issue.input)}' (expected approve|reject|refine|none)`,
});

/**
 * Why a `description` is required rather than advisory: the agent is disclosed
 * the active state's edges and nothing else of the graph, so this string is the
 * whole of what it knows about where an edge leads. A blank one hands it a bare
 * slug and asks it to route — an unnavigable graph, which is worse to warn about
 * than to refuse. One message covers missing, empty, blank and mistyped, and the
 * issue path (`states.<slug>.transitions.<index>.description`) names the edge.
 */
const TRANSITION_DESCRIPTION =
  `must be a non-empty string: it is the only thing the agent is told about this edge — no ` +
  `attribute of the target state is disclosed to it — so an undescribed edge cannot be chosen. ` +
  `Say when to take it (e.g. 'Refunds over $50'), not where it goes.`;

/** @see MachineTransition */
export const machineTransitionSchema = z
  .object({
    to: nonEmptyString,
    description: z
      .string({ error: TRANSITION_DESCRIPTION })
      .refine((value) => value.trim() !== "", TRANSITION_DESCRIPTION),
    type: transitionTypeSchema.optional(),
  })
  .strict();

/** @see StateBudget */
export const stateBudgetSchema = z
  .object({
    maxTurns: positiveInt.optional(),
    timeoutMs: positiveInt.optional(),
    maxParks: positiveInt.optional(),
  })
  .strict();

/** @see AllowEntry */
export const allowEntrySchema = z.union([
  z.string(),
  z
    .object({
      tool: z.string({ error: "must name a tool" }),
      args: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
      paths: z.union([z.string(), z.array(z.string())]).optional(),
      connection: z.string().optional(),
      // Free-form: records, for the host that authored the entry, where the tool
      // came from. Nothing in the SDK reads it.
      source: z.string().optional(),
    })
    .strict(),
]);

/**
 * @see ForbidEntry
 *
 * The same entry grammar as {@link allowEntrySchema} — one derivation, one
 * matcher, one guard validation — with one addition the deny side needs and the
 * grant side must not have: the tool may be `*`, meaning **every** tool. That is
 * how a path is denied across the board (`{ tool: "*", paths: [logs/**] }`),
 * where a wildcard can only ever close the surface further. A `*` in an `allow`
 * list is a document-level error (`refineSpec`): allow-only governance means an
 * author names what a state may do.
 */
export const forbidEntrySchema = allowEntrySchema;

/** The tool name that denies every tool. Accepted in a forbid entry only. */
export const FORBID_ANY_TOOL = "*";

/**
 * @see ToolsBlock — a **state's** tools block.
 *
 * `allow` adds to the workflow's `tools.allow_always`; `forbid` denies here,
 * beating every grant that would otherwise reach this state — the workflow's
 * always-on grant, this state's own `allow`, and the always-on surface alike.
 * Deny beats allow, and no narrower level widens a denial.
 */
export const toolsBlockSchema = z
  .object({
    allow: z.array(allowEntrySchema).optional(),
    forbid: z.array(forbidEntrySchema).optional(),
  })
  .strict();

/**
 * @see SkillsBlock — a **state's** skills block, and only a state's: the spec
 * root has its own shape ({@link workflowSkillsConfigSchema}), the way `tools`
 * already splits its two positions.
 *
 * `allow` is optional rather than defaulted because `skills:` is itself optional:
 * an absent list and `allow: []` mean the same thing — nothing this state adds —
 * so the default belongs where the set is resolved
 * (`WorkflowMachine.enabledSkills`), not in the parse, where a whole absent block
 * would slip past it anyway.
 */
export const skillsBlockSchema = z
  .object({
    allow: z.array(skillSlug, { error: "must be a list of skill slugs" }).optional(),
    forbid: z.array(skillSlug, { error: "must be a list of skill slugs" }).optional(),
  })
  .strict();

/**
 * @see MountsBlock — a **state's** mounts block, and only a state's: the spec
 * root has its own shape ({@link workflowMountsConfigSchema}), the way `tools`
 * and `skills` already split their two positions.
 *
 * The block governs the mount names the **host** declared governed
 * (`MountSpec.governed`); an ungoverned mount is visible in every state without
 * a grant, and `forbid` is what subtracts it. Precedence is the one rule every
 * capability here follows: `allow` adds to the root's `allow_always`, and a
 * denial from either level beats every grant.
 *
 * `allow` is optional rather than defaulted for the same reason `skills.allow`
 * is: an absent list and `allow: []` both add nothing, so the default belongs
 * where the set is resolved (`WorkflowMachine.enabledMounts`).
 */
export const mountsBlockSchema = z
  .object({
    allow: z.array(mountGrantEntrySchema, { error: MOUNT_GRANT_LIST }).optional(),
    forbid: z.array(mountName, { error: "must be a list of mount names" }).optional(),
  })
  .strict();

/** @see StateType */
export const stateTypeSchema = z.enum(["agent", "human"], {
  error: (issue) => `unknown state type '${String(issue.input)}' (expected 'agent' or 'human')`,
});

// --- Triggers ------------------------------------------------------------------

/** One half of a trigger's signature: a list of distinct run-variable names. */
function signatureSchema(key: "requires" | "returns") {
  return z
    .array(variableName, {
      error:
        `must be a list of run-variable names (e.g. '${key}: [order_id]'). A signature names ` +
        `the contract only — what a variable holds belongs in the state instructions that set it.`,
    })
    .superRefine((names, ctx) => {
      const seen = new Set<string>();
      names.forEach((name, index) => {
        if (seen.has(name)) {
          ctx.addIssue({ code: "custom", path: [index], message: `'${name}' is listed more than once.` });
        }
        seen.add(name);
        // Two reserved names, refused as returns for opposite reasons — one the
        // runtime always sets, one that must not cross a sub-run boundary upward.
        if (key === "returns" && name === TRIGGER_VARIABLE) {
          ctx.addIssue({
            code: "custom",
            path: [index],
            message:
              `'${name}' is the built-in trigger variable, set by the harness and locked, so a ` +
              `run cannot declare it as something it produces.`,
          });
        }
        if (key === "returns" && name === TITLE_VARIABLE) {
          ctx.addIssue({
            code: "custom",
            path: [index],
            message:
              `'${name}' is the built-in title variable, naming the task a run is doing. A ` +
              `sub-run's title describes the sub-run, so returning it would silently rename the ` +
              `task of whoever called it.`,
          });
        }
      });
    });
}

/**
 * The two keys a declaration refuses rather than preserves. Every other key a
 * host writes rides along untouched, but these two would be *wiring*: an `entry`
 * naming another state, a `name` naming another id. A loose object would keep
 * them, warn once, and start the run somewhere else — so each is an error
 * naming the one spelling that is left.
 */
const REFUSED_TRIGGER_KEYS: Record<string, string> = {
  entry:
    `declares 'entry'. The state a trigger's declaration sits on IS its entry state, so there ` +
    `is nothing left to name: move the declaration under the 'triggers:' of the state the ` +
    `trigger enters, and drop the key.`,
  name:
    `declares 'name'. The key a declaration sits under IS the trigger id, so a 'name' would be ` +
    `a second one: rename the key instead, and drop it.`,
};

/**
 * @see TriggerDeclaration
 *
 * Loose, not strict: a declaration is host-extensible — it may carry keys the
 * SDK preserves without acting on, and `lint-spec.ts` warns about them. The two
 * in {@link REFUSED_TRIGGER_KEYS} are errors instead.
 */
export const triggerDeclarationSchema = z
  .looseObject({
    session: sessionPath.optional(),
    message: z
      .union([z.literal(false), sessionPath], {
        error:
          "must be a dotted path string (e.g. 'triggers.-1.text'), or false when firings carry no message.",
      })
      .optional(),
    connection: z
      .string({
        error: "must be a non-empty string naming an access connection in the host's environment.",
      })
      .refine(
        (value) => value.trim() !== "",
        "must be a non-empty string naming an access connection in the host's environment.",
      )
      .optional(),
    requires: signatureSchema("requires").optional(),
    returns: signatureSchema("returns").optional(),
  })
  .check((ctx) => {
    for (const [key, message] of Object.entries(REFUSED_TRIGGER_KEYS)) {
      if (!Object.hasOwn(ctx.value, key)) continue;
      ctx.issues.push({ code: "custom", message, path: [key], input: ctx.value });
    }
  });

/**
 * A state's `triggers:` — the one place a trigger is declared. The key is the
 * trigger id, the state the mapping sits on is that trigger's entry state, and
 * the value is the declaration. A `null` value (`manual:` with nothing under
 * it) declares the id and nothing more.
 */
export const stateTriggersSchema = z.record(nonEmptyString, triggerDeclarationSchema.nullable(), {
  error:
    `must be a mapping of trigger id to its declaration (e.g. 'triggers: { ${MANUAL_TRIGGER}: }', ` +
    `or an id with a 'session' path under it).`,
});

/** @see MachineState */
export const machineStateSchema = z
  .object({
    type: stateTypeSchema.optional(),
    title: nonEmptyString.optional(),
    instructions: z.string().optional(),
    summary: z.string().optional(),
    evidence: z.array(z.string()).optional(),
    approvers: z.array(z.string()).optional(),
    triggers: stateTriggersSchema.optional(),
    before: hookSpecSchema.optional(),
    after: hookSpecSchema.optional(),
    budget: stateBudgetSchema.optional(),
    model: modelId.optional(),
    on_error: nonEmptyString.optional(),
    tools: toolsBlockSchema.optional(),
    skills: skillsBlockSchema.optional(),
    mounts: mountsBlockSchema.optional(),
    requires: z.array(variableName, { error: "must be a list of run-variable names" }).optional(),
    metadata: specMetadataSchema.optional(),
    transitions: z.array(machineTransitionSchema).optional(),
  })
  .strict();

/**
 * A state as authored: the mapping above, or `null` for a bare `done:` terminal
 * state. Preprocessed rather than unioned with `z.null()`, so a strict-key
 * failure keeps its own message instead of a union's "Invalid input".
 */
const authoredStateSchema = z.preprocess((value) => value ?? {}, machineStateSchema);

// --- Root blocks ---------------------------------------------------------------

/** @see WorkflowToolsConfig */
/**
 * @see WorkflowToolsConfig — the spec root's tools block.
 *
 * `allow_always` is granted in every state; `forbid_always` is denied in every
 * state and is **absolute** — no state grant, argument guard or consumer rule
 * reaches past it, and a sub-workflow inherits it from every ancestor. The
 * superseded `policy` block denies alongside it: denials union, because a denial
 * can only ever close a surface further.
 */
export const workflowToolsConfigSchema = z
  .object({
    allow_always: z.array(allowEntrySchema).optional(),
    forbid_always: z.array(forbidEntrySchema).optional(),
  })
  .strict();

/**
 * @see WorkflowSkillsConfig — the spec root's skills block.
 *
 * `allow_always` lists the slugs enabled in **every** state; a state's
 * `skills.allow` adds to it, exactly as `tools.allow` adds to
 * `tools.allow_always`. `forbid_always` denies its slugs in every state and
 * beats every grant, the way `tools.forbid_always` does. There is one model:
 * the ceiling `allow` this key used to accept is retired, so a root `allow` is
 * an unrecognized key.
 */
export const workflowSkillsConfigSchema = z
  .object({
    allow_always: z.array(skillSlug, { error: "must be a list of skill slugs" }).optional(),
    forbid_always: z.array(skillSlug, { error: "must be a list of skill slugs" }).optional(),
  })
  .strict();

/**
 * @see WorkflowMountsConfig — the spec root's mounts block.
 *
 * `allow_always` lists the governed mounts enabled in **every** state; a state's
 * `mounts.allow` adds to it, exactly as `skills.allow` adds to
 * `skills.allow_always`. `forbid_always` denies its names in every state —
 * governed or not — and beats every grant, and binds every descendant session.
 * There is one model: a root `allow` is an unrecognized key.
 */
export const workflowMountsConfigSchema = z
  .object({
    allow_always: z.array(mountGrantEntrySchema, { error: MOUNT_GRANT_LIST }).optional(),
    forbid_always: z.array(mountName, { error: "must be a list of mount names" }).optional(),
  })
  .strict();

/** @see MachinePromptCacheSettings */
export const machinePromptCacheSettingsSchema = z
  .object({ enabled: z.boolean().optional(), ttl: z.string().optional() })
  .strict();

/** @see MachineSettings — delegation bounds are the dispatcher's configuration, not settings here. */
export const machineSettingsSchema = z
  .object({
    model: modelId.optional(),
    timeoutMs: z.number().int().positive().optional(),
    memoryLimitBytes: z.number().int().positive().optional(),
    maxPtcCalls: z.number().int().min(0).nullable().optional(),
    maxResultChars: z.number().int().positive().optional(),
    prompt_cache: machinePromptCacheSettingsSchema.optional(),
  })
  .strict();

/** @see WorkflowTestsConfig */
export const workflowTestsConfigSchema = z
  .object({
    maxConcurrency: z.number().int().positive().optional(),
    caseTimeoutMs: z.number().int().positive().optional(),
    judge: z
      .object({
        model: z.string().optional(),
        /** Grader model construction options, applied over the environment's. */
        modelOptions: z
          .object({
            temperature: z.number().min(0).optional(),
            maxTokens: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** @see RuntimeMetadata */
export const runtimeMetadataSchema = z
  .object({
    engine: z.string().optional(),
    version: z.union([z.string(), z.number()]).optional(),
  })
  .strict();

/** @see SpecExtensions */
export const specExtensionsSchema = z
  .object({ hooks: z.array(z.string()).optional() })
  .strict();

/** The whole of `workflow.yaml`. @see MachineSpec */
export const machineSpecSchema = z
  .object({
    title: z.string().optional(),
    instructions: nonEmptyString.optional(),
    disabled: z
      .boolean({
        error: (issue) =>
          `Machine spec 'disabled' must be a boolean (true or false); got ` +
          `${JSON.stringify(issue.input)}, which the runtime reads fail-closed as disabled — so ` +
          `this workflow starts no runs. Write 'disabled: true' to mean it, or remove the key.`,
      })
      .optional(),
    runtime: runtimeMetadataSchema.optional(),
    settings: machineSettingsSchema.optional(),
    tools: workflowToolsConfigSchema.optional(),
    skills: workflowSkillsConfigSchema.optional(),
    mounts: workflowMountsConfigSchema.optional(),
    tests: workflowTestsConfigSchema.optional(),
    extensions: specExtensionsSchema.optional(),
    metadata: specMetadataSchema.optional(),
    states: z.record(z.string(), authoredStateSchema, {
      error: "Machine spec is missing or has empty 'states'",
    }),
  })
  .strict();

type Spec = z.infer<typeof machineSpecSchema>;

// --- Cross-references inside the document -------------------------------------

/**
 * A structural problem, addressed by its key path (dotted, with array indices:
 * `states.review.transitions.0.to`) so a diagnostic names the key an author has
 * to find.
 */
export interface SpecSchemaIssue {
  path: string;
  message: string;
}

/**
 * The rules that need the whole document and that the runtime cannot run
 * without: every reference resolves, the start wiring is unambiguous, guards
 * reference variables by a readable name. Runs after the shape has been
 * accepted. Defects the runtime tolerates are `lint-spec.ts` errors instead.
 */
export function refineSpec(spec: Spec): SpecSchemaIssue[] {
  const issues: SpecSchemaIssue[] = [];
  const issue = (path: string, message: string) => issues.push({ path, message });

  const states = spec.states;
  if (Object.keys(states).length === 0) {
    issue("states", "Machine spec is missing or has empty 'states'");
    return issues;
  }

  for (const [slug, state] of Object.entries(states)) {
    const at = `states.${slug}`;
    const transitions = state.transitions ?? [];

    transitions.forEach((transition, index) => {
      if (!(transition.to in states)) {
        issue(
          `${at}.transitions.${index}.to`,
          `State '${slug}' transitions to undefined state '${transition.to}'`,
        );
      }
    });
    if (state.on_error !== undefined && !(state.on_error in states)) {
      issue(`${at}.on_error`, `State '${slug}' on_error routes to undefined state '${state.on_error}'`);
    }

    // Before hooks gate entry with ok/veto only — there is no retry loop for an
    // iteration budget to bound, so the sidecar would enforce nothing.
    if (normalizeHooks(state.before).some((hook) => "max_iterations" in hook)) {
      issue(
        `${at}.before`,
        `State '${slug}' 'before' hook declares 'max_iterations', but before hooks are ok/veto ` +
          `only ('correct' is treated as a veto); the budget applies to 'after' hooks`,
      );
    }

    for (const [index, entry] of (state.tools?.allow ?? []).entries()) {
      for (const message of guardReferenceIssues(`State '${slug}'`, entry)) {
        issue(`${at}.tools.allow.${index}`, message);
      }
      if (wildcardTool(entry)) issue(`${at}.tools.allow.${index}`, WILDCARD_GRANT_MESSAGE);
    }
    for (const [index, entry] of (state.tools?.forbid ?? []).entries()) {
      for (const message of guardReferenceIssues(`State '${slug}'`, entry)) {
        issue(`${at}.tools.forbid.${index}`, message);
      }
    }
  }

  for (const [index, entry] of (spec.tools?.allow_always ?? []).entries()) {
    for (const message of guardReferenceIssues("tools.allow_always", entry)) {
      issue(`tools.allow_always.${index}`, message);
    }
    if (wildcardTool(entry)) issue(`tools.allow_always.${index}`, WILDCARD_GRANT_MESSAGE);
  }

  for (const [index, entry] of (spec.tools?.forbid_always ?? []).entries()) {
    for (const message of guardReferenceIssues("tools.forbid_always", entry)) {
      issue(`tools.forbid_always.${index}`, message);
    }
  }

  // Start wiring: at least one start state, and no trigger claimed by two
  // states. A trigger is declared in one place now, so the only ambiguity left
  // is two states declaring one id — a mapping cannot repeat a key.
  const owners = new Map<string, string[]>();
  for (const [slug, state] of Object.entries(states)) {
    for (const id of stateTriggerIds(state)) {
      owners.set(id, [...(owners.get(id) ?? []), slug]);
    }
  }
  for (const [id, states] of owners) {
    if (states.length < 2) continue;
    issue(
      "states",
      id === MANUAL_TRIGGER
        ? `Multiple states declare trigger '${id}' (${states.join(", ")}); a manual start state must be unambiguous`
        : `Multiple states declare trigger '${id}' (${states.join(", ")}); a tool trigger must name a unique start state`,
    );
  }
  if (owners.size === 0) {
    issue(
      "states",
      "Workflow has no start state; declare a `triggers` mapping on at least one state (e.g. `triggers: { manual: }`)",
    );
  }

  // Case concurrency is not implemented; a value above 1 would silently run
  // sequentially, so it is rejected here and by the test runner alike.
  if ((spec.tests?.maxConcurrency ?? 1) > 1) {
    issue(
      "tests.maxConcurrency",
      `'tests.maxConcurrency' above 1 is not supported: case concurrency is not implemented ` +
        `and offline cases run sequentially — set it to 1 or remove the field`,
    );
  }

  return issues;
}

/** Whether an entry names the every-tool wildcard, which only a denial may. */
function wildcardTool(entry: z.infer<typeof allowEntrySchema>): boolean {
  return typeof entry === "string" ? entry === FORBID_ANY_TOOL : entry?.tool === FORBID_ANY_TOOL;
}

/**
 * The one wording for a wildcard where a grant belongs. Governance is
 * allow-only: a state names what it may do, so `*` would be the one entry that
 * says "anything" — while on the deny side it can only close the surface
 * further, which is why `forbid` accepts it.
 */
const WILDCARD_GRANT_MESSAGE =
  `'${FORBID_ANY_TOOL}' is not a tool name a grant may use: an allow list names the tools a ` +
  `state may call, one by one. The every-tool wildcard belongs in a 'forbid' or 'forbid_always' ` +
  `entry, where it can only deny.`;

/** Malformed `${{…}}` references in one allow entry's argument guards. */
function guardReferenceIssues(where: string, entry: z.infer<typeof allowEntrySchema>): string[] {
  const { tool, argMatchers } = normalizeAllowEntry(entry);
  if (!argMatchers) return [];
  const messages: string[] = [];
  for (const globs of Object.values(argMatchers)) {
    for (const glob of globs) {
      for (const ref of parseReferences(glob)) {
        if (!referenceError(ref)) continue;
        messages.push(
          `${where} guards '${tool ?? "?"}' on '${ref.raw}', which is not a valid variable ` +
            `reference — use \${{name}} or \${{name.path.to.value}}.`,
        );
      }
    }
  }
  return messages;
}

// --- Entry point ---------------------------------------------------------------

/** Render a Zod issue path the way an author addresses the key. */
function formatPath(path: readonly PropertyKey[]): string {
  return path.map(String).join(".");
}

/**
 * Parse a spec through the schema, then the document-level rules, returning
 * either the typed value or the structural issues. Total rather than throwing:
 * the loader reports issues as warning events, the validator as diagnostics.
 * When the shape held but a document-level rule failed, the typed `spec` is
 * returned beside the issues so the lint can still read it.
 */
export function parseMachineSpec(
  value: unknown,
): { ok: true; spec: Spec } | { ok: false; issues: SpecSchemaIssue[]; spec?: Spec } {
  const result = machineSpecSchema.safeParse(value);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((issue) => ({
        path: formatPath(issue.path),
        message: issue.message,
      })),
    };
  }
  const issues = refineSpec(result.data);
  return issues.length > 0
    ? { ok: false, issues, spec: result.data }
    : { ok: true, spec: result.data };
}

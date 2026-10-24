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
import { isSlug } from "./slug.js";
import { SIGNATURE_TYPES } from "./signature.js";
import { MANUAL_TRIGGER, parseSessionPath, stateTriggerIds } from "./triggers.js";
import {
  parseReferences,
  referenceError,
  TITLE_VARIABLE,
  TRIGGER_VARIABLE,
  VARIABLE_NAME_PATTERN,
} from "./variables.js";

/**
 * The return a sub-workflow's caller finds when the sub-run left some of its
 * `returns` unset (`RETURNS_NOTE_VARIABLE` in the runtime), so no trigger may
 * declare it. Spelled here too because the schema must stay free of runtime imports.
 */
const RETURNS_NOTE_NAME = "note";

// --- Shared scalars ------------------------------------------------------------

const NON_EMPTY = "must be a non-empty string";

const nonEmptyString = z
  .string({ error: NON_EMPTY })
  .refine((value) => value.trim() !== "", NON_EMPTY);

const POSITIVE = "must be a positive number";

const positiveInt = z.number({ error: POSITIVE }).int(POSITIVE).positive(POSITIVE);

/**
 * A model id, and only an id: the one spelling of "which model runs this" in the
 * schema, shared by `settings.model` and a state's `model`. Never an
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
 * switch off the strictness this file exists for. Accepted at two positions:
 * the spec root and a state.
 */
export const specMetadataSchema = z.looseObject({});

// --- Code-state scripts ---------------------------------------------------------

const CODE_SCRIPT_PATH = /^scripts\/[^/].*\.(js|mjs)$/;

/**
 * Whether a code state's script path stays inside the workflow's `scripts/`
 * directory. Checked by segment, not only by prefix: `scripts/../escape.js`
 * satisfies a naive "starts with scripts/" rule while resolving outside it.
 */
function isConfinedCodeScript(path: string): boolean {
  return CODE_SCRIPT_PATH.test(path) && !path.split("/").includes("..");
}

/** @see MachineState.script — the file a code state runs. */
export const codeScriptPathSchema = z
  .string({ error: "must be a workflow-relative path string (e.g. 'scripts/check-refund.js')" })
  .refine(
    isConfinedCodeScript,
    "must be a workflow-relative path inside 'scripts/' ending in .js or .mjs, with no '..' " +
      "segment (e.g. 'scripts/check-refund.js'). Scripts the agent runs with archmax_run live in " +
      "a skill bundle instead.",
  );

// --- States --------------------------------------------------------------------

/** @see TransitionType */
export const transitionTypeSchema = z.enum(["approve", "reject", "refine", "none"], {
  error: (issue) =>
    `unknown type '${String(issue.input)}' (expected approve|reject|refine|none)`,
});

/**
 * The agent is disclosed the active state's edges and nothing else of the graph,
 * so an edge must give it something to route on: its `description`, or — for an
 * **undescribed** edge (absent, empty or blank) — the target state's own
 * `instructions`, which the edge then discloses in its place. An edge with
 * neither hands the agent a bare slug and asks it to route: an unnavigable graph,
 * which is worse to warn about than to refuse, so {@link refineSpec} refuses it.
 * It refuses an undescribed transition of a human state, where the description
 * is the person's button label, and an undescribed edge into a grader or a code
 * state: a grader's instructions are its criteria, which the work it judges is
 * never shown, and a code state has none. A code state's own edges are exempt —
 * its script routes, and nothing reads their descriptions. A non-string is a
 * typo and refused here. The issue path
 * (`states.<slug>.transitions.<index>.description`) names the edge.
 */
const TRANSITION_DESCRIPTION =
  `must be a string: what the agent routes on when it considers this edge. Say when to take it ` +
  `(e.g. 'Refunds over $50'), not where it goes — or omit it to route on the target state's ` +
  `instructions instead.`;

/** An undescribed edge whose target has no instructions: nothing to route on. */
function undescribedEdgeMessage(target: string): string {
  return (
    `must be a non-empty string here: the agent routes on an edge's description, or, when it has ` +
    `none, on the target state's instructions — and '${target}' declares none. Say when to take ` +
    `this edge (e.g. 'Refunds over $50'), or give '${target}' instructions.`
  );
}

/** An undescribed edge into an automated state: there are no instructions the agent may be shown. */
function undescribedAutomatedEdgeMessage(target: string, type: "grader" | "code"): string {
  const why =
    type === "grader"
      ? `'${target}' is a grader, whose instructions are its criteria and never shown to the work it judges`
      : `'${target}' is a code state, which has none`;
  return (
    `must be a non-empty string here: the agent routes on an edge's description, or, when it has ` +
    `none, on the target state's instructions — and ${why}. Say when to take this edge ` +
    `(e.g. 'The reply is drafted').`
  );
}

/** An undescribed transition on a human state: the decision's button has no label. */
const HUMAN_TRANSITION_DESCRIPTION =
  `must be a non-empty string on a human state's transition: it is the label of the decision's ` +
  `button for the person deciding, and a target's instructions do not tell them what choosing it ` +
  `means. Say what the choice is (e.g. 'Approve the refund').`;

/** @see MachineTransition */
export const machineTransitionSchema = z
  .object({
    to: nonEmptyString,
    description: z.string({ error: TRANSITION_DESCRIPTION }).optional(),
    type: transitionTypeSchema.optional(),
  })
  .strict();

/** Whether an edge carries no description the agent could route on: absent, empty or blank. */
export function isUndescribed(transition: { description?: string }): boolean {
  return !transition.description?.trim();
}

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
 * `allow` adds to the workflow-wide grant (the declared `tools.allow_always`, or
 * the default tools when it is absent) and narrows a tool that grant names;
 * `forbid` denies here, beating every grant that would otherwise reach this
 * state — the workflow-wide grant, this state's own `allow`, and the host's
 * `essentialTools` alike.
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
export const stateTypeSchema = z.enum(["agent", "human", "grader", "code"], {
  error: (issue) =>
    `unknown state type '${String(issue.input)}' (expected 'agent', 'human', 'grader' or 'code')`,
});

// --- Triggers ------------------------------------------------------------------

/** The keys a signature entry object may carry, as a refusal lists them. */
const SIGNATURE_ENTRY_KEYS = "'name', 'type' and 'description'";

/** The accepted type words, as a refusal lists them. */
const SIGNATURE_TYPE_LIST = `${SIGNATURE_TYPES.slice(0, -1).join(", ")} or ${SIGNATURE_TYPES.at(-1)}`;

/**
 * @see SignatureEntryDeclaration
 *
 * The object spelling of a signature entry. Strict, unlike the loose declaration
 * around it: an unknown key here is most likely a misspelled `type` or
 * `description`, and read loosely it would silently mean "untyped".
 */
export const signatureEntryObjectSchema = z.strictObject(
  {
    name: z
      .string({
        error:
          "a signature entry needs a 'name' naming its variable (e.g. '{ name: order_id, type: string }')",
      })
      .regex(VARIABLE_NAME_PATTERN, {
        error: (issue) =>
          `'${String(issue.input)}' is not a valid run-variable name. Use lowercase letters, ` +
          `digits and underscores, starting with a letter (e.g. 'order_id').`,
      }),
    type: z
      .enum(SIGNATURE_TYPES, {
        error: (issue) => `'type' must be one of ${SIGNATURE_TYPE_LIST}; got ${JSON.stringify(issue.input)}`,
      })
      .optional(),
    description: z
      .string({ error: `'description' ${NON_EMPTY}` })
      .refine((value) => value.trim() !== "", `'description' ${NON_EMPTY}`)
      .optional(),
  },
  {
    error: (issue) =>
      issue.code === "unrecognized_keys"
        ? `${entryLabel(issue.input)} declares ${issue.keys.map((k) => `'${k}'`).join(", ")}, which a ` +
          `signature entry does not take: it has ${SIGNATURE_ENTRY_KEYS} only.`
        : undefined,
  },
);

/** An entry as a message names it: by its `name` when it has a readable one. */
function entryLabel(input: unknown): string {
  const name = (input as { name?: unknown } | null)?.name;
  return typeof name === "string" && name !== "" ? `Entry '${name}'` : "The entry";
}

/**
 * @see SignatureEntryDeclaration
 *
 * One signature entry: a bare run-variable name (untyped), or the object
 * spelling. A failure is reported in the terms of the spelling the author used,
 * so a mistyped bare name reads exactly as it did before objects were accepted.
 */
export const signatureEntrySchema = z.union([variableName, signatureEntryObjectSchema], {
  error: (issue) => {
    if (issue.code !== "invalid_union") return undefined;
    const input = issue.input;
    const isObject = input !== null && typeof input === "object" && !Array.isArray(input);
    const branch = issue.errors[isObject ? 1 : 0] ?? [];
    const messages = branch.map((inner) => inner.message);
    if (!isObject) return messages[0] ?? `'${String(input)}' is not a valid run-variable name`;
    return `${entryLabel(input)}: ${messages.join("; ")}`;
  },
});

/**
 * One half of a trigger's signature: a list of entries with distinct names —
 * each a bare name or `{ name, type?, description? }`, distinct by name across
 * both spellings.
 */
function signatureSchema(key: "requires" | "returns") {
  return z
    .array(signatureEntrySchema, {
      error:
        `must be a list of run-variable names, each a bare name or '{ name, type?, description? }' ` +
        `(e.g. '${key}: [order_id, { name: due, type: date }]').`,
    })
    .superRefine((entries, ctx) => {
      const seen = new Set<string>();
      entries.forEach((entry, index) => {
        const name = typeof entry === "string" ? entry : entry.name;
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
        if (key === "returns" && name === RETURNS_NOTE_NAME) {
          ctx.addIssue({
            code: "custom",
            path: [index],
            message:
              `'${name}' is reserved in 'returns': a sub-run that finishes without setting all of ` +
              `its returns hands its caller a '${name}' naming the ones it left unset.`,
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
    // For whoever calls the entry — a delegating model, a host's MCP client, a
    // form's reader. The session's own brief is its `instructions`; this never reaches it.
    description: z
      .string({ error: "must be a non-empty string saying, for a caller, what calling this entry does." })
      .refine(
        (value) => value.trim() !== "",
        "must be a non-empty string saying, for a caller, what calling this entry does.",
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
    script: codeScriptPathSchema.optional(),
    budget: stateBudgetSchema.optional(),
    model: modelId.optional(),
    on_error: nonEmptyString.optional(),
    tools: toolsBlockSchema.optional(),
    skills: skillsBlockSchema.optional(),
    mounts: mountsBlockSchema.optional(),
    requires: z.array(variableName, { error: "must be a list of run-variable names" }).optional(),
    /** Variables this state owns: only it may write them, on any visit. */
    locks: z.array(variableName, { error: "must be a list of run-variable names" }).optional(),
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
 * `allow_always` is granted in every state, and declared (an empty list
 * included) it *replaces* the default tools an absent one grants;
 * `forbid_always` is denied in every
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
/**
 * What `locks` may not say: a variable owned twice (ownership never moves), a
 * reserved name (`trigger` refuses every write, `title` is never locked), the
 * same name twice, or any name on a human state, which makes no tool calls.
 */
function lockIssues(states: Spec["states"]): SpecSchemaIssue[] {
  const issues: SpecSchemaIssue[] = [];
  const owners = new Map<string, string[]>();
  for (const [slug, state] of Object.entries(states)) {
    const locks = state?.locks;
    if (!locks) continue;
    const at = `states.${slug}.locks`;
    if (state.type === "human") {
      issues.push({ path: at, message: `State '${slug}' is a human state, which makes no tool calls, so it cannot own variables` });
    }
    locks.forEach((name, index) => {
      if (name === TRIGGER_VARIABLE || name === TITLE_VARIABLE) {
        issues.push({ path: `${at}.${index}`, message: `State '${slug}' cannot own the reserved variable '${name}'` });
      } else if (locks.indexOf(name) !== index) {
        issues.push({ path: `${at}.${index}`, message: `State '${slug}' lists '${name}' in 'locks' twice` });
      }
      if (locks.indexOf(name) === index) owners.set(name, [...(owners.get(name) ?? []), slug]);
    });
  }
  for (const [name, slugs] of owners) {
    if (slugs.length > 1) {
      issues.push({
        path: `states.${slugs[1]}.locks`,
        message: `Variable '${name}' is owned by more than one state (${slugs.map((s) => `'${s}'`).join(", ")}); a variable has one owner`,
      });
    }
  }
  return issues;
}

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
        return;
      }
      // A code state's script routes: nothing reads its edges' descriptions.
      if (!isUndescribed(transition) || state.type === "code") return;
      const target = states[transition.to];
      if (state.type === "human") {
        issue(`${at}.transitions.${index}.description`, HUMAN_TRANSITION_DESCRIPTION);
      } else if (target?.type === "grader" || target?.type === "code") {
        issue(`${at}.transitions.${index}.description`, undescribedAutomatedEdgeMessage(transition.to, target.type));
      } else if (!target?.instructions?.trim()) {
        issue(`${at}.transitions.${index}.description`, undescribedEdgeMessage(transition.to));
      }
    });
    if (state.on_error !== undefined && !(state.on_error in states)) {
      issue(`${at}.on_error`, `State '${slug}' on_error routes to undefined state '${state.on_error}'`);
    }

    // A code state *is* its script: without one there is nothing to run, and a
    // script anywhere else would be read by nothing.
    if (state.type === "code" && state.script === undefined) {
      issue(
        `${at}.script`,
        `Code state '${slug}' declares no 'script': a code state runs the file it names ` +
          `(e.g. 'script: scripts/${slug}.js'), and without one it has nothing to run.`,
      );
    }
    if (state.type !== "code" && state.script !== undefined) {
      issue(
        `${at}.script`,
        `State '${slug}' declares 'script', which only a code state runs; this state is ` +
          `type '${state.type ?? "agent"}'. Declare 'type: code' to run the script, or drop the key.`,
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

  for (const message of lockIssues(states)) issue(message.path, message.message);

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

/**
 * Findings about one `workflow.yaml` that do not stop it loading: warnings about
 * things that run but almost certainly do not do what the author meant, and
 * **errors** the runtime tolerates but `archmax validate` fails on (a human state
 * that cannot present the decision it declares, a key a state's type never
 * reads, a grader with nothing to decide between). Pure over the parsed spec — no
 * workspace, no registry — so the loader and the validator report the same
 * findings. What the runtime cannot run without lives in `spec-schema.ts`.
 */
import { classifyWorkspacePath, SESSION_OPEN_DIR } from "../core/zones.js";
import type { Diagnostic } from "./diagnostic.js";
import { guardReferences, normalizeAllowEntry } from "./allow.js";
import { normalizeMountGrants } from "./mount-grants.js";
import { triggerDeclarationSchema } from "./spec-schema.js";
import { ADVANCE_TOOL, DEFAULT_TOOLS, STATE_TYPE_TOOLS } from "./tool-names.js";
import { BUILT_IN_TOOL_PATHS, MUTATING_ACCESSES, SCRATCHPAD_ACCESSES } from "./tool-paths.js";
import { normalizeSignature } from "./signature.js";
import { declaredVariableNames } from "./triggers.js";
import type { AllowEntry, MachineSpec } from "./types.js";
import { TRIGGER_VARIABLE } from "./variables.js";

/** The block keys the SDK defines; anything else on a declaration is the host's. */
const TRIGGER_KEYS = new Set(Object.keys(triggerDeclarationSchema.shape));

const LABELED_TRANSITION_TYPES = ["approve", "reject", "refine"] as const;

/**
 * The tool and paths of an allow entry that narrows a mutating built-in to paths
 * inside the always-open working area alone, or `null` for any other entry. Such
 * an entry narrows nothing there: `tool.scratchpad` keeps the area open to the
 * tool wherever it is granted, before the entry is consulted.
 */
function scratchpadOnlyNarrowing(entry: AllowEntry): { tool: string; paths: string[] } | null {
  const normalized = normalizeAllowEntry(entry);
  const { tool, argMatchers } = normalized;
  if (!tool || !argMatchers) return null;
  // A built-in that mutates, every path of which the scratchpad keeps open.
  const declared = Object.entries(BUILT_IN_TOOL_PATHS[tool] ?? {});
  const mutates = declared.some(([, access]) => MUTATING_ACCESSES.has(access));
  if (!mutates || !declared.every(([, access]) => SCRATCHPAD_ACCESSES.has(access))) return null;
  const paths = normalized.fromPaths
    ? (argMatchers.file_path ?? [])
    : declared.flatMap(([arg]) => argMatchers[arg] ?? []);
  if (paths.length === 0 || !paths.every((path) => classifyWorkspacePath(path) === "run-open")) return null;
  return { tool, paths };
}

/** Why a code state reads none of these keys, as the error says it. */
const CODE_STATE_UNREAD: Record<string, string> = {
  instructions:
    "a code state runs its script and makes no model call, so nothing reads them — say what the " +
    "script does in its docblock, or in 'summary'",
  model: "a code state makes no model call",
  budget:
    "a code state makes no model call and cannot park; its script is bounded by " +
    "'settings.timeoutMs'",
  evidence: "evidence belongs to a human state's decision record",
  approvers: "approvers belong to a human state's decision record",
};

/** Findings for a spec the schema has accepted. `file` is left to the caller. */
export function lintSpec(spec: MachineSpec): Diagnostic[] {
  const out: Diagnostic[] = [];
  const warn = (field: string, message: string) => out.push({ severity: "warning", message, field });
  const error = (field: string, message: string) => out.push({ severity: "error", message, field });

  if (spec.instructions === undefined) {
    warn(
      "instructions",
      `No top-level 'instructions', so the workflow ships no standing guidance in the system ` +
        `prompt — conventions, house rules, and what "done" means have to be repeated in every ` +
        `state's 'instructions' instead. Add an 'instructions' block for direction that holds ` +
        `across the whole run.`,
    );
  }

  // Validation is the one surface that stays fully functional for a disabled
  // workflow, so it has to say plainly that runs will be refused.
  if (spec.disabled === true) {
    warn(
      "disabled",
      `This workflow is disabled ('disabled: true'), so it starts no new turns: 'archmax run' ` +
        `refuses, a trigger firing is rejected, and a caller's delegation call is refused. ` +
        `Sessions already underway can still be decided, replied to and delivered to, and ` +
        `'archmax test' skips its cases. Remove the key to re-enable it.`,
    );
  }

  // A declared `tools.allow_always` replaces the default tools rather than adding
  // to them. One that names none of them — nor does any state's `tools.allow` —
  // leaves an agent that cannot read a file, an offloaded tool result included:
  // most often a workflow written as `allow_always: []` when the defaults were
  // still implicit.
  const declaredAlways = spec.tools?.allow_always;
  if (declaredAlways !== undefined) {
    const namesDefault = (entries: readonly AllowEntry[] | undefined) =>
      (entries ?? []).some((entry) => {
        const { tool } = normalizeAllowEntry(entry);
        return tool !== undefined && DEFAULT_TOOLS.has(tool);
      });
    const grantsDefault =
      namesDefault(declaredAlways) || Object.values(spec.states).some((state) => namesDefault(state?.tools?.allow));
    if (!grantsDefault) {
      warn(
        "tools.allow_always",
        `'tools.allow_always' is declared but grants none of the default tools ` +
          `(${[...DEFAULT_TOOLS].join(", ")}), and no state's 'tools.allow' names one. A declared ` +
          `'allow_always' replaces the default tools rather than adding to them, so this agent ` +
          `cannot read a file, not even an offloaded tool result. List the default tools the ` +
          `workflow needs under 'allow_always', or remove the key to grant them all.`,
      );
    }
  }

  // A guard on a workflow-wide grant binds, so one whose every path sits in the
  // always-open working area reads as governance but narrows nothing there.
  for (const [index, entry] of (spec.tools?.allow_always ?? []).entries()) {
    const narrowed = scratchpadOnlyNarrowing(entry);
    if (!narrowed) continue;
    warn(
      `tools.allow_always.${index}`,
      `'tools.allow_always' allows '${narrowed.tool}' on ${narrowed.paths.map((p) => `'${p}'`).join(", ")}, ` +
        `which is in the always-open '${SESSION_OPEN_DIR}/' area: those writes are permitted wherever ` +
        `the tool is granted, regardless of this entry, so it does not constrain where inside ` +
        `'${SESSION_OPEN_DIR}/' the write may land. Name an ordinary run path if the write itself ` +
        `should be governed.`,
    );
  }

  const alwaysSkills = spec.skills?.allow_always;
  const forbiddenSkills = spec.skills?.forbid_always ?? [];

  // A workflow-wide skill denial beats every grant, so a grant it covers reaches
  // no state at all.
  for (const named of forbiddenSkills) {
    const grantedSomewhere =
      (alwaysSkills ?? []).includes(named) ||
      Object.values(spec.states).some((state) => (state.skills?.allow ?? []).includes(named));
    if (!grantedSomewhere) continue;
    warn(
      "skills.forbid_always",
      `'skills.forbid_always' denies skill '${named}' in every state while a 'skills.allow' or ` +
        `'skills.allow_always' list also grants it; a denial beats every grant, so the grant ` +
        `reaches nothing. Drop one of the two.`,
    );
  }

  const alwaysMounts = normalizeMountGrants(spec.mounts?.allow_always);
  const alwaysMountNames = alwaysMounts.map((grant) => grant.mount);
  const forbiddenMounts = spec.mounts?.forbid_always ?? [];

  // A workflow-wide mount denial beats every grant, so a grant it covers reaches
  // no state at all — the mounts twin of the skills lint above.
  for (const named of forbiddenMounts) {
    const grantedSomewhere =
      alwaysMountNames.includes(named) ||
      Object.values(spec.states).some((state) =>
        normalizeMountGrants(state.mounts?.allow).some((grant) => grant.mount === named),
      );
    if (!grantedSomewhere) continue;
    warn(
      "mounts.forbid_always",
      `'mounts.forbid_always' denies mount '${named}' in every state while a 'mounts.allow' or ` +
        `'mounts.allow_always' list also grants it; a denial beats every grant, so the grant ` +
        `reaches nothing. Drop one of the two.`,
    );
  }

  // The workflow-wide tool denial that strands every run: no state could leave
  // itself, so nothing reaches a terminal state.
  const hasNonTerminal = Object.values(spec.states).some(
    (state) => (state.transitions ?? []).length > 0,
  );
  for (const entry of spec.tools?.forbid_always ?? []) {
    const { tool } = normalizeAllowEntry(entry);
    if (tool !== ADVANCE_TOOL || !hasNonTerminal) continue;
    error(
      "tools.forbid_always",
      `'tools.forbid_always' denies '${ADVANCE_TOOL}', the only way a state moves, in a workflow ` +
        `that has outgoing transitions — so no run could ever leave its start state. Deny a tool ` +
        `the graph does not need, or remove the entry.`,
    );
  }

  for (const [slug, state] of Object.entries(spec.states)) {
    const at = `states.${slug}`;
    const transitions = state.transitions ?? [];

    // A state's model overrides the workflow's; naming the same id overrides it
    // with itself, which reads as a deliberate choice while changing nothing.
    if (state.model !== undefined && state.model === spec.settings?.model) {
      warn(
        `${at}.model`,
        `State '${slug}' declares model '${state.model}', which is already ` +
          `'settings.model' for the whole workflow; the entry changes nothing. Drop it, or name ` +
          `a different id if this state should run on another model.`,
      );
    }

    // A state's list adds; only its `forbid` takes away, so an entry the workflow
    // already grants everywhere governs nothing, and an empty list that reads
    // like a deny is not one.
    if (alwaysSkills !== undefined && alwaysSkills.length > 0) {
      const declaredSkills = state.skills?.allow;
      if (declaredSkills !== undefined && declaredSkills.length === 0) {
        warn(
          `${at}.skills.allow`,
          `State '${slug}' declares 'skills: { allow: [] }', which reads like a deny but subtracts ` +
            `nothing: 'skills.allow_always' enables ${alwaysSkills.join(", ")} in every state. ` +
            `'skills: { forbid: [...] }' is what subtracts — name the slugs this state must not ` +
            `have there.`,
        );
      }
      for (const named of declaredSkills ?? []) {
        if (!alwaysSkills.includes(named)) continue;
        warn(
          `${at}.skills.allow`,
          `State '${slug}' enables skill '${named}', which 'skills.allow_always' already enables ` +
            `in every state; the entry grants nothing. Drop it here, or drop it from ` +
            `'allow_always' if only some states should have it.`,
        );
      }
    }

    // The same three shapes for mounts. `access` is why the both-levels case is
    // not simply redundant: a state entry that narrows the workflow's grant to
    // reads, or that asks to write a mount the workflow grants bare, is doing
    // real work, so only one repeating it unchanged is warned.
    const stateMounts = normalizeMountGrants(state.mounts?.allow);
    if (alwaysMountNames.length > 0) {
      if (Array.isArray(state.mounts?.allow) && stateMounts.length === 0) {
        warn(
          `${at}.mounts.allow`,
          `State '${slug}' declares 'mounts: { allow: [] }', which reads like a deny but ` +
            `subtracts nothing: 'mounts.allow_always' enables ${alwaysMountNames.join(", ")} in ` +
            `every state. 'mounts: { forbid: [...] }' is what subtracts — name the mounts this ` +
            `state must not reach.`,
        );
      }
      for (const grant of stateMounts) {
        if (!alwaysMountNames.includes(grant.mount)) continue;
        const always = alwaysMounts.filter((a) => a.mount === grant.mount);
        const narrows = grant.access === "read" && always.some((a) => a.access !== "read");
        // A bare grant asks for no write, so a state's `read_write` beside one is
        // what lets the workflow write the mount at all.
        const asksToWrite = grant.access === "read_write" && always.some((a) => a.access === undefined);
        if (narrows || asksToWrite) continue;
        warn(
          `${at}.mounts.allow`,
          `State '${slug}' enables mount '${grant.mount}', which 'mounts.allow_always' already ` +
            `enables in every state; the entry grants nothing. Write ` +
            `'{ mount: ${grant.mount}, access: read }' if the intent is to narrow it here, ` +
            `'mounts.forbid' to take it away, or drop it from 'allow_always' if only some ` +
            `states should have it.`,
        );
      }
    }
    for (const named of state.mounts?.forbid ?? []) {
      if (stateMounts.some((grant) => grant.mount === named)) {
        warn(
          `${at}.mounts.allow`,
          `State '${slug}' both enables and forbids mount '${named}'; the denial wins, so the ` +
            `'allow' entry governs nothing. Drop one of the two.`,
        );
      }
    }

    // A state's own denial beats its own grant, so a slug or tool it both grants
    // and denies is a grant that governs nothing.
    const stateForbidSkills = state.skills?.forbid ?? [];
    for (const named of stateForbidSkills) {
      if ((state.skills?.allow ?? []).includes(named)) {
        warn(
          `${at}.skills.allow`,
          `State '${slug}' both enables and forbids skill '${named}'; the denial wins, so the ` +
            `'allow' entry governs nothing. Drop one of the two.`,
        );
        continue;
      }
      // Nothing granted it here, so the denial has nothing to subtract.
      if (!(alwaysSkills ?? []).includes(named) && !forbiddenSkills.includes(named)) {
        warn(
          `${at}.skills.forbid`,
          `State '${slug}' forbids skill '${named}', which nothing enables here — neither ` +
            `'skills.allow_always' nor this state's own 'skills.allow' names it — so the entry ` +
            `governs nothing.`,
        );
      }
    }

    const stateAllowTools = new Set(
      (state.tools?.allow ?? []).map((entry) => normalizeAllowEntry(entry).tool),
    );
    for (const entry of state.tools?.forbid ?? []) {
      const { tool } = normalizeAllowEntry(entry);
      if (!tool || !stateAllowTools.has(tool)) continue;
      warn(
        `${at}.tools.allow`,
        `State '${slug}' both allows and forbids '${tool}'; the denial wins, so the 'allow' entry ` +
          `governs nothing. Drop one of the two.`,
      );
    }

    // A state with several outgoing edges is making a routing decision, which
    // belongs to its own `instructions`. Human and grader states require them
    // already, and a code state's script decides on its own.
    if ((state.type ?? "agent") === "agent" && transitions.length > 1 && !state.instructions?.trim()) {
      warn(
        `${at}.instructions`,
        `State '${slug}' has ${transitions.length} outgoing transitions but no 'instructions'; add guidance so the agent classifies the request and routes with archmax_advance instead of leaving that decision to whichever state it lands in`,
      );
    }

    // No routing-context advisory here: the schema refuses an edge without a
    // `description`, and a state's `summary` reaches no model call.

    if (state.type === "human") {
      if (!state.instructions?.trim()) {
        error(
          `${at}.instructions`,
          `Human state '${slug}' must declare 'instructions' describing the decision to present`,
        );
      }
      if (transitions.length === 0) {
        error(
          `${at}.transitions`,
          `Human state '${slug}' must declare at least one outgoing transition the human can route to`,
        );
      }
      // A missing button label is not checked here: the schema requires a
      // non-empty `description` on every transition of a human state.
      transitions.forEach((transition, index) => {
        // A decision routes the run *out* of the state: a self-edge is offered as
        // a button and then ends the run instead of routing.
        if (transition.to === slug) {
          error(
            `${at}.transitions.${index}.to`,
            `Human state '${slug}' declares a transition to itself; a decision routes the run ` +
              `*out* of the state, so this edge would be offered to the reviewer and then end ` +
              `the run. Point it at the state that does the further work (e.g. the state that ` +
              `produced what is being reviewed)`,
          );
        }
      });
      for (const labeled of LABELED_TRANSITION_TYPES) {
        const count = transitions.filter((transition) => transition.type === labeled).length;
        if (count > 1) {
          error(
            `${at}.transitions`,
            `Human state '${slug}' declares ${count} '${labeled}' transitions; a labeled ` +
              `decision type must map to a single target`,
          );
        }
      }
    }

    if (state.type === "code") {
      for (const key of Object.keys(CODE_STATE_UNREAD) as (keyof typeof CODE_STATE_UNREAD)[]) {
        if (state[key as keyof typeof state] === undefined) continue;
        error(
          `${at}.${key}`,
          `Code state '${slug}' declares '${key}', which a code state never reads: ${CODE_STATE_UNREAD[key]}.`,
        );
      }
    }

    if (state.type === "grader") {
      // A grader decides where the session goes, so it needs its criteria and
      // somewhere to send the session: a grader with no edge could approve only
      // by saying nothing, which fails open.
      if (!state.instructions?.trim()) {
        error(
          `${at}.instructions`,
          `Grader state '${slug}' must declare 'instructions': they are its criteria, the whole of ` +
            `what it grades the session against`,
        );
      }
      if (transitions.length === 0) {
        error(
          `${at}.transitions`,
          `Grader state '${slug}' must declare at least one transition: a grader decides with ` +
            `${ADVANCE_TOOL}, and with nowhere to send the session it could only approve by silence`,
        );
      }
      for (const key of ["evidence", "approvers"] as const) {
        if (state[key] === undefined) continue;
        error(
          `${at}.${key}`,
          `Grader state '${slug}' declares '${key}', which a grader never reads: ${CODE_STATE_UNREAD[key]}.`,
        );
      }
      if (state.budget?.maxParks !== undefined) {
        error(
          `${at}.budget.maxParks`,
          `Grader state '${slug}' declares 'budget.maxParks', but a grader cannot park: it ` +
            `decides within the turn it runs in`,
        );
      }
    }

    const withheld = STATE_TYPE_TOOLS[state.type ?? "agent"].withheld;
    if (state.type === "grader" || state.type === "code") {
      (state.tools?.allow ?? []).forEach((entry, index) => {
        const { tool } = normalizeAllowEntry(entry);
        if (!tool || !withheld.has(tool)) return;
        error(
          `${at}.tools.allow.${index}`,
          `State '${slug}' is a ${state.type} state, which is never offered '${tool}': an automated ` +
            `state cannot park or reset, and the planning list and the sandbox tools are the agent's. ` +
            `Drop the entry.`,
        );
      });
    }

    const seen = new Set<string>();
    for (const name of state.requires ?? []) {
      if (seen.has(name)) warn(`${at}.requires`, `State '${slug}' lists '${name}' twice in requires.`);
      seen.add(name);
    }

    // An entry whose every path sits in the always-open working area reads as
    // governance but cannot act as one there: `tool.scratchpad` allows the write
    // before the state's list is consulted, wherever the tool is granted.
    for (const entry of state.tools?.allow ?? []) {
      const narrowed = scratchpadOnlyNarrowing(entry);
      if (!narrowed) continue;
      warn(
        `${at}.tools.allow`,
        `State '${slug}' allows '${narrowed.tool}' on ${narrowed.paths.map((p) => `'${p}'`).join(", ")}, which is in the always-open '${SESSION_OPEN_DIR}/' area: those writes are permitted wherever the tool is granted, regardless of this entry, so it does not constrain where inside '${SESSION_OPEN_DIR}/' the write may land. Name an ordinary run path (e.g. '${slug}.json') if the write itself should be governed.`,
      );
    }
  }

  // A declaration is loose, so a host may decorate it; the SDK reads the keys it
  // knows and says so about the rest. There is nothing left to warn about an
  // orphaned declaration: writing one is what makes its state a start state.
  // A firing seeds what its trigger requires, locked: the host's value is final,
  // so a state that owns the same name can never write it.
  const owners = new Map(
    Object.entries(spec.states).flatMap(([slug, state]) => (state?.locks ?? []).map((name) => [name, slug] as const)),
  );
  for (const [slug, state] of Object.entries(spec.states)) {
    for (const [id, decl] of Object.entries(state?.triggers ?? {})) {
      for (const { name } of normalizeSignature(decl?.requires)) {
        const owner = owners.get(name);
        if (owner === undefined) continue;
        warn(
          `states.${slug}.triggers.${id}.requires`,
          `Trigger '${id}' requires '${name}', which state '${owner}' owns in 'locks'. A firing seeds it ` +
            `locked, so '${owner}' can never change it; drop it from one of the two.`,
        );
      }
    }
  }

  for (const [slug, state] of Object.entries(spec.states)) {
    for (const [id, decl] of Object.entries(state.triggers ?? {})) {
      for (const key of Object.keys(decl ?? {})) {
        if (TRIGGER_KEYS.has(key)) continue;
        warn(
          `states.${slug}.triggers.${id}`,
          `Trigger '${id}' declares unknown key '${key}', which the SDK ignores. The keys it reads are ${[...TRIGGER_KEYS].map((k) => `'${k}'`).join(", ")}.`,
        );
      }
    }
  }

  // A guard on a variable nothing declares rests on the agent having called
  // set_variables first. Not an error: the host may seed it at assembly, where
  // the authoritative check runs with the seeds known.
  const declared = declaredVariableNames(spec);
  for (const ref of guardReferences(spec)) {
    const name = ref.reference.name;
    if (name === TRIGGER_VARIABLE || declared.has(name)) continue;
    const where = ref.state ? `State '${ref.state}'` : "tools.allow_always";
    warn(
      ref.state ? `states.${ref.state}.tools.allow` : "tools.allow_always",
      `${where} guards '${ref.tool ?? "?"}' on '${ref.reference.raw}', but no state requires ` +
        `'${name}'. Supply it through the 'variables' option at assembly, or name it in the ` +
        `'requires' of a state that runs first — otherwise the guard depends on the agent ` +
        `having called set_variables, and the run fails at that call if it has not.` +
        (ref.state
          ? ""
          : " An allow_always entry is evaluated in every state, including states reached before anything sets it."),
    );
  }

  return out;
}

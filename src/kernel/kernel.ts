import {
  ADVANCE_TOOL,
  HARNESS_CONTROL_TOOLS,
  EVAL_TOOL,
  RUN_TOOL,
  SET_VARIABLES_TOOL,
  UNGRANTABLE_TOOLS,
} from "../machine/tool-names.js";
import type { WorkflowMachine } from "../machine/machine.js";
import type { ForbidEntry } from "../machine/types.js";
import { FORBID_ANY_TOOL } from "../machine/spec-schema.js";
import { argsSatisfy, normalizeAllowEntry, type GuardResolutionFailure } from "../machine/allow.js";
import type { VariableStore } from "../machine/variables.js";
import { unmetRequirements } from "../workflow/control-tools.js";
import { canonicalizeRelPath } from "../core/workspace.js";
import {
  classifyWorkspacePath,
  mountNameOf,
  SESSION_INTERNAL_DIRS,
  SESSION_OFFLOAD_DIRS,
  SESSION_OPEN_DIR,
} from "../core/zones.js";
import { NO_MOUNTS, type MountPrefixes } from "../core/mounts.js";
import { NO_SKILLS, skillOfPath, type SkillPrefixes } from "../core/skills.js";
import { authoringPlanePrefix, describeAuthoringPrefix } from "../core/mounts.js";
import type { LifecycleDecision } from "../lifecycle/runner.js";
import { rubricTransitionOutcome, type RubricVerdictResult } from "../rubrics/rubrics.js";

/**
 * The decision kernel: a single pure, synchronous function that produces every
 * governance verdict from the machine spec, a snapshot of checkpointed workflow
 * state, and a proposed action. Effectful work (running hooks/judges) happens in
 * `LifecycleRunner`; its outputs are reduced here as {@link HookFact}s so the
 * kernel stays pure and both runtime enforcement and static validation share one
 * code path.
 */

export type VerdictDecision = "allow" | "block";

export interface Verdict {
  decision: VerdictDecision;
  /**
   * A block the agent cannot recover from by retrying: the harness could not
   * evaluate the declared governance at all. The middleware ends the turn as a
   * failure (routed by `on_error`) rather than returning a retryable error.
   * Absent means an ordinary, recoverable block.
   */
  terminal?: boolean;
  /** Stable identifier for the rule that produced this verdict (for diagnostics/tests). */
  ruleId: string;
  /** Human-readable explanation, present on `block`. */
  reason?: string;
  /** Tool-call blocks: whether the block should surface as a warn-level event. */
  warn?: boolean;
  /** Transition reductions: whether the deciding hook consumed one of its iterations. */
  correctionConsumed?: boolean;
  /**
   * Transition reductions: whether the block is a `correct` refused because the
   * hook's `max_iterations` are already spent. Retrying in place cannot clear
   * it, so the runner reports it as a terminal rejection.
   */
  budgetExhausted?: boolean;
}

/**
 * A reduced lifecycle-hook outcome. `LifecycleRunner` executes a hook, parses
 * its return value into a {@link LifecycleDecision}, and hands it here (with an
 * optional `error` when the hook could not execute) for reduction.
 */
export interface HookFact extends LifecycleDecision {
  /** Present when the hook could not execute; reduces to a fail-closed veto. */
  error?: string;
  /** Bounded grade-and-retry budget for an `after` hook of any kind (0 = none). */
  maxIterations?: number;
  /** Iterations already consumed for this state. */
  iterationsUsed?: number;
}

/**
 * Who initiated a tool call. `agent` (the default) is a call the model made
 * directly; `script` is a programmatic call from a sandbox script, governed
 * identically to an agent call in the same state; `lifecycle` is a programmatic
 * call from a lifecycle hook, which runs on harness authority and skips the
 * per-state allow list and nothing else.
 */
export type ToolCallOrigin = "agent" | "script" | "lifecycle";

export type ProposedAction =
  | {
      kind: "tool-call";
      state: string;
      tool: string;
      args: Record<string, unknown>;
      /** Defaults to `agent` when absent. */
      origin?: ToolCallOrigin;
      /**
       * Whether the call was made during a **reply-only turn** — the run parked,
       * the model handed no tools. Supplied by the caller that knows which turn
       * it is in; absent means an ordinary turn.
       */
      replyOnly?: boolean;
    }
  | {
      kind: "transition";
      from: string;
      to: string;
      reason?: string;
      hookFacts: HookFact[];
    }
  | { kind: "enter-state"; state: string; hookFacts: HookFact[] };

/** Read-only context a governance rule may consult. */
export interface RuleApi {
  machine: WorkflowMachine;
  /**
   * The run's variables, so a guard's `${{name}}` references resolve. Absent,
   * every reference is unresolvable and fails closed: the guard blocks.
   */
  variables?: VariableStore;
  /**
   * The workspace's resolved mount keys, supplied by the caller — the kernel
   * holds no list of authored directory names. Absent, no path classifies as
   * authored, which is safe because read-only mounts refuse writes themselves.
   */
  mountPrefixes?: MountPrefixes;
  /**
   * The workspace's resolved skill bundles (slug → bundle prefix), supplied by
   * the caller. Absent or empty, no path lands inside a bundle and
   * {@link skillRule} never fires.
   */
  skills?: SkillPrefixes;
}

/**
 * A single governance rule: a pure function over a proposed action that either
 * returns a {@link Verdict} (its opinion) or `null` (abstain). The kernel folds
 * the ordered rule pipeline and the first non-null verdict wins; when every rule
 * abstains the default is allow.
 */
export type GovernanceRule = (action: ProposedAction, api: RuleApi) => Verdict | null;

/**
 * Agent tools that scripts may never invoke through programmatic tool calling
 * (PTC): every harness control tool (including both sandbox entry points, so
 * sandboxed code cannot re-enter the sandbox) plus a bare `eval`. Owned by
 * governance so the interpreter and the lifecycle runner cannot drift.
 */
export const PTC_EXCLUDED_TOOLS: ReadonlySet<string> = new Set<string>([
  // Moving the state machine is the model's governed decision, and a script
  // that could *write* variables would be editing the governance inputs of the
  // state it judges (scripts read them via the `args.variables` snapshot).
  ...HARNESS_CONTROL_TOOLS,
  "eval",
]);

const EVAL_BLOCK_MESSAGE =
  `[workflow] BLOCKED: an unnamespaced \`eval\` tool is never governed — use ` +
  `\`${EVAL_TOOL}\`, the runtime's own code interpreter.`;

const TASK_BLOCK_MESSAGE =
  `[workflow] BLOCKED: \`task\` is the runtime's own dispatch for grading rubrics, not a tool ` +
  `a state may call. A rubric grades your work; you do not call it. To delegate work to another ` +
  `process, use the workflow's declared \`archmax_workflow_<slug>\` tool.`;

const ALLOW: Verdict = { decision: "allow", ruleId: "allow" };

/** File-writing built-in tools whose `file_path` argument the kernel governs. */
const WRITE_TOOLS = new Set(["write_file", "edit_file"]);

/**
 * File tools whose access to the always-open run areas is permitted in every
 * state, independent of the state's `allow` list.
 */
const SESSION_OPEN_TOOLS = new Set(["read_file", "write_file", "edit_file", "ls"]);

/** Read-shaped file tools (offload areas are readable but never writable). */
const READ_TOOLS = new Set(["read_file", "ls"]);

/** Every file tool whose path argument the zone rules classify. */
const PATH_TOOLS = new Set(["read_file", "write_file", "edit_file", "ls", "glob", "grep"]);

/** The path argument a file tool carries, whatever it is named. */
function pathArg(args: Record<string, unknown>): string | null {
  const target = args.file_path ?? args.path;
  return typeof target === "string" ? target : null;
}

/**
 * Canonicalize a tool `file_path` argument to the single workspace-relative
 * form the backend resolves, so no zone decision can be dodged with a `./` or
 * `..` prefix. Traversal that escapes the root keeps its leading `..`, which
 * lands in no governed zone (and is separately refused by the backend).
 */
function normalizeZonePath(path: string): string {
  return canonicalizeRelPath(path).path;
}

/**
 * Whether a workspace-relative path targets the read-only authored zone (an
 * authored mount or an authored root file), via the shared table in
 * `core/zones.ts` so runtime, mount routing, and validation agree.
 */
export function isReadOnlyZonePath(path: string, mounts?: MountPrefixes): boolean {
  return classifyWorkspacePath(path, mounts) === "authored";
}

/**
 * Reduce a single lifecycle-hook fact to a verdict. Fail-closed: an execution
 * error is a veto. `before` hooks gate entry with `ok`/`veto` only — a `correct`
 * at entry has nothing to retry, so it reduces to a veto and never consumes the
 * correction budget. Within an `after` veto window any hook's `correct` (script
 * or subagent judge alike) enters the same bounded correction flow, budgeted by
 * the hook's `max_corrections`.
 */
export function reduceHookFact(
  fact: HookFact,
  opts: { phase: "before" | "after" | "tool"; veto: boolean; to?: string },
): Verdict {
  if (fact.error != null) {
    return { decision: "block", ruleId: "hook.error", reason: fact.error };
  }
  if (fact.verdict === "ok") return { decision: "allow", ruleId: "hook.ok" };

  if (opts.phase === "before") {
    const reason =
      fact.verdict === "correct"
        ? `before hooks cannot request corrections ('correct' gates nothing at entry, treated as veto): ${fact.reason}`
        : fact.reason;
    return { decision: "block", ruleId: "hook.veto", reason };
  }

  if (opts.phase === "after" && opts.veto) {
    const outcome = rubricTransitionOutcome(fact as RubricVerdictResult, {
      maxIterations: fact.maxIterations ?? 0,
      iterationsUsed: fact.iterationsUsed ?? 0,
      to: opts.to,
    });
    if (outcome.reason) {
      return {
        decision: "block",
        ruleId: fact.rubric ? "hook.rubric" : "hook.veto",
        reason: outcome.reason,
        // Only a block that actually granted a retry spends one, and only a
        // `correct` refused for want of budget is unretryable.
        correctionConsumed: outcome.consumesIteration,
        budgetExhausted: outcome.budgetExhausted,
      };
    }
    return { decision: "allow", ruleId: fact.rubric ? "hook.rubric" : "hook.ok" };
  }

  if (opts.veto) {
    return {
      decision: "block",
      ruleId: "hook.veto",
      reason: fact.reason,
      correctionConsumed: false,
    };
  }
  return { decision: "allow", ruleId: "hook.noop" };
}

/** Reduce an ordered list of hook facts, short-circuiting on the first block. */
function reduceHookFacts(
  facts: HookFact[],
  opts: { phase: "before" | "after"; veto: boolean; to?: string },
): Verdict {
  for (const fact of facts) {
    const verdict = reduceHookFact(fact, opts);
    if (verdict.decision !== "allow") return verdict;
  }
  return ALLOW;
}

/** The `not allowed in this state` block verdict shared by the tool-governance rules. */
function notAllowedVerdict(
  machine: WorkflowMachine,
  state: string,
  tool: string,
  args: Record<string, unknown>,
): Verdict {
  const target = typeof args.file_path === "string" ? ` on '${args.file_path}'` : "";
  const toHint = typeof args.to === "string" ? ` (to='${args.to}')` : "";
  // A terminal state has no outgoing transitions, so telling the agent to call
  // the advance tool there invites a retry loop. Direct it to just finish.
  const closingHint = machine.isTerminal(state)
    ? `This state ends automatically once you finish — do not call ${ADVANCE_TOOL}.`
    : `Complete the current state's work and call ${ADVANCE_TOOL} when ready to move on.`;
  const reason =
    `[workflow] BLOCKED: '${tool}'${target}${toHint} is not allowed in state '${state}'.\n` +
    `Allowed in '${state}': ${machine.describeAllowed(state)}.\n` +
    closingHint;
  return { decision: "block", ruleId: "tool.not-allowed", reason, warn: true };
}

/**
 * Safety rule: during a reply-only turn no tool call succeeds. A parked run may
 * speak, never act — no tools were disclosed, so a call here is one the model
 * invented from transcript context. Evaluated ahead of every other rule because
 * the control tools, `allow_always`, and the always-open scratchpad would each
 * otherwise permit exactly the acting this forbids.
 */
const replyOnlyRule: GovernanceRule = (action) => {
  if (action.kind !== "tool-call" || action.replyOnly !== true) return null;
  return {
    decision: "block",
    ruleId: "tool.reply-only",
    reason:
      `[workflow] BLOCKED: '${action.tool}' cannot run — this run is parked and a person is ` +
      `deciding what happens next. Reply to them in text; you cannot act until the run resumes.`,
    warn: true,
  };
};

/**
 * Safety rule: a tool named bare `eval` is always blocked — the harness's own
 * interpreter is `archmax_eval`; an unnamespaced one is not the tool governance
 * reasons about. Non-overridable — evaluated ahead of any custom rule.
 */
const evalBlockRule: GovernanceRule = (action) => {
  if (action.kind !== "tool-call" || action.tool !== "eval") return null;
  return { decision: "block", ruleId: "tool.eval", reason: EVAL_BLOCK_MESSAGE, warn: false };
};

/**
 * Safety rule: `task` is never callable by the agent. Registered rubrics make the
 * framework provide the tool so the *runtime* has a runnable to dispatch through;
 * that is not a grant. Non-overridable, so no state entry, `allow_always` or
 * consumer rule can re-open it — which is why disclosure withholding it and this
 * rule refusing it are two independent gates on the same fact.
 */
const taskBlockRule: GovernanceRule = (action) => {
  if (action.kind !== "tool-call" || !UNGRANTABLE_TOOLS.has(action.tool)) return null;
  return { decision: "block", ruleId: "tool.ungrantable", reason: TASK_BLOCK_MESSAGE, warn: false };
};

/**
 * Safety rule: writes into the read-only authored zone are always blocked.
 * Non-overridable — evaluated ahead of any custom rule.
 */
const readOnlyZoneRule: GovernanceRule = (action, api) => {
  if (action.kind !== "tool-call") return null;
  const { tool, args } = action;
  if (
    WRITE_TOOLS.has(tool) &&
    typeof args.file_path === "string" &&
    isReadOnlyZonePath(args.file_path, api.mountPrefixes)
  ) {
    const rel = normalizeZonePath(args.file_path);
    // The mount itself, so a nested key is named as authored (`catalogs/eu`)
    // rather than by the segment it happens to sit under.
    const mount = mountNameOf(rel, api.mountPrefixes) ?? rel.split("/")[0];
    return {
      decision: "block",
      ruleId: "zone.read-only",
      reason:
        `[workflow] BLOCKED: '${tool}' on '${args.file_path}' targets a read-only ` +
        `mount ('${mount}'). Authored content is mounted read-only — write your files under ` +
        `'${SESSION_OPEN_DIR}/…' (persisted per-session in the session store).`,
      warn: true,
    };
  }
  return null;
};

/**
 * Safety rule: the harness-internal run areas (`checkpoints/`, `artifacts/`,
 * `_specs/`) are not addressable by agent tools at all — not read, not written.
 * They hold the runtime's own bookkeeping for the run being executed.
 */
const runtimeInternalRule: GovernanceRule = (action) => {
  if (action.kind !== "tool-call" || !PATH_TOOLS.has(action.tool)) return null;
  const target = pathArg(action.args);
  if (target == null || classifyWorkspacePath(target) !== "run-internal") return null;
  return {
    decision: "block",
    ruleId: "zone.runtime-internal",
    reason:
      `[workflow] BLOCKED: '${action.tool}' on '${target}' targets a harness-internal run ` +
      `area (${SESSION_INTERNAL_DIRS.map((d) => `'${d}/'`).join(", ")}). These hold the runtime's ` +
      `own bookkeeping and are not part of your workspace — use '${SESSION_OPEN_DIR}/…' for ` +
      `your own files.`,
    warn: true,
  };
};

/**
 * Safety rule: the context-offload areas are runtime-owned. Deep Agents writes
 * evicted content there and hands the model the path, so reads are permitted
 * (see {@link runOpenAccessRule}) but an agent-initiated write is refused.
 */
const runtimeManagedRule: GovernanceRule = (action) => {
  if (action.kind !== "tool-call" || !WRITE_TOOLS.has(action.tool)) return null;
  const filePath = action.args.file_path;
  if (typeof filePath !== "string" || classifyWorkspacePath(filePath) !== "run-offload") return null;
  return {
    decision: "block",
    ruleId: "zone.runtime-managed",
    reason:
      `[workflow] BLOCKED: '${action.tool}' on '${filePath}' targets a runtime-owned area ` +
      `(${SESSION_OFFLOAD_DIRS.map((d) => `'${d}/'`).join(", ")}), where the runtime offloads ` +
      `oversized context. You may read those files; write your own under '${SESSION_OPEN_DIR}/…'.`,
    warn: true,
  };
};

/**
 * Safety rule: a skill bundle the acting state does not enable is unreachable.
 * The enforcement half of skill governance (declared by `skills.allow` at the
 * spec root and on a state): binds every path-classified tool plus
 * {@link RUN_TOOL}, so a disabled capability can be neither read, listed,
 * searched, written, nor executed.
 *
 * Non-overridable: evaluated with the safety rules, ahead of `policy`, consumer
 * rules, and the per-state `allow` default, so no declaration can reach into a
 * capability the state was not given; a `tools.allow` entry may only narrow
 * *within* the enabled set. `lifecycle` origin is exempt (harness authority, as
 * for the state allow list); `script` origin is not (model authority).
 */
const skillRule: GovernanceRule = (action, api) => {
  if (action.kind !== "tool-call" || action.origin === "lifecycle") return null;
  const skills = api.skills ?? NO_SKILLS;
  if (skills.length === 0) return null;
  const { tool, args, state } = action;
  if (!PATH_TOOLS.has(tool) && tool !== RUN_TOOL) return null;
  const target = pathArg(args);
  if (target == null) return null;
  const slug = skillOfPath(target, skills);
  if (slug == null) return null;
  const enabled = api.machine.enabledSkills(
    state,
    skills.map((skill) => skill.slug),
  );
  if (enabled.includes(slug)) return null;
  // A slug a list *denies* is a different mistake from one nothing granted: say
  // which, so an author is not sent looking for a grant they in fact wrote.
  const denial = api.machine.skillDenial(state, slug);
  const enabledHere =
    enabled.length > 0
      ? `Skills enabled here: ${enabled.join(", ")}.`
      : `No skill is enabled in this state.`;
  if (denial) {
    return {
      decision: "block",
      ruleId: "skill.forbidden",
      reason:
        `[workflow] BLOCKED: '${tool}' on '${target}' belongs to the skill '${slug}', which ` +
        `${denial === "workflow" ? "'skills.forbid_always' denies in every state" : `state '${state}' forbids`}. ` +
        `A denial beats every grant. ${enabledHere}`,
      warn: true,
    };
  }
  return {
    decision: "block",
    ruleId: "skill.not-allowed",
    reason:
      `[workflow] BLOCKED: '${tool}' on '${target}' belongs to the skill '${slug}', which is ` +
      `not enabled in state '${state}'. ` +
      enabledHere,
    warn: true,
  };
};

/**
 * Safety rule: a mount the acting state does not have is unreachable.
 *
 * The enforcement half of mount governance (declared by `mounts.allow` at the
 * spec root and on a state), and the mirror of {@link skillRule}: it binds every
 * path-classified tool plus {@link RUN_TOOL}, so a mount the state cannot see
 * can be neither read, listed, searched, written, nor executed from.
 *
 * Two kinds of mount, one rule. A **governed** mount (`MountSpec.governed`) is
 * closed by default: reachable only where `enabledMounts` names it. An
 * **ungoverned** mount is open in every state, so only a `forbid` takes it away.
 * The refusal distinguishes the two causes, because a name a list *denies* is a
 * different mistake from one nothing enabled.
 *
 * A mount the state *does* have is still refused a **write** when a grant
 * narrowed it to `access: read` (`mount.read-only`) — the second half of a mount
 * grant, beside which states may see it at all. Only a mount the host declared
 * writable ever reaches that branch: the zone rules refuse a write into a
 * host-read-only mount first, and say so as `zone.read-only`.
 *
 * Evaluated after the zone rules, so a *write* into a hidden read-only mount is
 * refused as read-only — the more useful reason — whether or not the state has
 * the mount. Non-overridable, and `lifecycle` origin is exempt: a hook and a
 * rubric grader run on runtime authority, bound by `mounts.forbid_always` (which
 * travels as an inherited rule, see {@link compileForbiddenMountRules}) and not
 * by the state's own surface.
 */
const mountRule: GovernanceRule = (action, api) => {
  if (action.kind !== "tool-call" || action.origin === "lifecycle") return null;
  const mounts = api.mountPrefixes ?? NO_MOUNTS;
  const { tool, args, state } = action;
  if (!PATH_TOOLS.has(tool) && tool !== RUN_TOOL) return null;
  const target = pathArg(args);
  if (target == null) return null;
  const name = mountNameOf(normalizeZonePath(target), mounts);
  if (name == null) return null;
  const denial = api.machine.mountDenial(state, name);
  const governed = mounts.governed.includes(name);
  const enabled = api.machine.enabledMounts(state, mounts.governed);
  const reachable = !denial && (!governed || enabled.includes(name));
  if (reachable) {
    // Reachable, but perhaps read-only *here*: a grant may narrow a writable
    // mount to reads without hiding it. The zone rule has already refused a
    // write into a mount the host serves read-only, so this only ever fires on
    // one the host declared writable.
    if (!WRITE_TOOLS.has(tool) || api.machine.mountWritable(state, name, mounts)) return null;
    return {
      decision: "block",
      ruleId: "mount.read-only",
      reason:
        `[workflow] BLOCKED: '${tool}' on '${target}' targets the mount '${name}', which state ` +
        `'${state}' may read but not write ('access: read'). Write your files under ` +
        `'${SESSION_OPEN_DIR}/…' instead.`,
      warn: true,
    };
  }
  const enabledHere =
    enabled.length > 0
      ? `Mounts available here: ${enabled.join(", ")}.`
      : `This state has no governed mount.`;
  if (denial) {
    return {
      decision: "block",
      ruleId: "mount.forbidden",
      reason:
        `[workflow] BLOCKED: '${tool}' on '${target}' is under the mount '${name}', which ` +
        `${denial === "workflow" ? "'mounts.forbid_always' denies in every state" : `state '${state}' forbids`}. ` +
        `A denial beats every grant. ${enabledHere}`,
      warn: true,
    };
  }
  return {
    decision: "block",
    ruleId: "mount.not-allowed",
    reason:
      `[workflow] BLOCKED: '${tool}' on '${target}' is under the mount '${name}', which state ` +
      `'${state}' does not have. The path exists; this state was not given it. ` +
      enabledHere,
    warn: true,
  };
};

/**
 * An **ancestor's** `mounts.forbid_always`, as rules the descendant inherits.
 * The mount twin of {@link compileForbiddenSkillRules}: a child machine resolves
 * its own enabled set and cannot see a caller's denial, so the denial travels as
 * a rule — any path under one of those mounts is refused, whatever the child
 * granted itself, and the refusal names the workflow that denied it.
 *
 * A workflow-wide denial binds a hook and a rubric grader too, so this rule —
 * unlike {@link mountRule} — does not exempt the `lifecycle` origin.
 */
export function compileForbiddenMountRules(
  names: readonly string[],
  source: string,
): GovernanceRule[] {
  if (names.length === 0) return [];
  const denied = new Set(names);
  return [
    (action, api) => {
      if (action.kind !== "tool-call") return null;
      const mounts = api.mountPrefixes ?? NO_MOUNTS;
      const { tool, args } = action;
      if (!PATH_TOOLS.has(tool) && tool !== RUN_TOOL) return null;
      const target = pathArg(args);
      if (target == null) return null;
      const name = mountNameOf(normalizeZonePath(target), mounts);
      if (name == null || !denied.has(name)) return null;
      return {
        decision: "block",
        ruleId: "mount.forbidden",
        reason:
          `[workflow] BLOCKED: '${tool}' on '${target}' is under the mount '${name}', which ` +
          `workflow '${source}' denies in every state it delegates to ` +
          `(mounts.forbid_always). A denial beats every grant.`,
        warn: true,
      };
    },
  ];
}

/**
 * An **ancestor's** `skills.forbid_always`, as rules the descendant inherits. A
 * child machine resolves its own enabled set and cannot see a caller's denial,
 * so the denial travels as a rule: any path inside one of those bundles is
 * refused, whatever the child granted itself.
 */
export function compileForbiddenSkillRules(slugs: readonly string[], source: string): GovernanceRule[] {
  if (slugs.length === 0) return [];
  const denied = new Set(slugs);
  return [
    (action, api) => {
      if (action.kind !== "tool-call") return null;
      const skills = api.skills ?? NO_SKILLS;
      if (skills.length === 0) return null;
      const { tool, args } = action;
      if (!PATH_TOOLS.has(tool) && tool !== RUN_TOOL) return null;
      const target = pathArg(args);
      if (target == null) return null;
      const slug = skillOfPath(target, skills);
      if (slug == null || !denied.has(slug)) return null;
      return {
        decision: "block",
        ruleId: "skill.forbidden",
        reason:
          `[workflow] BLOCKED: '${tool}' on '${target}' belongs to the skill '${slug}', which ` +
          `workflow '${source}' denies in every state it delegates to ` +
          `(skills.forbid_always). A denial beats every grant.`,
        warn: true,
      };
    },
  ];
}

/**
 * Always-permitted run access, independent of the state's `allow` list:
 * `scratchpad/…` — read, write, edit, list (run-isolated, persisted); the
 * context-offload areas — read and list only (writes are blocked above).
 * Evaluated after the safety, policy, and consumer rules (any of which may
 * still block it), just ahead of the per-state defaults — so it loosens only
 * the state `allow` list, never the governed run paths outside it.
 */
const runOpenAccessRule: GovernanceRule = (action) => {
  if (action.kind !== "tool-call") return null;
  const target = pathArg(action.args);
  if (target == null) return null;
  const zone = classifyWorkspacePath(target);
  if (zone === "run-open" && SESSION_OPEN_TOOLS.has(action.tool)) {
    return { decision: "allow", ruleId: "tool.scratchpad" };
  }
  if (zone === "run-offload" && READ_TOOLS.has(action.tool)) {
    return { decision: "allow", ruleId: "tool.offload-read" };
  }
  return null;
};

/**
 * Default rule: the active state's `tools` governance (allow-list matching
 * and the workflow-level `allow_always` grants, via {@link WorkflowMachine.checkAllowed}).
 * Evaluated last, after custom and policy rules, so a custom rule may block a
 * call the state would otherwise permit but cannot loosen the state's grant.
 */
const stateToolsRule: GovernanceRule = (action, { machine, variables }) => {
  if (action.kind !== "tool-call") return null;
  // Lifecycle hooks run on harness authority, so the state's grant does not
  // bind them; every other rule in the pipeline still does.
  if (action.origin === "lifecycle") return null;
  const { state, tool, args } = action;
  let unresolved: GuardResolutionFailure | undefined;
  const allowed = machine.checkAllowed(state, tool, args, {
    ...(variables ? { variables } : {}),
    onUnresolved: (failure) => {
      unresolved ??= failure;
    },
  });
  if (allowed) return { decision: "allow", ruleId: "tool.allowed" };
  // An unresolvable reference is not a mismatch: the guard itself could not be
  // evaluated, retrying cannot fix that, so the run stops here.
  if (unresolved) return unresolvedGuardVerdict(state, tool, unresolved);
  return notAllowedVerdict(machine, state, tool, args);
};

/** The terminal verdict for a guard whose `${{…}}` reference could not resolve. */
function unresolvedGuardVerdict(
  state: string,
  tool: string,
  failure: GuardResolutionFailure,
): Verdict {
  return {
    decision: "block",
    ruleId: "tool.unresolved-variable",
    terminal: true,
    reason:
      `[workflow] FAILED: '${tool}' in state '${state}' is guarded by ` +
      `'${failure.reference}', which could not be resolved — ${failure.detail}. ` +
      `The run cannot continue against a guard the harness cannot evaluate.`,
    warn: true,
  };
}

/**
 * Safety rule: `archmax_run` executes only scripts that live inside a skill bundle.
 * Hook scripts (run by the lifecycle runner from the authoring plane) and runtime
 * scripts (run by the agent from a skill bundle) are disjoint by construction: an
 * agent cannot run its own guard, a file it wrote into the run zone, or another
 * workflow's hooks. Classification uses the resolved skill registry rather than a
 * literal `skills/` string, so an empty registry blocks every `archmax_run`.
 *
 * Non-overridable: evaluated with the safety rules, ahead of `policy`, consumer
 * rules, and the per-state `allow` default, so a broad `tools.allow` entry cannot
 * widen it; a state's entry may still *narrow* execution within the bundles.
 */
const scriptSkillOnlyRule: GovernanceRule = (action, api) => {
  if (action.kind !== "tool-call" || action.tool !== RUN_TOOL) return null;
  const target = pathArg(action.args);
  if (target == null) return null;
  if (skillOfPath(target, api.skills ?? NO_SKILLS) != null) return null;
  return {
    decision: "block",
    ruleId: "script.skill-only",
    reason:
      `[workflow] BLOCKED: '${RUN_TOOL}' may only execute scripts that live in a skill bundle, ` +
      `and '${target}' is not in one. Scripts the agent runs belong in ` +
      `'skills/<capability>/scripts/'; lifecycle hook scripts live on the authoring plane and are ` +
      `run by the harness, never by the agent.`,
    warn: true,
  };
};

/**
 * Safety rule: the authoring plane is not addressable. Every
 * {@link AUTHORING_PREFIXES} prefix (`workflows/**`) has no route
 * in the agent's workspace composite, so an agent read finds nothing; a
 * **script** or **hook** naming one is told why, and which prefix. Applies in
 * every state whatever it allows — the plane's isolation is structural, not
 * granted.
 */
const governancePlaneRule: GovernanceRule = (action) => {
  if (action.kind !== "tool-call") return null;
  if (action.origin !== "script" && action.origin !== "lifecycle") return null;
  const target = pathArg(action.args);
  if (target == null) return null;
  const { path: rel, escapes } = canonicalizeRelPath(target);
  if (escapes) return null;
  const prefix = authoringPlanePrefix(rel);
  if (!prefix) return null;
  return {
    decision: "block",
    ruleId: "zone.governance-plane",
    reason:
      `[workflow] BLOCKED: '${action.tool}' on '${target}' addresses the authoring plane ` +
      `('${prefix}/'), which holds ${describeAuthoringPrefix(prefix)}. The ` +
      `harness reads it through the authoring backend; nothing running inside a run can.`,
    warn: true,
  };
};

/**
 * Non-overridable safety rules, evaluated before any policy/consumer rule so
 * none of those can loosen them.
 */
const SAFETY_RULES: readonly GovernanceRule[] = [
  governancePlaneRule,
  scriptSkillOnlyRule,
  replyOnlyRule,
  evalBlockRule,
  taskBlockRule,
  readOnlyZoneRule,
  runtimeInternalRule,
  runtimeManagedRule,
  // After the zone rules: a *write* into a bundle is refused as a read-only
  // authored path whether or not the skill is enabled — the more useful reason.
  skillRule,
  // And after the skill rule, for the same reason: a path inside a bundle is
  // named as a skill before it is named as the mount that serves the bundle.
  mountRule,
];

/** Where a denial was declared, which decides its scope, ruleId and wording. */
export type ForbidScope = "workflow" | "state";

/**
 * Compile a `forbid_always` (root) or `forbid` (state) list into governance
 * rules. One implementation for both positions: the entries share the `allow`
 * grammar, so `normalizeAllowEntry` and the argument-guard matcher are the same
 * ones the grant side uses, and the two differ only in what they match and how
 * the refusal reads.
 *
 * A denial is evaluated ahead of every grant and every consumer rule, so **deny
 * beats allow and no narrower level widens a denial**: nothing reaches past a
 * workflow's `forbid_always`, and nothing in a state reaches past its `forbid`.
 * An entry naming the tool `*` denies every tool; an entry with argument guards
 * denies only the calls those guards match.
 *
 * Returns an empty list for an empty declaration, so the pipeline is unchanged
 * for a workflow that denies nothing. Pure — the same rules run at runtime and
 * in the validator.
 */
export function compileForbidRules(
  entries: readonly ForbidEntry[] | undefined,
  options: {
    scope: ForbidScope;
    /** The state the entries belong to. Required for `scope: "state"`. */
    state?: string;
    /**
     * The workflow that declared this denial, named in the block reason when it
     * is an **ancestor** of the governed machine — a delegated machine inherits
     * every ancestor's denials, so the refusal must say whose rule stopped it.
     */
    source?: string;
  },
): GovernanceRule[] {
  if (!entries || entries.length === 0) return [];
  const { scope, state, source } = options;
  const from = source ? ` inherited from workflow '${source}'` : "";
  const rules: GovernanceRule[] = [];

  for (const entry of entries) {
    const { tool, argMatchers } = normalizeAllowEntry(entry);
    if (!tool) continue; // reported by the schema
    const anyTool = tool === FORBID_ANY_TOOL;
    const key = scope === "workflow" ? "tools.forbid_always" : `states.${state}.tools.forbid`;
    const where = scope === "workflow" ? `the workflow${from}` : `state '${state}'`;
    rules.push((action, { variables }) => {
      if (action.kind !== "tool-call") return null;
      if (!anyTool && action.tool !== tool) return null;
      if (scope === "state" && action.state !== state) return null;
      const guards = argMatchers ? describeGuards(argMatchers) : null;
      if (argMatchers && !matchesEveryGuard(action.args, argMatchers, variables ?? {})) return null;
      const target = typeof action.args.file_path === "string" ? ` on '${action.args.file_path}'` : "";
      return {
        decision: "block",
        ruleId: scope === "workflow" ? "tool.forbidden" : "tool.forbidden-here",
        reason:
          `[workflow] BLOCKED: '${action.tool}'${target} is forbidden by ${where} ` +
          `(${key}${guards ? `: ${guards}` : ""}). A denial beats every grant, so no allow entry ` +
          `here permits it.`,
        warn: true,
      };
    });
  }

  return rules;
}

/**
 * Whether every one of an entry's argument guards matches the call's arguments.
 *
 * Resolution is the allow side's own (`argsSatisfy`), so a guard binds the same
 * calls whichever list it is written in: `${{…}}` resolves against the run's
 * variables and a dotted name traverses nested arguments. A denial that
 * understood fewer guard forms than the grant beside it would silently match
 * nothing, which is the shape of issue #156.
 *
 * The one asymmetry is deliberate. An allow entry whose reference cannot be
 * resolved grants nothing; a forbid entry in the same position must **match**,
 * so an unresolvable guard closes the call rather than opening it.
 */
function matchesEveryGuard(
  args: Record<string, unknown>,
  argMatchers: Record<string, string[]>,
  variables: VariableStore,
): boolean {
  let unresolved = false;
  const satisfied = argsSatisfy(argMatchers, args, variables, () => {
    unresolved = true;
  });
  return satisfied || unresolved;
}

/** An entry's guards, for the refusal reason: `file_path=logs/**`. */
function describeGuards(argMatchers: Record<string, string[]>): string {
  return Object.entries(argMatchers)
    .map(([name, globs]) => `${name}=${globs.join("|")}`)
    .join(", ");
}

/**
 * Assemble the ordered tool-governance pipeline: safety rules → the workflow's
 * `tools.forbid_always` → the active state's `tools.forbid` → consumer rules →
 * always-permitted run access → per-state defaults. Every declared denial
 * therefore precedes every grant and every consumer rule. The same pipeline runs
 * at runtime and in `validate`.
 */
function toolCallPipeline(
  machine: WorkflowMachine,
  customRules: GovernanceRule[],
  state: string,
): GovernanceRule[] {
  return [
    ...SAFETY_RULES,
    ...compileForbidRules(machine.spec.tools?.forbid_always, { scope: "workflow" }),
    ...compileForbidRules(machine.spec.states[state]?.tools?.forbid, { scope: "state", state }),
    ...customRules,
    runOpenAccessRule,
    stateToolsRule,
  ];
}

/** Fold the tool-call rule pipeline: first non-null verdict wins, else allow. */
function decideToolCall(
  machine: WorkflowMachine,
  action: Extract<ProposedAction, { kind: "tool-call" }>,
  customRules: GovernanceRule[],
  mountPrefixes: MountPrefixes,
  variables: VariableStore,
  skills: SkillPrefixes,
): Verdict {
  const api: RuleApi = { machine, mountPrefixes, variables, skills };
  for (const rule of toolCallPipeline(machine, customRules, action.state)) {
    const verdict = rule(action, api);
    if (verdict) return verdict;
  }
  return ALLOW;
}

/**
 * The single governance decision function. Given the machine, a proposed action,
 * and any consumer-supplied governance rules, return a typed verdict. Pure and
 * synchronous, so runtime enforcement and static validation share one path.
 */
export function decide(
  machine: WorkflowMachine,
  action: ProposedAction,
  customRules: GovernanceRule[] = [],
  mountPrefixes: MountPrefixes = NO_MOUNTS,
  variables: VariableStore = {},
  skills: SkillPrefixes = NO_SKILLS,
): Verdict {
  switch (action.kind) {
    case "tool-call":
      return decideToolCall(machine, action, customRules, mountPrefixes, variables, skills);

    case "transition": {
      // The `requires` gate runs before the edge's hooks: the agent owes a value
      // it can still supply, so a judge on incomplete work would be wasted.
      const unmet = unmetRequirements(machine.requiredVariables(action.from), variables ?? {});
      if (unmet.length > 0) {
        return {
          decision: "block",
          ruleId: "transition.requires",
          reason:
            `cannot leave '${action.from}' yet: ${unmet.map((n) => `'${n}'`).join(", ")} ` +
            `${unmet.length === 1 ? "is" : "are"} not set. Record ` +
            `${unmet.length === 1 ? "it" : "them"} with ${SET_VARIABLES_TOOL}, then advance.`,
        };
      }
      const edge = machine.getTransition(action.from, action.to);
      if (!edge) {
        const valid = machine.transitionTargets(action.from);
        return {
          decision: "block",
          ruleId: "transition.no-edge",
          reason:
            `cannot advance from '${action.from}' to '${action.to}'. ` +
            (valid.length
              ? `Valid target slugs: ${valid.join(", ")}.`
              : "No transitions from this state."),
        };
      }
      return reduceHookFacts(action.hookFacts, {
        phase: "after",
        veto: true,
        to: action.to,
      });
    }

    case "enter-state":
      return reduceHookFacts(action.hookFacts, { phase: "before", veto: false });
  }
}

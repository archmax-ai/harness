import { createWorkflowEventEmitter, type WorkflowEventHandler } from "../core/events.js";
import type { Workspace } from "../core/workspace.js";
import type { MountPrefixes } from "../core/zones.js";
import { computeSpecHash } from "../workflow/snapshot.js";
import { normalizeHooks } from "../lifecycle/hook-shape.js";
import {
  argsSatisfy,
  normalizeAllowEntry,
  type GuardResolutionFailure,
  type NormalizedAllowEntry,
} from "./allow.js";
import { normalizeMountGrants } from "./mount-grants.js";
import { describeGlob, type VariableStore } from "./variables.js";
import { loadMachineSpec, type WorkflowSpecPaths } from "./load-spec.js";
import { signatureForTrigger, type TriggerSignature } from "./signature.js";
import {
  MANUAL_TRIGGER,
  triggerBindings,
  type SessionPath,
  type TriggerBinding,
} from "./triggers.js";
import {
  ADVANCE_TOOL,
  ALWAYS_ALLOWED_TOOLS,
  UNGRANTABLE_TOOLS,
  ESSENTIAL_TOOLS,
  GET_VARIABLES_TOOL,
  RESET_TOOL,
  SET_VARIABLES_TOOL,
  WAIT_TOOL,
  workflowSlugFromToolName,
} from "./tool-names.js";
import {
  specDisabled,
  type AllowEntry,
  type ForbidEntry,
  type HarnessSettings,
  type LifecycleHook,
  type MachineSpec,
  type MachineTransition,
} from "./types.js";

export { ALWAYS_ALLOWED_TOOLS, ESSENTIAL_TOOLS, UNGRANTABLE_TOOLS };

/**
 * A declared list, or nothing. `validate` builds a machine from a spec whose
 * schema may have failed — so a governance key can hold a scalar or an object
 * here — and reading one as empty keeps every resolver total instead of throwing
 * mid-diagnostic.
 */
function list<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Read-only context a guard check consults: the run's variables (for `${{…}}`
 * substitution) and a sink for the first unresolvable reference, which the
 * kernel escalates to a terminal run failure rather than a retryable block.
 */
export interface GuardContext {
  variables?: VariableStore;
  onUnresolved?: (failure: GuardResolutionFailure) => void;
}

/** Default per-eval timeout (ms) for interpreter and lifecycle scripts. */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * The compiled workflow: what the runtime consults for transitions, tool
 * surfaces, enabled skills and trigger wiring. A pure view over the parsed
 * `spec` — no workspace, no file access. Declarations are read off `spec`
 * directly (`machine.spec.states[slug].instructions`); the methods here are the
 * derived answers.
 */
export class WorkflowMachine {
  /**
   * The entry state: the `manual` start state, else the first declared start
   * state, else the first declared state — so a machine always has one.
   */
  readonly entry: string;

  private bindingsCache?: Map<string, TriggerBinding>;
  private readonly signatureCache = new Map<string, TriggerSignature | undefined>();

  private constructor(
    readonly spec: MachineSpec,
    /**
     * Host-declared tool names treated as essential — always disclosed and
     * permitted in every state, exactly like the built-in {@link ESSENTIAL_TOOLS}.
     */
    private readonly extraEssential: ReadonlySet<string> = new Set(),

  ) {
    if (!spec.states || Object.keys(spec.states).length === 0) {
      throw new Error("Invalid machine spec: missing states");
    }
    this.entry =
      this.startStateForTrigger(MANUAL_TRIGGER) ??
      this.startStates()[0]?.state ??
      Object.keys(spec.states)[0]!;
  }

  /**
   * Load the machine from its two files, or `null` when nothing loads to a
   * usable machine. Load problems other than a missing file are emitted as
   * `warning` events.
   */
  static async load(
    workspace: Workspace,
    paths: WorkflowSpecPaths,
    onEvent?: WorkflowEventHandler,
  ): Promise<WorkflowMachine | null> {
    const emit = createWorkflowEventEmitter(onEvent);
    const { spec, issues, lint, usable } = await loadMachineSpec(workspace, paths);
    for (const issue of [...issues, ...lint]) {
      if (issue.kind !== "missing") {
        emit({ type: "warning", scope: "workflow", message: issue.message });
      }
    }
    return usable && spec ? new WorkflowMachine(spec) : null;
  }

  /** Construct a machine from an already-parsed spec. */
  static fromSpec(
    spec: MachineSpec,
    extraEssentialTools?: Iterable<string>,
  ): WorkflowMachine {
    return new WorkflowMachine(spec, new Set(extraEssentialTools));
  }

  /**
   * Stable content hash of the spec, written into a session's first checkpoint
   * and compared on resume.
   */
  get specHash(): string {
    return computeSpecHash(this.spec);
  }

  /** Whether this machine is out of service (see {@link specDisabled}). */
  get disabled(): boolean {
    return specDisabled(this.spec);
  }

  /** Runtime knobs from `settings`, defaults applied. */
  get harnessSettings(): HarnessSettings {
    const s = this.spec.settings ?? {};
    return {
      timeoutMs: s.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      memoryLimitBytes: s.memoryLimitBytes,
      maxPtcCalls: s.maxPtcCalls,
      maxResultChars: s.maxResultChars,
      ...(s.prompt_cache
        ? {
            promptCache: {
              ...(s.prompt_cache.enabled !== undefined ? { enabled: s.prompt_cache.enabled } : {}),
              ...(s.prompt_cache.ttl !== undefined ? { ttl: s.prompt_cache.ttl } : {}),
            },
          }
        : {}),
    };
  }

  /**
   * The model id `state`'s turns run on, or `undefined` when the workflow leaves
   * the choice to the assembly. The one place the chain is derived — the state's
   * `model`, else the root's `settings.model` — so nothing re-implements the
   * precedence. An unknown slug reads as the workflow's own declaration, which is
   * what the runtime wants for a position it cannot resolve.
   */
  modelFor(state: string): string | undefined {
    return this.spec.states[state]?.model ?? this.spec.settings?.model;
  }

  /**
   * Every distinct model id this spec declares, in a stable order (the root's
   * first, then each state's in declaration order). What assembly builds a model
   * for, and what it names when an explicit `model` instance makes them inert.
   */
  declaredModels(): string[] {
    const ids = new Set<string>();
    if (this.spec.settings?.model) ids.add(this.spec.settings.model);
    for (const state of Object.values(this.spec.states)) {
      if (state?.model) ids.add(state.model);
    }
    return [...ids];
  }

  // --- Skills ---------------------------------------------------------------------

  /**
   * The skills the workflow grants in **every** state: the root's
   * `allow_always`, resolved against the registry. A state's `skills.allow`
   * adds to this list, exactly as `tools.allow` adds to `tools.allow_always`.
   * An absent key grants nothing, the same as `allow_always: []`. A declared
   * slug the registry does not provide is dropped (and reported by `validate`).
   */
  workflowAlwaysSkills(available: readonly string[]): string[] {
    const provided = new Set(available);
    return list(this.spec.skills?.allow_always).filter((slug) => provided.has(slug));
  }

  /** The slugs `skills.forbid_always` denies in every state of this workflow. */
  workflowForbiddenSkills(): string[] {
    return list(this.spec.skills?.forbid_always);
  }

  /**
   * The slugs denied while `state` is active, from either level. Declaration
   * order, workflow-wide first, so a caller rendering them is byte-stable.
   */
  forbiddenSkills(state: string): string[] {
    const workflow = this.workflowForbiddenSkills();
    const own = list(this.spec.states[state]?.skills?.forbid).filter(
      (slug) => !workflow.includes(slug),
    );
    return [...workflow, ...own];
  }

  /**
   * Which level denies `slug` in `state`, or `undefined` if neither does — so a
   * refusal can say whether a list forbade the bundle or nothing granted it.
   */
  skillDenial(state: string, slug: string): "workflow" | "state" | undefined {
    if (this.workflowForbiddenSkills().includes(slug)) return "workflow";
    if (list(this.spec.states[state]?.skills?.forbid).includes(slug)) return "state";
    return undefined;
  }

  /**
   * The skills enabled while `state` is active — the one answer the kernel's
   * skill rule, prompt disclosure, the PTC listing redaction and `validate` all
   * consult.
   *
   * The grant is additive: the state's own `skills.allow` followed by the root's
   * `allow_always`, each in declaration order, deduplicated by slug. The denial
   * beats it: anything `skills.forbid_always` or the state's `skills.forbid`
   * names is removed, so **deny beats allow and no narrower level widens a
   * denial**. Order is declaration order from the frozen spec, so everything
   * rendered from this — the prompt's skills section above all — is byte-stable
   * across the model calls of a turn.
   */
  enabledSkills(state: string, available: readonly string[]): string[] {
    const provided = new Set(available);
    const own = list(this.spec.states[state]?.skills?.allow).filter((slug) => provided.has(slug));
    const always = this.workflowAlwaysSkills(available).filter((slug) => !own.includes(slug));
    const denied = new Set(this.forbiddenSkills(state));
    return [...own, ...always].filter((slug) => !denied.has(slug));
  }

  // --- Mounts ---------------------------------------------------------------------

  /**
   * The governed mounts the workflow enables in **every** state: the root's
   * `mounts.allow_always`, filtered to the names the host declared governed. A
   * state's `mounts.allow` adds to this list, exactly as `skills.allow` adds to
   * `skills.allow_always`. An absent key grants nothing, the same as
   * `allow_always: []`. A name the table does not govern is dropped (and
   * reported by `validate`) — an ungoverned mount needs no grant.
   */
  workflowAlwaysMounts(governed: readonly string[]): string[] {
    const table = new Set(governed);
    return normalizeMountGrants(this.spec.mounts?.allow_always)
      .map((grant) => grant.mount)
      .filter((name) => table.has(name));
  }

  /**
   * The names `mounts.forbid_always` denies in every state of this workflow —
   * governed or not, since a denial subtracts an ungoverned mount's standing
   * visibility too.
   */
  workflowForbiddenMounts(): string[] {
    return list(this.spec.mounts?.forbid_always);
  }

  /**
   * The mount names denied while `state` is active, from either level.
   * Declaration order, workflow-wide first, so a caller rendering them is
   * byte-stable.
   */
  forbiddenMounts(state: string): string[] {
    const workflow = this.workflowForbiddenMounts();
    const own = list(this.spec.states[state]?.mounts?.forbid).filter(
      (name) => !workflow.includes(name),
    );
    return [...workflow, ...own];
  }

  /**
   * Which level denies `name` in `state`, or `undefined` if neither does — so a
   * refusal can say whether a list forbade the mount or nothing enabled it.
   */
  mountDenial(state: string, name: string): "workflow" | "state" | undefined {
    if (this.workflowForbiddenMounts().includes(name)) return "workflow";
    if (list(this.spec.states[state]?.mounts?.forbid).includes(name)) return "state";
    return undefined;
  }

  /**
   * The **governed** mounts enabled while `state` is active — the one answer the
   * kernel's mount rule, prompt disclosure, the listing redaction and `validate`
   * all consult. Ungoverned mounts are not in it: they are visible in every
   * state without a grant, and `forbiddenMounts` is what takes one away.
   *
   * The grant is additive: the state's own `mounts.allow` followed by the root's
   * `allow_always`, each in declaration order, deduplicated by name. The denial
   * beats it: anything `mounts.forbid_always` or the state's `mounts.forbid`
   * names is removed, so **deny beats allow and no narrower level widens a
   * denial**. Order is declaration order from the frozen spec, so everything
   * rendered from this is byte-stable across the model calls of a turn.
   */
  enabledMounts(state: string, governed: readonly string[]): string[] {
    const table = new Set(governed);
    const own = normalizeMountGrants(this.spec.states[state]?.mounts?.allow)
      .map((grant) => grant.mount)
      .filter((name) => table.has(name));
    const always = this.workflowAlwaysMounts(governed).filter((name) => !own.includes(name));
    const denied = new Set(this.forbiddenMounts(state));
    return [...own, ...always].filter((name) => !denied.has(name));
  }

  /**
   * Whether writes to `name` are permitted while `state` is active — the second
   * half of a mount grant, beside which states may see it at all.
   *
   * A mount is writable here only when the host declared it writable **and** no
   * applicable grant narrowed it to `read`. Read-only is a restriction, so it
   * behaves like every other restriction in this schema: whichever level asks
   * for it gets it, and no narrower level widens it back. `read_write` on a
   * mount the host serves read-only is therefore inert (reported by `validate`)
   * — the host's posture is the ceiling, not a default to argue with.
   *
   * An ungoverned mount takes the host's posture in every state: it carries no
   * grant to qualify.
   */
  mountWritable(state: string, name: string, mounts: MountPrefixes): boolean {
    if (!mounts.writable.includes(name)) return false;
    const applicable = [
      ...normalizeMountGrants(this.spec.states[state]?.mounts?.allow),
      ...normalizeMountGrants(this.spec.mounts?.allow_always),
    ].filter((grant) => grant.mount === name);
    return !applicable.some((grant) => grant.access === "read");
  }

  // --- Graph ----------------------------------------------------------------------

  transitionTargets(from: string): string[] {
    return (this.spec.states[from]?.transitions ?? []).map((t) => t.to);
  }

  getTransition(from: string, to: string): MachineTransition | undefined {
    return this.spec.states[from]?.transitions?.find((t) => t.to === to);
  }

  /** The state a failed turn routes to (`on_error`), if declared and present. */
  onError(state: string): string | undefined {
    const target = this.spec.states[state]?.on_error;
    return target && this.spec.states[target] ? target : undefined;
  }

  /** A state with no declared outgoing transitions is terminal (ends the run). */
  isTerminal(state: string): boolean {
    return this.transitionTargets(state).length === 0;
  }

  /** Whether a state is a human decision state (a person picks the edge). */
  isHumanState(state: string): boolean {
    return this.spec.states[state]?.type === "human";
  }

  /**
   * States a run can reach: the start states plus everything transitively
   * reachable through transitions and `on_error` routes. A state no start state
   * reaches is dead in the definition, so nothing it declares widens the surface.
   */
  reachableStates(): Set<string> {
    const seen = new Set<string>();
    const queue = this.startStates().map((s) => s.state);
    while (queue.length > 0) {
      const slug = queue.shift()!;
      if (seen.has(slug) || !this.spec.states[slug]) continue;
      seen.add(slug);
      queue.push(...this.transitionTargets(slug));
      const errorTarget = this.onError(slug);
      if (errorTarget) queue.push(errorTarget);
    }
    return seen;
  }

  /** Each state's normalized `before`/`after` hook lists, for states declaring any. */
  lifecycleHooks(): Record<string, LifecycleHook> {
    const map: Record<string, LifecycleHook> = {};
    for (const [slug, state] of Object.entries(this.spec.states)) {
      const before = normalizeHooks(state.before);
      const after = normalizeHooks(state.after);
      if (before.length || after.length) {
        map[slug] = {
          ...(before.length ? { before } : {}),
          ...(after.length ? { after } : {}),
        };
      }
    }
    return map;
  }

  /**
   * The sibling workflows this machine may delegate to: every
   * `archmax_workflow_<slug>` named in `tools.allow_always` and in the given
   * state's `tools.allow` — or, with no state, in any **reachable** state's.
   * Naming a target in governance *is* declaring the delegation.
   */
  delegationTargets(state?: string): string[] {
    const targets = new Set<string>();
    const collect = (entries: AllowEntry[]) => {
      for (const entry of entries) {
        const { tool } = normalizeAllowEntry(entry);
        const slug = tool ? workflowSlugFromToolName(tool) : undefined;
        if (slug) targets.add(slug);
      }
    };
    collect(this.allowAlwaysEntries());
    for (const slug of state !== undefined ? [state] : this.reachableStates()) {
      collect(this.allowEntries(slug));
    }
    return [...targets].sort();
  }

  /** Run variables this state must have set before it may be left. */
  requiredVariables(state: string): string[] {
    return this.spec.states[state]?.requires ?? [];
  }

  // --- Tool surface ---------------------------------------------------------------

  private allowEntries(state: string): AllowEntry[] {
    return this.spec.states[state]?.tools?.allow ?? [];
  }

  private allowAlwaysEntries(): AllowEntry[] {
    return this.spec.tools?.allow_always ?? [];
  }

  /**
   * The effective essential set: the built-ins plus the host's `essentialTools`.
   * Unconditional — no property of a workspace or a spec adds to it, and `task`
   * is in it under no circumstances (see {@link UNGRANTABLE_TOOLS}).
   */
  private essentialTools(): Set<string> {
    const tools = new Set(ESSENTIAL_TOOLS);
    for (const tool of this.extraEssential) tools.add(tool);
    return tools;
  }

  /**
   * Every denial entry that applies in `state`: the workflow's `forbid_always`
   * followed by the state's own `forbid`. Order is presentational only — both
   * block, and a denial is evaluated ahead of every grant.
   */
  forbidEntries(state: string): ForbidEntry[] {
    // `validate` builds a machine from a spec whose schema may have failed, so a
    // key can hold anything here; a non-list is nothing rather than a crash.
    return [...list(this.spec.tools?.forbid_always), ...list(this.spec.states[state]?.tools?.forbid)];
  }

  /**
   * The entries that govern `state`, in precedence order — the one derivation
   * enforcement and disclosure both read. A tool is decided by exactly one tier:
   * the state's own entries when they name it (the narrower constraint, even for
   * an essential tool); else the essential grant; else `allow_always`. An
   * `allow_always` entry for a tool the state mentions or that is essential is
   * therefore inert.
   */
  private effectiveEntries(state: string): NormalizedAllowEntry[] {
    const own = this.allowEntries(state).map(normalizeAllowEntry);
    const mentioned = new Set(own.map((e) => e.tool));
    const essential = [...this.essentialTools()]
      .filter((tool) => !mentioned.has(tool))
      .map((tool): NormalizedAllowEntry => ({ tool, argMatchers: null }));
    const always = this.allowAlwaysEntries()
      .map(normalizeAllowEntry)
      .filter((e) => e.tool && !mentioned.has(e.tool) && !this.essentialTools().has(e.tool));
    return [...own, ...essential, ...always];
  }

  /**
   * Whether a tool call is statically permitted in `state`. Closed by default:
   * the always-allowed controls pass; otherwise some effective entry must name
   * the tool and match its arguments.
   */
  checkAllowed(
    state: string,
    tool: string,
    args: Record<string, unknown>,
    ctx?: GuardContext,
  ): boolean {
    if (ALWAYS_ALLOWED_TOOLS.has(tool)) return true;
    return this.effectiveEntries(state).some(
      (entry) =>
        entry.tool === tool &&
        argsSatisfy(entry.argMatchers, args, ctx?.variables, (failure) =>
          ctx?.onUnresolved?.(failure),
        ),
    );
  }

  /**
   * The tool names disclosed to the model while `state` is active: every tool
   * an effective entry names plus the controls (`archmax_advance` omitted for a
   * terminal state, where every call to it would be rejected), minus the tools
   * denied here by name. Name-level only — argument enforcement stays with the
   * kernel at call time.
   */
  disclosedTools(state: string): Set<string> {
    const disclosed = new Set<string>();
    for (const { tool } of this.effectiveEntries(state)) if (tool) disclosed.add(tool);
    if (!this.isTerminal(state)) disclosed.add(ADVANCE_TOOL);
    // Reset, wait and the variable tools are disclosed everywhere, terminal
    // states included: restarting, parking for a reply, and the run's working
    // memory all still apply once a run has answered.
    disclosed.add(RESET_TOOL);
    disclosed.add(WAIT_TOOL);
    disclosed.add(GET_VARIABLES_TOOL);
    disclosed.add(SET_VARIABLES_TOOL);
    // A bare denial removes the tool from the model's picture entirely; a
    // guarded one (`{ tool: write_file, paths: [...] }`) denies only some calls,
    // so the tool stays disclosed and the kernel refuses the call — the same
    // rule the grant side follows for a guarded allow entry.
    for (const entry of this.forbidEntries(state)) {
      const { tool, argMatchers } = normalizeAllowEntry(entry);
      if (tool && !argMatchers) disclosed.delete(tool);
    }
    return disclosed;
  }

  private renderEntry({ tool, argMatchers }: NormalizedAllowEntry): string {
    if (!argMatchers) return tool ?? "";
    const parts = Object.entries(argMatchers)
      .map(([name, globs]) => `${name}=${globs.join("|")}`)
      .join(", ");
    return `${tool}(${parts})`;
  }

  /**
   * Model-facing description of what `checkAllowed` enforces in a state: the
   * effective entries in precedence order, minus any tool denied here by name,
   * then the always-allowed controls the state discloses. A denial that leaves
   * the tool usable for other arguments (a guarded entry) leaves it listed —
   * the same line disclosure draws — so the model's picture matches enforcement
   * either way.
   */
  describeAllowed(state: string): string {
    const denied = new Set<string>();
    for (const entry of this.forbidEntries(state)) {
      const { tool, argMatchers } = normalizeAllowEntry(entry);
      if (tool && !argMatchers) denied.add(tool);
    }
    const parts = this.effectiveEntries(state)
      .filter(({ tool }) => !tool || !denied.has(tool))
      .map((entry) => this.renderEntry(entry));
    const disclosed = this.disclosedTools(state);
    for (const tool of ALWAYS_ALLOWED_TOOLS) if (disclosed.has(tool)) parts.push(tool);
    return parts.join(", ");
  }

  /**
   * Model-facing lines describing the argument constraints that bind in a
   * state, rendered through the same resolver the kernel enforces with so an
   * unresolved reference is shown as unresolved-and-named rather than as a
   * placeholder the model might pass literally. Empty when none bind.
   */
  describeArgConstraints(state: string, variables: VariableStore = {}): string[] {
    const lines: string[] = [];
    for (const { tool, argMatchers } of this.effectiveEntries(state)) {
      if (!tool || !argMatchers) continue;
      const constraints = Object.entries(argMatchers)
        .map(([name, globs]) => {
          const rendered = globs.map((g) => describeGlob(g, variables));
          return rendered.length > 1
            ? `${name} must match one of: ${rendered.map((g) => `'${g}'`).join(", ")}`
            : `${name} must match '${rendered[0]}'`;
        })
        .join(" and ");
      lines.push(`- ${tool}: ${constraints}`);
    }
    return lines;
  }

  // --- Triggers -------------------------------------------------------------------

  /**
   * Every trigger the spec declares, read from the states that declare them —
   * computed once per machine.
   */
  triggerBindings(): Map<string, TriggerBinding> {
    this.bindingsCache ??= triggerBindings(this.spec);
    return this.bindingsCache;
  }

  /** The declared start states as `{ trigger, state }` pairs, in declaration order. */
  startStates(): { trigger: string; state: string }[] {
    return [...this.triggerBindings().values()].map((binding) => ({
      trigger: binding.id,
      state: binding.entry,
    }));
  }

  /**
   * The state a trigger enters, or `undefined` for an id no state declares.
   * `manual` is the one entry for every ingress — the CLI, an SDK invocation
   * naming no trigger, a host firing that names it, and a delegation.
   */
  startStateForTrigger(id: string): string | undefined {
    return this.triggerBindings().get(id)?.entry;
  }

  /** The session path declared for a trigger, if it declares one. */
  sessionPathForTrigger(id: string): SessionPath | undefined {
    return this.triggerBindings().get(id)?.session;
  }

  /**
   * The host-resolved `message:` declaration for a trigger: the parsed path,
   * `false` for "firings carry no message", or `undefined` when undeclared.
   */
  messagePathForTrigger(id: string): SessionPath | false | undefined {
    return this.triggerBindings().get(id)?.message;
  }

  /** The host-resolved `connection:` slug declared for a trigger, if any. */
  connectionForTrigger(id: string): string | undefined {
    return this.triggerBindings().get(id)?.connection;
  }

  /** The run variables a firing of this trigger must supply, if declared. */
  requiresForTrigger(id: string): string[] | undefined {
    return this.triggerBindings().get(id)?.requires;
  }

  /**
   * The run variables a run started through this trigger guarantees are set when
   * it completes, if declared — the only variables that cross a sub-run boundary
   * upward.
   */
  returnsForTrigger(id: string): string[] | undefined {
    return this.triggerBindings().get(id)?.returns;
  }

  /**
   * A trigger's whole signature, normalized: its caller-facing `description` and
   * both lists as `{ name, type?, description? }` entries in declaration order;
   * `undefined` for an id no state declares. The reading `signatureForTrigger`
   * gives over the spec, computed once per trigger.
   */
  signatureForTrigger(id: string): TriggerSignature | undefined {
    if (!this.signatureCache.has(id)) this.signatureCache.set(id, signatureForTrigger(this.spec, id));
    return this.signatureCache.get(id);
  }
}

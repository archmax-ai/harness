/**
 * Triggers: the ids a state declares it is entered by, and what each of those
 * declarations says — where its firings map to a session, its host-resolved
 * keys, its `requires`/`returns` signature. A trigger is declared in one place,
 * the `triggers:` mapping of the state it enters, so there is nothing to merge.
 *
 * Shape is the schema's business (`spec-schema.ts`); this module reads a spec
 * the schema has already accepted and answers the questions the runtime asks.
 */
import { resolvePath, VARIABLE_NAME_PATTERN } from "./variables.js";
import type { MachineSpec, MachineState } from "./types.js";
import type { WorkflowMachine } from "./machine.js";

/**
 * The one reserved trigger id: the entry at which a machine is **started** by
 * the CLI, an SDK invocation naming no trigger, a host firing that names it, or
 * a delegation from another workflow.
 */
export const MANUAL_TRIGGER = "manual";

// --- A state's own `triggers:` ----------------------------------------------

/**
 * The trigger ids a state declares, in declaration order: the keys of its
 * `triggers:` mapping. The single interpretation point — nothing else narrows
 * {@link MachineState.triggers} by hand.
 */
export function stateTriggerIds(state: MachineState): string[] {
  return Object.keys(state.triggers ?? {});
}

// --- Session paths -----------------------------------------------------------

/** A parsed session path: the variable it reads, plus the steps into its value. */
export interface SessionPath {
  /** Source text, for diagnostics. */
  raw: string;
  /** The variable name (first segment). */
  name: string;
  /** Remaining dotted segments; empty for a whole-variable reference. */
  path: string[];
}

export type SessionPathParse = { path: SessionPath; error?: undefined } | { path?: undefined; error: string };

/**
 * Parse a dotted session path (`conversation_id`, `triggers.-1.conversationId`).
 * A `${{…}}`-wrapped value is refused rather than unwrapped, so there is one
 * spelling. `error` is the reason, worded for whoever wrote the path.
 */
export function parseSessionPath(value: string): SessionPathParse {
  const raw = value.trim();
  if (raw === "") return { error: "it is empty." };
  if (raw.includes("${{")) {
    return { error: "write the bare path, not a '${{…}}' reference (e.g. 'conversation_id')." };
  }
  const [name, ...path] = raw.split(".");
  if (!name || !VARIABLE_NAME_PATTERN.test(name)) {
    return {
      error:
        "its first segment must be a variable name (lowercase letters, digits and underscores, starting with a letter).",
    };
  }
  if (path.some((segment) => segment === "")) {
    return { error: "it has an empty segment — check for a doubled or trailing '.'." };
  }
  return { path: { raw, name, path } };
}

/**
 * Resolve a session path against a firing's variables. Returns the id as a
 * string (a number is stringified) or `undefined` when the path misses or
 * resolves to something that cannot name a conversation — the caller falls back
 * to the run's native session id.
 */
export function resolveSessionId(
  path: SessionPath,
  variables: Record<string, unknown>,
): string | undefined {
  if (!Object.hasOwn(variables, path.name)) return undefined;
  const root = variables[path.name];
  const value = path.path.length === 0 ? root : resolvePath(root, path.path);
  if (typeof value === "string") return value.trim() === "" ? undefined : value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

// --- The declared view -------------------------------------------------------

/** A trigger's declaration, read: the state it enters plus its declared keys. */
export interface TriggerBinding {
  id: string;
  /** The start state — the state whose `triggers:` declares this id. */
  entry: string;
  session?: SessionPath;
  /**
   * The host-resolved `message:` declaration: a parsed path, or `false` for a
   * trigger whose firings carry no message. Absent when undeclared.
   */
  message?: SessionPath | false;
  /** The host-resolved `connection:` slug, opaque to the SDK. */
  connection?: string;
  /** Run variables a firing must supply for the run to start, if declared. */
  requires?: string[];
  /** Run variables the run guarantees are set when it completes, if declared. */
  returns?: string[];
}

/**
 * Every trigger the spec declares, read from the states that declare them: one
 * walk, in declaration order, with the state each id sits on as its entry. Two
 * states declaring one id is a document-level error (`refineSpec`); here the
 * later one wins, so the map is total either way.
 */
export function triggerBindings(spec: MachineSpec): Map<string, TriggerBinding> {
  const byId = new Map<string, TriggerBinding>();
  for (const [slug, state] of Object.entries(spec.states)) {
    for (const [id, decl] of Object.entries(state.triggers ?? {})) {
      const binding: TriggerBinding = { id, entry: slug };
      if (decl) {
        if (decl.session !== undefined) {
          const parsed = parseSessionPath(decl.session);
          if (parsed.path) binding.session = parsed.path;
        }
        if (decl.message === false) {
          binding.message = false;
        } else if (decl.message !== undefined) {
          const parsed = parseSessionPath(decl.message);
          if (parsed.path) binding.message = parsed.path;
        }
        if (decl.connection !== undefined) binding.connection = decl.connection.trim();
        if (decl.requires !== undefined) binding.requires = decl.requires;
        if (decl.returns !== undefined) binding.returns = decl.returns;
      }
      byId.set(id, binding);
    }
  }
  return byId;
}

/**
 * Every variable a declaration says will exist: any state's `requires`, and any
 * trigger's. Half of the "is this guard reference guaranteed?" question (the
 * other half is the host's seeded variables).
 */
export function declaredVariableNames(spec: MachineSpec): Set<string> {
  const names = new Set<string>();
  for (const state of Object.values(spec.states)) {
    for (const name of state.requires ?? []) names.add(name);
  }
  for (const binding of triggerBindings(spec).values()) {
    for (const name of binding.requires ?? []) names.add(name);
  }
  return names;
}

/**
 * The session id a firing of `triggerId` resolves to under `spec`, or `undefined`
 * when the trigger declares no `session:` path, is not declared at all, or the
 * path misses in `variables` — in each of which the runtime mints an id for the
 * firing instead. The two halves are {@link triggerBindings} and
 * {@link resolveSessionId}; this is the question a host actually asks.
 */
export function sessionIdForTrigger(
  spec: MachineSpec,
  triggerId: string,
  variables: Record<string, unknown>,
): string | undefined {
  const path = triggerBindings(spec).get(triggerId)?.session;
  return path ? resolveSessionId(path, variables) : undefined;
}

// --- Resolving a trigger against a machine -----------------------------------------

/**
 * How a session is started: a trigger `id`, and nothing else. The trigger
 * selects the start state; the session's input arrives as variables.
 */
export interface TriggerInput {
  /** Trigger id: `manual` (CLI/Deep Agent) or a tool/event name. */
  id: string;
}

/** A resolved trigger: the requested id plus the start state it enters. */
export interface ResolvedTrigger extends TriggerInput {
  /** The machine state the session begins in for this trigger. */
  startState: string;
}

/** The default trigger when none is supplied to `createAgent`: the reserved `manual` entry. */
export const DEFAULT_TRIGGER_ID = MANUAL_TRIGGER;

/**
 * Thrown when a trigger `id` matches no start state declared by the workflow
 * (no state whose `trigger` equals the id, and no `triggers` entry naming one).
 * Fails closed rather than entering an arbitrary state.
 */
export class UnknownTriggerError extends Error {
  constructor(
    readonly triggerId: string,
    readonly available: string[],
  ) {
    super(
      `No start state for trigger '${triggerId}'. ` +
        (available.length
          ? `Declared triggers: ${available.join(", ")}.`
          : `The workflow declares no start-state triggers.`),
    );
    this.name = "UnknownTriggerError";
  }
}

/**
 * Resolve a trigger against a machine's declared start states: map the trigger
 * `id` (default `manual`) to the state whose `trigger` equals it. Throws
 * {@link UnknownTriggerError} when no start state declares the id. The single
 * resolution point shared by the CLI and programmatic callers.
 */
export function resolveTrigger(
  machine: Pick<WorkflowMachine, "startStateForTrigger" | "startStates">,
  trigger?: TriggerInput,
): ResolvedTrigger {
  const id = trigger?.id ?? DEFAULT_TRIGGER_ID;
  const startState = machine.startStateForTrigger(id);
  if (!startState) {
    throw new UnknownTriggerError(
      id,
      machine.startStates().map((s) => s.trigger),
    );
  }
  return { id, startState };
}

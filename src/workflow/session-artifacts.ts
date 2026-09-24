import { createWorkflowEventEmitter, type WorkflowEventHandler } from "../core/events.js";
import type { Workspace } from "../core/workspace.js";
import type { WorkflowMachine } from "../machine/machine.js";
import type { VariableStore } from "../machine/variables.js";
import type { ResolvedRuntimeContract } from "../runtime/contract.js";
import type { UsageSummary } from "../core/usage.js";
import { runArtifactPaths } from "./paths.js";
import type { TrailStep } from "./state.js";

export type { IntrospectableGraph } from "../core/deepagents.js";
import type { IntrospectableGraph } from "../core/deepagents.js";

/** Machine-readable snapshot of a run's topology (`graph.json`). */
export interface SerializedGraph {
  nodes: string[];
  edges: { source: string; target: string; conditional: boolean; label?: string }[];
  entry?: string;
  finals: string[];
  mermaid: string;
}

export interface MessageItem {
  kind: "message";
  role: string;
  content: string;
}

export interface ToolCallItem {
  kind: "tool_call";
  name: string;
  args: unknown;
  /** Tool result text, or null if it was not observed within this stretch. */
  result: string | null;
}

export type TrajectoryItem = MessageItem | ToolCallItem;

/** One state's stretch of a turn, with the activity produced while active. */
export interface TrajectorySegment {
  state: string;
  enteredState?: string;
  exitedState?: string;
  items: TrajectoryItem[];
}

/** Ordered, state-grouped record of everything the agent did during a session. */
export interface Trajectory {
  sessionId?: string;
  workflow: string;
  prompt?: string;
  finalAnswer: string;
  segments: TrajectorySegment[];
}

/** Session metadata recorded so a historical session stays interpretable after the SDK evolves. */
export interface RunMetadata {
  runtimeContract: ResolvedRuntimeContract;
  packageVersion: string;
  /** The `specHash` that governed this run, resolvable via `readSpecSnapshot`. Absent for a plain agent. */
  specHash?: string;
  /** Token accounting, plus `costUsd` when the model is priced. Absent when no usage was reported. */
  usage?: UsageSummary;
}

const START_IDS = new Set(["__start__", "START"]);
const END_IDS = new Set(["__end__", "END"]);

/** Serialize a compiled LangGraph runnable's topology — the plain agent's graph, which has no machine. */
export async function serializeGraph(graph: IntrospectableGraph): Promise<SerializedGraph> {
  const g = await graph.getGraphAsync({});
  const nodes = Object.values(g.nodes).map((n) => n.id);
  const edges = g.edges.map((e) => ({
    source: e.source,
    target: e.target,
    conditional: e.conditional === true,
    ...(e.data ? { label: e.data } : {}),
  }));
  const entry = edges.find((e) => START_IDS.has(e.source))?.target;
  const finals = edges.filter((e) => END_IDS.has(e.target)).map((e) => e.source);
  return { nodes, edges, entry, finals, mermaid: g.drawMermaid() };
}

function mermaidId(slug: string): string {
  return slug.replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * Serialize the machine's own topology: states, declared transitions (labelled
 * with their descriptions), each `on_error` route as a conditional edge, and one
 * start edge per declared trigger. Derived from the spec, never from a compiled
 * graph, so it cannot disagree with what was enforced.
 */
export function serializeMachineGraph(machine: WorkflowMachine): SerializedGraph {
  const states = Object.keys(machine.spec.states);
  const edges: SerializedGraph["edges"] = [];
  for (const { trigger, state } of machine.startStates()) {
    edges.push({ source: "__start__", target: state, conditional: true, label: trigger });
  }
  for (const slug of states) {
    for (const transition of machine.spec.states[slug]?.transitions ?? []) {
      edges.push({
        source: slug,
        target: transition.to,
        conditional: false,
        ...(transition.description ? { label: transition.description } : {}),
      });
    }
    const errorTarget = machine.onError(slug);
    if (errorTarget) edges.push({ source: slug, target: errorTarget, conditional: true, label: "on_error" });
  }
  const finals = states.filter((slug) => machine.isTerminal(slug));
  const lines = ["graph TD;"];
  for (const slug of states) {
    const kind = machine.isHumanState(slug) ? `{{${slug}}}` : `[${slug}]`;
    lines.push(`  ${mermaidId(slug)}${kind};`);
  }
  for (const edge of edges) {
    const source = edge.source === "__start__" ? "__start__" : mermaidId(edge.source);
    const arrow = edge.conditional ? "-.->" : "-->";
    const label = edge.label ? `|${edge.label.replace(/\|/g, "/")}|` : "";
    lines.push(`  ${source} ${arrow}${label} ${mermaidId(edge.target)};`);
  }
  return {
    nodes: ["__start__", ...states],
    edges,
    entry: machine.entry,
    finals,
    mermaid: `${lines.join("\n")}\n`,
  };
}

/** The machine's topology as one log line per state, for the `graph-topology` diagnostic. */
export function describeMachineTopology(machine: WorkflowMachine): string {
  const starts = machine.startStates();
  const startLabel = starts.length
    ? starts.map((s) => `${s.state} (${s.trigger})`).join(" | ")
    : machine.entry;
  const lines = [`START -> ${startLabel}`];
  for (const slug of Object.keys(machine.spec.states)) {
    const targets = machine.transitionTargets(slug);
    const rhs = targets.length ? targets.join(" | ") : "END";
    const kind = machine.isHumanState(slug) ? " [human]" : "";
    lines.push(`${slug}${kind} -> ${rhs}`);
  }
  return lines.join("\n  ");
}

/** One variable as recorded in `variables.json`. */
export interface RecordedVariable {
  value: unknown;
  locked: boolean;
}

/**
 * The store as recorded: value and `locked` only. `locked` is the attribution —
 * a locked entry can only come from the host, an unlocked one only from the
 * agent. The in-flight `reseed` marker is dropped: it describes one update's
 * authority within a reducer, never session state.
 */
function recordedVariables(store: VariableStore): Record<string, RecordedVariable> {
  return Object.fromEntries(
    Object.entries(store).map(([name, entry]) => [name, { value: entry.value, locked: entry.locked }]),
  );
}

/**
 * Persist the session's graph, trajectory, audit trail and variables under
 * `<sessionId>/artifacts/`. An absent trail means "unreadable", an empty one "no
 * transitions"; an empty variable store is still written for the same reason.
 * Best-effort: a write failure is a `warning` event and `null`.
 */
export async function writeRunArtifacts(
  workspace: Workspace,
  workflow: string,
  sessionId: string,
  artifacts: {
    graph: SerializedGraph;
    trajectory: Trajectory;
    metadata?: RunMetadata;
    trail?: TrailStep[];
    variables?: VariableStore;
  },
  onEvent?: WorkflowEventHandler,
): Promise<string | null> {
  const paths = runArtifactPaths(sessionId);
  const trajectory: Trajectory = { ...artifacts.trajectory, sessionId };
  try {
    // Independent files, written concurrently: one round trip on a remote session store.
    await Promise.all([
      workspace.writeJson(paths.graphJson, artifacts.graph),
      workspace.writeText(paths.graphMermaid, `${artifacts.graph.mermaid}\n`),
      workspace.writeJson(paths.trajectoryJson, trajectory),
      ...(artifacts.metadata
        ? [workspace.writeJson(paths.metadataJson, { sessionId, workflow, ...artifacts.metadata })]
        : []),
      ...(artifacts.trail
        ? [workspace.writeJson(paths.trailJson, { sessionId, workflow, steps: artifacts.trail })]
        : []),
      ...(artifacts.variables !== undefined
        ? [
            workspace.writeJson(paths.variablesJson, {
              sessionId,
              workflow,
              variables: recordedVariables(artifacts.variables),
            }),
          ]
        : []),
    ]);
    return paths.runDir;
  } catch (err) {
    createWorkflowEventEmitter(onEvent)({
      type: "warning",
      scope: "run-artifacts",
      message: `failed to write artifacts for session '${sessionId}': ${(err as Error).message}`,
    });
    return null;
  }
}

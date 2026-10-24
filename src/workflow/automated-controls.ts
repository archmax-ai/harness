/**
 * The controls an automated state calls — `archmax_advance`, `archmax_raise`,
 * `archmax_get_variables`, `archmax_set_variables`, and for a grader
 * `archmax_get_history` — as real tools bound to one run's **step recorder**.
 *
 * The session's agent's controls are declarations serviced in `wrapToolCall`,
 * where checkpointed state is in hand. An automated state calls its tools from a
 * script or from a grader's own agent, outside the session's tool node, so its
 * controls are tools whose bodies do the work: against the recorder's live view
 * of the session, with the agent path's schemas, handlers and transition rules.
 * Each is wrapped by the PTC gateway like the state's other tools, so the kernel
 * decides every call, a forbid can deny one, and every call emits its pair of
 * tool events.
 *
 * Nothing here commits: the recorder holds the run's one decision and its
 * variable writes, and the run's outcome carries them to the commit when it
 * settles. A refused call throws its reason, which a script can catch and a
 * grader reads as its tool's error answer.
 */
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredTool } from "@langchain/core/tools";
import { tool } from "langchain";
import type { WorkflowEventEmitter } from "../core/events.js";
import type { MountPrefixes } from "../core/mounts.js";
import type { WorkflowMachine } from "../machine/machine.js";
import {
  ADVANCE_TOOL,
  GET_HISTORY_TOOL,
  GET_VARIABLES_TOOL,
  RAISE_TOOL,
  SET_VARIABLES_TOOL,
} from "../machine/tool-names.js";
import { TITLE_VARIABLE, type VariableStore } from "../machine/variables.js";
import {
  advanceEvidence,
  advanceSchema,
  fileReturnsRefusal,
  getVariablesSchema,
  handleGetVariables,
  handleSetVariables,
  raiseSchema,
  setVariablesSchema,
  transitionRefusal,
} from "./control-tools.js";
import type { SessionHistory } from "./history.js";
import type { FileValueCheck } from "./signature-checks.js";
import { mergeVariables, readVariables } from "./state.js";
import { z } from "zod";

/** The one decision an automated state's run made: a move, or the end of the session. */
export type AutomatedDecision =
  | { kind: "advance"; to: string; reason: string; evidence: string[]; callId?: string }
  | { kind: "raise"; code: string; reason: string; callId?: string };

/**
 * One automated run's record of what it decided and wrote. The **live view** is
 * the checkpointed session with this run's writes merged in, so a later call of
 * the same run — a `requires` check, a read, a guard — sees an earlier write.
 */
export interface StepRecorder {
  /** The state this run is in. */
  readonly state: string;
  /** The session's variables as this run sees them now: the store plus its own writes. */
  store(): VariableStore;
  /** The checkpointed session with {@link store} in place of its variables. */
  view(): unknown;
  /** This run's variable writes, to commit with its outcome. */
  readonly delta: VariableStore;
  /** The run's decision, once one was accepted. */
  readonly decision: AutomatedDecision | undefined;
}

/** A recorder the controls may write to. */
interface MutableRecorder extends StepRecorder {
  decide(decision: AutomatedDecision): void;
  write(delta: VariableStore): void;
}

/**
 * The recorder for one run of `state` over the checkpointed `session`.
 * `onWrite` is told the new live store after every accepted write — the gateway
 * re-reads its guards against it.
 */
export function createStepRecorder(
  state: string,
  session: unknown,
  onWrite?: (store: VariableStore) => void,
): MutableRecorder {
  let store = readVariables(session);
  let delta: VariableStore = {};
  let decision: AutomatedDecision | undefined;
  return {
    state,
    store: () => store,
    view: () => ({ ...(session as object), variables: store }),
    get delta() {
      return delta;
    },
    get decision() {
      return decision;
    },
    decide(next) {
      decision = next;
    },
    write(written) {
      delta = mergeVariables(delta, written);
      store = mergeVariables(store, written);
      onWrite?.(store);
    },
  };
}

export interface AutomatedControlsContext {
  machine: WorkflowMachine;
  emit: WorkflowEventEmitter;
  mountPrefixes: MountPrefixes;
  /** The `file` type's runtime check for a session in a state; omitted, a `file` value is held to its shape alone. */
  files?: (state: string, variables: VariableStore) => FileValueCheck;
}

/** The call id a governed call was made under, which the gateway hands every tool it invokes. */
function callIdOf(config: unknown): string | undefined {
  const id = (config as RunnableConfig & { toolCallId?: unknown } | undefined)?.toolCallId;
  return typeof id === "string" && id ? id : undefined;
}

/** Why a second decision is refused, naming the one that stands. */
function alreadyDecided(name: string, decision: AutomatedDecision): Error {
  const standing =
    decision.kind === "advance"
      ? `it already moves the session to '${decision.to}'`
      : `it already ends the session ('${decision.code}')`;
  return new Error(`${name} rejected: this state has decided — ${standing}. One decision per state.`);
}

/**
 * The control tools for one automated run, bound to its recorder — in the order
 * `controlTools(state)` names them, so the surface and the tools agree. A grader
 * gets `archmax_get_history` over `history`; a code state receives the same
 * history as its input and has no such tool.
 */
export function createAutomatedControls(
  ctx: AutomatedControlsContext,
  recorder: MutableRecorder,
  opts: { history?: SessionHistory } = {},
): StructuredTool[] {
  const { machine, emit } = ctx;
  const { state } = recorder;
  const offered = machine.controlTools(state);
  const terminal = machine.isTerminal(state);
  const tools: StructuredTool[] = [];

  if (offered.has(ADVANCE_TOOL) && !terminal) {
    tools.push(
      tool(
        async (input: z.infer<typeof advanceSchema>, config) => {
          if (recorder.decision) throw alreadyDecided(ADVANCE_TOOL, recorder.decision);
          const evidence = advanceEvidence(machine, input.to, input.evidence ?? [], ctx.mountPrefixes);
          if (!evidence.ok) throw new Error(`${ADVANCE_TOOL} rejected: ${evidence.reason}`);
          const refused = transitionRefusal(machine, state, input.to, recorder.store());
          if (refused) throw new Error(`${ADVANCE_TOOL} rejected: ${refused}`);
          const callId = callIdOf(config);
          recorder.decide({
            kind: "advance",
            to: input.to,
            reason: input.reason,
            evidence: evidence.paths,
            ...(callId ? { callId } : {}),
          });
          return `Decision recorded: the session moves to '${input.to}' when this state finishes. Stop now.`;
        },
        {
          name: ADVANCE_TOOL,
          description:
            "Move the session along one of this state's transitions: `to` is the target's slug, " +
            "`reason` is what the next state reads about why it was entered. The move takes " +
            "effect when this state finishes. Call it once.",
          schema: advanceSchema,
        },
      ) as unknown as StructuredTool,
    );
  }

  if (offered.has(RAISE_TOOL)) {
    tools.push(
      tool(
        async (input: z.infer<typeof raiseSchema>, config) => {
          if (recorder.decision) throw alreadyDecided(RAISE_TOOL, recorder.decision);
          const callId = callIdOf(config);
          recorder.decide({ kind: "raise", code: input.code, reason: input.reason, ...(callId ? { callId } : {}) });
          return `Decision recorded: the session ends as failed ('${input.code}') when this state finishes. Stop now.`;
        },
        {
          name: RAISE_TOOL,
          description:
            "End the session as a failure: the work cannot be accepted and must not be retried. " +
            "`code` is a short token the session's host reads, `reason` what failed. Call it once, " +
            "instead of advancing.",
          schema: raiseSchema,
        },
      ) as unknown as StructuredTool,
    );
  }

  if (offered.has(GET_VARIABLES_TOOL)) {
    tools.push(
      tool(
        async (input: z.infer<typeof getVariablesSchema>) => {
          const reply = handleGetVariables({ toolCallId: "", args: input, state: recorder.view() });
          const text = typeof reply.content === "string" ? reply.content : JSON.stringify(reply.content);
          if (reply.status === "error") throw new Error(text);
          return text;
        },
        {
          name: GET_VARIABLES_TOOL,
          description:
            "Read the session's variables. Omit `name` for all of them; pass `path` to drill into a " +
            "structured value.",
          schema: getVariablesSchema,
        },
      ) as unknown as StructuredTool,
    );
  }

  if (offered.has(SET_VARIABLES_TOOL)) {
    tools.push(
      tool(
        async (input: z.infer<typeof setVariablesSchema>, config) => {
          const view = recorder.view();
          const fileRefusal = ctx.files
            ? await fileReturnsRefusal(machine, view, input, ctx.files(state, recorder.store()))
            : undefined;
          const outcome = handleSetVariables({ toolCallId: "", args: input, state: view }, machine, fileRefusal);
          const text =
            typeof outcome.message.content === "string" ? outcome.message.content : JSON.stringify(outcome.message.content);
          if (!outcome.delta) throw new Error(text);
          recorder.write(outcome.delta);
          const callId = callIdOf(config);
          emit({
            type: "variables-set",
            state,
            names: outcome.written ?? [],
            locked: outcome.locked === true,
            ...(callId ? { callId } : {}),
          });
          const title = outcome.delta[TITLE_VARIABLE]?.value;
          if (typeof title === "string") emit({ type: "title-set", title, state, ...(callId ? { callId } : {}) });
          return text;
        },
        {
          name: SET_VARIABLES_TOOL,
          description:
            "Record facts for the rest of the session; values may be structured. Pass `lock: true` to " +
            "make one permanent. Writing a locked variable is refused.",
          schema: setVariablesSchema,
        },
      ) as unknown as StructuredTool,
    );
  }

  if (offered.has(GET_HISTORY_TOOL) && opts.history) {
    const history = opts.history;
    tools.push(
      tool(async () => JSON.stringify(history, null, 2), {
        name: GET_HISTORY_TOOL,
        description:
          "Read the session's whole history: `messages` (every message so far, oldest first — " +
          "`role` is user, assistant, tool, system or runtime; a tool result's text is in `toolCalls`), " +
          "`trail` (every state the session entered, with how and why) and `toolCalls` (every tool call " +
          "with its arguments, result, status, and the state and visit that made it).",
        schema: z.object({}),
      }) as unknown as StructuredTool,
    );
  }

  return tools;
}

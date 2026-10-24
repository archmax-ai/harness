import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredTool } from "@langchain/core/tools";
import type { WorkflowEventEmitter } from "../core/events.js";
import { findMock, mockPayload, readMocks } from "../core/tool-mocks.js";
import { HARNESS_CONTROL_TOOLS, isWorkflowToolName } from "../machine/tool-names.js";
import { SubWorkflowError, subWorkflowParkOf } from "../workflow/sub-workflow.js";
import { toolCallDetail, toolOutputPreview } from "../core/tool-telemetry.js";
import { decide, PTC_EXCLUDED_TOOLS, type GovernanceRule, type ToolCallOrigin } from "../kernel/kernel.js";
import type { WorkflowMachine } from "../machine/machine.js";
import type { VariableStore } from "../machine/variables.js";
import { NO_MOUNTS, type MountPrefixes } from "../core/mounts.js";
import { NO_SKILLS, type SkillPrefixes } from "../core/skills.js";
import { REDACTED_TOOLS, redactDisabledSkills } from "../core/skill-redact.js";

/**
 * Governance and telemetry for tool calls made outside the agent's tool node:
 * the `tools.*` namespace sandbox scripts call, and an automated state's tools.
 *
 * The sandbox bridge (and a grader's own agent) calls `invoke(input)` on a tool
 * directly, bypassing the session's tool node and `wrapToolCall`, so the
 * gateway hands it *wrapped* tools: each runs the kernel `decide()` pipeline
 * against the session's live state, emits the same tool events, honours
 * declarative mocks and forwards the turn's `RunnableConfig` before delegating
 * to the real tool. One wrap covers every such consumer — the agent's
 * `archmax_eval`/`archmax_run` code, a code state's script, and a grader.
 *
 * A script's call (`script` origin) is governed exactly as the model's own: the
 * run's variables — refreshed per model call — resolve the state's `${{name}}`
 * argument guards, so a guard admits from a script exactly what it admits from
 * the model. No `${{…}}` substitution is applied here: a script passes computed
 * values and reads the variables as `args.variables`, so such text is ordinary
 * data and passes through verbatim. A grader's calls (`agent` origin) are
 * substituted by the grader itself before they reach the gateway, as the
 * session's agent's are in `wrapToolCall`.
 */

/**
 * The live call context for one session's wrapped tools. A QuickJS session
 * freezes its injected tool set at first eval but outlives many calls across
 * several workflow states, so the wrapped tools close over this object and read
 * it per call. Invariant: one context per session, mutated in place by
 * {@link PtcToolGateway.refresh} at the start of every turn and never replaced,
 * or the frozen tools would keep reading a stale one. The abort signal and tool
 * mocks travel inside `config`, so there is exactly one thing to keep current.
 */
export interface PtcCallContext {
  /** The workflow state a call made right now is governed against. */
  state: string;
  /** Runtime config forwarded to the underlying tool (session id, signal, store). */
  config: RunnableConfig;
  /**
   * Whether the turn in force is reply-only (the run parked, nothing to produce
   * but text). Enforced here as well as at the model's surface: a script from
   * an earlier turn keeps its tools, and "a parked run may speak, never act"
   * must hold on every path to a tool.
   */
  replyOnly?: boolean;
  /**
   * The run's variables at the turn's model call, as checkpointed: what the
   * state's `${{name}}` guards resolve against. Absent means none are set — a
   * guard that references one is then unevaluable and refuses the call.
   */
  variables?: VariableStore;
}

export interface PtcWrapOptions {
  /** Who calls these tools: a script, or a grader's model. Both are governed against the live state. */
  origin: Extract<ToolCallOrigin, "script" | "agent">;
  /** The session whose live context these tools read on every call. */
  sessionId: string;
}

export interface PtcToolGateway {
  /**
   * Wrap a resolved PTC tool surface. The returned tools are drop-in
   * replacements — same `name`, `description`, and schema — so the sandbox
   * bridge's own naming (it camel-cases `name`, and special-cases `read_file`)
   * behaves exactly as it did with the raw tools.
   */
  wrap(tools: StructuredTool[], opts: PtcWrapOptions): StructuredTool[];
  /**
   * Point a session's live context at the current turn. Called once per model
   * call, before any script can run, so tools wrapped in an earlier turn read
   * the state committed for this one.
   */
  refresh(sessionId: string, next: PtcCallContext): void;
  /**
   * The tool names an agent script lists under `tools` right now: the state its
   * calls are governed against, disclosed as the model's own tool list is, minus
   * the names never on the bridge. Read from the same live context every wrapped
   * tool decides by, so what a script sees and what it may do cannot disagree.
   */
  surface(sessionId: string): readonly string[];
  /** Drop a session's context (its wrapped tools go with the session). */
  release(sessionId: string): void;
}

/**
 * A PTC call the kernel refused. Thrown so the sandbox bridge rejects the
 * script's promise: fail-closed (the underlying tool never runs) but catchable,
 * so a script can handle the refusal instead of dying on it.
 */
export class PtcGovernanceError extends Error {
  constructor(
    readonly tool: string,
    readonly ruleId: string,
    reason: string,
  ) {
    super(reason);
    this.name = "PtcGovernanceError";
  }
}

export interface PtcToolGatewayOptions {
  machine: WorkflowMachine;
  /** Consumer governance rules, applied to PTC calls exactly as to agent calls. */
  policyRules?: GovernanceRule[];
  /** The workspace's resolved mount keys, for the kernel's read-only rule. */
  mountPrefixes?: MountPrefixes;
  /**
   * The workspace's resolved skill bundles, for the kernel's skill rule. Every
   * call through the gateway runs on the model's authority, so the state's
   * enabled set binds it.
   */
  skills?: SkillPrefixes;
  emit: WorkflowEventEmitter;
}

/**
 * Filter a listing a script or a grader asked for to the state's enabled skills —
 * the gateway's half of the invisibility rule the governance middleware applies
 * to the model's own calls, since `tools.ls` inside `archmax_eval` reaches the
 * same tool by another door.
 */
function redactPtcListing(
  result: unknown,
  enabled: readonly string[],
  skills: SkillPrefixes,
  tool: string,
): unknown {
  if (skills.length === 0 || !REDACTED_TOOLS.has(tool)) return result;
  if (typeof result !== "string") return result;
  return redactDisabledSkills(result, enabled, skills);
}

/** Normalize whatever the sandbox passed as tool input to a governable args object. */
function toArgs(input: unknown): Record<string, unknown> {
  return input != null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

export function createPtcToolGateway(opts: PtcToolGatewayOptions): PtcToolGateway {
  const { machine, policyRules = [], mountPrefixes = NO_MOUNTS, skills = NO_SKILLS, emit } = opts;
  const contexts = new Map<string, PtcCallContext>();
  // The machine is fixed for the gateway's life, so a state's surface is too.
  const surfaces = new Map<string, readonly string[]>();
  let callSeq = 0;
  const skillSlugs = skills.map((skill) => skill.slug);
  const redactSkills = (result: unknown, state: string, tool: string) =>
    redactPtcListing(result, machine.enabledSkills(state, skillSlugs), skills, tool);

  /** The session's stable context ref, created on first use. */
  function contextFor(sessionId: string): PtcCallContext {
    let context = contexts.get(sessionId);
    if (!context) {
      context = { state: machine.entry, config: {} };
      contexts.set(sessionId, context);
    }
    return context;
  }

  function governedInvoke(
    inner: StructuredTool,
    origin: PtcWrapOptions["origin"],
    context: PtcCallContext,
  ): (input: unknown, config?: RunnableConfig) => Promise<unknown> {
    return async (input: unknown, config?: RunnableConfig) => {
      const tool = inner.name;
      const args = toArgs(input);
      // Read per call, not per wrap: the session's tool set is frozen but the
      // workflow state behind it moves with every `archmax_advance`.
      const { state, config: contextConfig, replyOnly, variables = {} } = context;
      const callId = `ptc:${++callSeq}`;
      // The tool events mark a programmatic call; a grader's is a model's call, as the agent's is.
      const marked = origin === "script" ? { origin } : {};

      const verdict = decide(
        machine,
        { kind: "tool-call", state, tool, args, origin, ...(replyOnly ? { replyOnly } : {}) },
        policyRules,
        mountPrefixes,
        variables,
        skills,
      );
      if (verdict.decision === "block") {
        const reason = verdict.reason ?? `'${tool}' is not allowed in state '${state}'.`;
        // Gated on `warn` for parity with the agent path, where a non-warn
        // block (the inline-`eval` refusal) is deliberately silent.
        if (verdict.warn) {
          emit({ type: "tool-blocked", state, tool, reason, callId, args, ...marked });
        }
        throw new PtcGovernanceError(tool, verdict.ruleId, reason);
      }

      const detail = toolCallDetail(args);
      emit({
        type: "tool-called",
        state,
        tool,
        callId,
        args,
        ...marked,
        ...(detail ? { detail } : {}),
      });

      const startedAt = Date.now();
      const settle = (status: "ok" | "error", value: unknown) => {
        emit({
          type: "tool-result",
          state,
          tool,
          callId,
          status,
          durationMs: Date.now() - startedAt,
          ...marked,
          ...toolOutputPreview(value),
        });
      };

      try {
        // Mocks are checked after governance, mirroring the agent path where the
        // mock middleware sits inside the workflow middleware: a call the state
        // forbids is refused whether or not a test mocked it.
        // Delegation mocks belong to the dispatcher (see the mock middleware):
        // serving one here would skip the dispatch and its record of itself. A
        // control tool is the runtime's own, never mocked — as on the agent's
        // path, where governance services it before any mock is consulted.
        const mock =
          isWorkflowToolName(tool) || HARNESS_CONTROL_TOOLS.has(tool)
            ? undefined
            : findMock(readMocks(contextConfig.configurable), tool, args);
        const result = mock
          ? mockPayload(mock)
          : // The bridge passes no config of its own; the turn's gives the tool
            // the session id, signal and store an agent call would have had, and
            // `toolCallId` lets a delegation's telemetry trace back to this call.
            await inner.invoke(args as never, { ...(config ?? contextConfig), toolCallId: callId });
        const served = redactSkills(result, state, tool);
        settle("ok", served);
        return served;
      } catch (err) {
        // A delegated sub-run stopped for a person. Nothing calling through the
        // gateway can park — a QuickJS frame is not durable, and a grader's run
        // is not resumable — so this fails closed as an error rather than letting
        // a raw suspension escape: such a park must never unwind the turn that
        // made the call.
        const parked = subWorkflowParkOf(err);
        if (parked) {
          const failure = new SubWorkflowError(
            "parked",
            parked.workflow,
            `Sub-workflow '${parked.workflow}' stopped for a person, and a ${origin === "script" ? "script" : "grader"} ` +
              `cannot wait for one: it has no way to resume. Call it from an agent state, or ` +
              `move the decision to a human state in the calling workflow.`,
          );
          settle("error", failure.message);
          throw failure;
        }
        settle("error", (err as Error)?.message ?? String(err));
        throw err;
      }
    };
  }

  return {
    wrap(tools, { origin, sessionId }) {
      const context = contextFor(sessionId);
      return tools.map((inner) => {
        const invoke = governedInvoke(inner, origin, context);
        // A Proxy rather than a rebuilt tool: `name`, `description` and schema
        // stay the originals. Non-intercepted members are bound to the target so
        // the real tool's internals never see the proxy as `this`.
        return new Proxy(inner, {
          get(target, prop) {
            if (prop === "invoke") return invoke;
            const value = Reflect.get(target, prop, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      });
    },

    refresh(sessionId, next) {
      const context = contextFor(sessionId);
      context.state = next.state;
      context.config = next.config;
      context.replyOnly = next.replyOnly;
      context.variables = next.variables;
    },

    surface(sessionId) {
      const { state } = contextFor(sessionId);
      let names = surfaces.get(state);
      if (!names) {
        names = [...machine.disclosedTools(state)].filter((name) => !PTC_EXCLUDED_TOOLS.has(name));
        surfaces.set(state, names);
      }
      return names;
    },

    release(sessionId) {
      contexts.delete(sessionId);
    },
  };
}

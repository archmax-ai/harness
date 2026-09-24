import type { BaseMessage } from "@langchain/core/messages";
import { contentToString, isRuntimeNote, messageTypeOf, runtimeNoteKind } from "../core/messages.js";
import type { ParkChannel, TrailStep } from "./state.js";
import type { VariableStore } from "../machine/variables.js";

export interface ToolCallFact {
  name: string;
  /** The provider tool-call id, when the message carried one. */
  id?: string;
  input: unknown;
  output?: unknown;
  status: "completed" | "pending" | "failed" | "rejected";
}

export interface SessionView {
  sessionId: string;
  reply: string;
  failed: boolean;
  parked: boolean;
  /** Which channel a parked run awaits: a person's `decision` or external `input`. */
  parkedChannel?: ParkChannel;
  /** For a parked session view, the state awaiting a decision or an external trigger. */
  state?: string;
  events: Array<{ type: string; data?: Record<string, unknown> }>;
  toolCalls: ToolCallFact[];
  /** The committed audit trail, from checkpointed state — never derived from messages; empty when the producer has none. */
  auditTrail: TrailStep[];
  /** The run's variables from checkpointed state; empty when the producer has none. */
  variables: VariableStore;
}

function isMessage(m: unknown): m is BaseMessage {
  return (
    m != null &&
    typeof m === "object" &&
    ("content" in m || typeof (m as { _getType?: unknown })._getType === "function")
  );
}

/** Derive a typed session view from LangChain message history. */
export function messagesToSessionView(
  messages: unknown[],
  sessionId = "default",
  auditTrail: TrailStep[] = [],
  variables: VariableStore = {},
): SessionView {
  const list = Array.isArray(messages) ? messages : [];
  const events: SessionView["events"] = [];
  const toolCalls: ToolCallFact[] = [];
  let reply = "";
  let failed = false;

  for (const raw of list) {
    if (!isMessage(raw)) continue;
    const type = messageTypeOf(raw) || "?";
    const msg = raw as unknown as Record<string, unknown>;
    const text = contentToString(msg.content);

    // A runtime note is shaped as a tool call plus its result, but the agent made
    // no call: it is surfaced as a `runtime.note` event (from the half carrying
    // the text) and never as a tool call, so `calledTool`/`usedNoTools` and the
    // CLI flow do not report an `archmax_note` call the run never made.
    if (isRuntimeNote(raw)) {
      if (type !== "ai" && type !== "assistant") {
        events.push({ type: "runtime.note", data: { kind: runtimeNoteKind(raw), text } });
      }
      continue;
    }

    if (type === "ai" || type === "assistant") {
      if (text) reply = text;
      events.push({ type: "message.completed", data: { message: text } });
      const calls = msg.tool_calls;
      if (Array.isArray(calls)) {
        for (const c of calls) {
          const call = c as Record<string, unknown>;
          const name = String(call.name ?? "");
          toolCalls.push({
            name,
            id: call.id == null ? undefined : String(call.id),
            input: call.args ?? {},
            status: "pending",
          });
          events.push({ type: "tool.called", data: { name, input: call.args } });
        }
      }
    }

    if (type === "tool") {
      const name = String(msg.name ?? "");
      const rawStatus = String(msg.status ?? "completed");
      // A governance-blocked call carries `status: "error"` (so the model
      // self-corrects) but is a policy rejection, not a run failure: surface it
      // as `rejected` and do not flip the run's `failed` flag.
      const blocked = isGovernanceBlocked(msg);
      const status: ToolCallFact["status"] = blocked
        ? "rejected"
        : rawStatus === "error"
          ? "failed"
          : (rawStatus as ToolCallFact["status"]);
      if (status === "failed") failed = true;
      const output = unwrapToolContent(msg.content);
      // Match by tool_call_id when the message carries one; interleaved calls
      // to the same tool would otherwise pair with the wrong output. Fall back
      // to name order for providers that omit ids.
      const callId = msg.tool_call_id == null ? undefined : String(msg.tool_call_id);
      const fact =
        (callId && toolCalls.find((tc) => tc.id === callId && tc.status === "pending")) ||
        toolCalls.find(
          (tc) => tc.name === name && tc.status === "pending" && tc.output === undefined,
        );
      if (fact) {
        fact.output = output;
        fact.status = status;
      }
      events.push({ type: "tool.completed", data: { name, output, status } });
    }
  }

  return { sessionId, reply, failed, parked: false, events, toolCalls, auditTrail, variables };
}

function isGovernanceBlocked(msg: Record<string, unknown>): boolean {
  const kwargs = msg.additional_kwargs as Record<string, unknown> | undefined;
  return kwargs?.governance_blocked === true;
}

function unwrapToolContent(content: unknown): unknown {
  if (typeof content === "string") {
    try {
      return JSON.parse(content);
    } catch {
      return content;
    }
  }
  return content;
}

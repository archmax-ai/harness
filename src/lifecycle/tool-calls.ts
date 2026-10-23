/**
 * `toolCalls`: a hook's query over the session's record of tool results. Built
 * from the checkpointed transcript, which nobody edits, so a hook checks the
 * result itself, never a copy the model made. Filtered here, outside the
 * sandbox, so only the records a hook asks for are copied in.
 */
import { isRuntimeNote, messageTypeOf } from "../core/messages.js";
import { ALWAYS_ALLOWED_TOOLS } from "../machine/tool-names.js";
import { messagesToSessionView, type ToolCallFact } from "../workflow/session-view.js";
import type { ToolCallFilter, ToolCallRecord } from "../public/sandbox.js";
import { visitAt, type VisitSpan } from "../workflow/visits.js";

export type { ToolCallFilter, ToolCallRecord };

/**
 * The session's domain tool calls in the order they were made, narrowed by
 * `filter`. The runtime's control tools are not domain calls, and runtime notes
 * are not calls at all.
 */
export function queryToolCalls(
  messages: readonly unknown[],
  visits: readonly VisitSpan[],
  filter: ToolCallFilter = {},
): ToolCallRecord[] {
  const facts = messagesToSessionView([...messages]).toolCalls;
  // The same walk the view makes, so the nth call it found is the nth made here.
  const madeAt: number[] = [];
  messages.forEach((message, index) => {
    const type = messageTypeOf(message);
    if (isRuntimeNote(message) || (type !== "ai" && type !== "assistant")) return;
    const calls = (message as { tool_calls?: unknown }).tool_calls;
    if (Array.isArray(calls)) for (const _ of calls) madeAt.push(index);
  });
  const current = visits.at(-1)?.number;
  const visit = filter.visit === "current" ? current : filter.visit;
  const records = facts.flatMap((fact, i): ToolCallRecord[] => {
    if (ALWAYS_ALLOWED_TOOLS.has(fact.name)) return [];
    const span = visits.length > 0 ? visitAt(visits, madeAt[i] ?? 0) : { state: "", number: 1 };
    return [
      {
        ...(fact.id ? { id: fact.id } : {}),
        name: fact.name,
        args: fact.input,
        ...(fact.status === "pending" ? {} : { result: fact.output }),
        status: statusOf(fact),
        state: span.state,
        visit: span.number,
      },
    ];
  });
  const matched = records.filter(
    (r) =>
      (filter.name === undefined || r.name === filter.name) &&
      (filter.state === undefined || r.state === filter.state) &&
      (visit === undefined || r.visit === visit) &&
      (filter.status === undefined || r.status === filter.status),
  );
  return filter.last === undefined ? matched : matched.slice(-filter.last);
}

/** A fact's status in the four a hook is promised: LangChain marks a result that ran `success`. */
function statusOf(fact: ToolCallFact): ToolCallRecord["status"] {
  return fact.status === "pending" || fact.status === "failed" || fact.status === "rejected" ? fact.status : "completed";
}

/**
 * A session's **tool calls**: every domain call its transcript holds, with its
 * result, its status, and the state and visit of the message that made it —
 * what a code state queries with `toolCalls(filter)` and a grader reads in
 * `archmax_get_history`. Built from the checkpointed transcript, which nobody
 * edits, so a check reads the result itself, never a copy the model made. A
 * code state's query is filtered here, outside the sandbox, so only the records
 * it asks for are copied in.
 */
import { tool, type StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { isRuntimeNote, messageTypeOf } from "../core/messages.js";
import { ALWAYS_ALLOWED_TOOLS, TOOL_CALLS_QUERY } from "../machine/tool-names.js";
import type { ToolCallFilter, ToolCallRecord } from "../public/sandbox.js";
import { messagesToSessionView, type ToolCallFact } from "./session-view.js";
import { messagesIn, visitAt, visitSpans, type VisitSpan } from "./visits.js";

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
      (filter.visit === undefined || r.visit === filter.visit) &&
      (filter.status === undefined || r.status === filter.status),
  );
  return filter.last === undefined ? matched : matched.slice(-filter.last);
}

/** Every domain tool call of the session whose checkpointed state this is. */
export function sessionToolCalls(state: unknown, filter: ToolCallFilter = {}): ToolCallRecord[] {
  const messages = messagesIn(state);
  return queryToolCalls(messages, visitSpans(messages, state), filter);
}

/** A fact's status in the four a record is promised: LangChain marks a result that ran `success`. */
function statusOf(fact: ToolCallFact): ToolCallRecord["status"] {
  return fact.status === "pending" || fact.status === "failed" || fact.status === "rejected" ? fact.status : "completed";
}

/** A `toolCalls` filter; an unknown key is refused, so a misspelt one never matches everything. */
const toolCallFilterSchema = z
  .object({
    name: z.string().optional(),
    state: z.string().optional(),
    visit: z.number().int().positive().optional(),
    status: z.enum(["completed", "pending", "failed", "rejected"]).optional(),
    last: z.number().int().positive().optional(),
  })
  .strict();

/**
 * The host function behind a code state's `toolCalls(filter)`, answering from
 * the session as it stood when the state was entered. Handed to the code
 * state's sandbox only and hidden from its `tools`: not a tool, so governance
 * never sees it.
 */
export function toolCallQuery(state: unknown): StructuredTool {
  return tool(async (filter) => JSON.stringify(sessionToolCalls(state, filter)), {
    name: TOOL_CALLS_QUERY,
    description: "The session's tool calls, for a code state.",
    schema: toolCallFilterSchema,
  }) as unknown as StructuredTool;
}

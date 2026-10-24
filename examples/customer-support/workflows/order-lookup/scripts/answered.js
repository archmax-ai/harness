/**
 * Approved-reply record — the end of the order-question path.
 *
 * The session arrives here once the `review-reply` grader has approved the
 * agent's answer. Records that answer — the last assistant message with text —
 * in scratchpad/answered.json as { "reply": "<text>" }, so a host has the
 * approved wording without reading the transcript. A terminal code state: the
 * session completes when this script returns, with no further model call.
 */
import { defineCodeState } from "@archmax-ai/harness/sandbox";

const RECORD = "scratchpad/answered.json";

export default defineCodeState(async ({ messages, tools }) => {
  const reply = messages.filter((m) => m.role === "assistant" && m.text.trim()).at(-1)?.text ?? "";
  // A follow-up in the same session answers again: the record is the latest approved reply.
  try {
    await tools.remove_file({ file_path: RECORD });
  } catch {
    // Nothing recorded yet.
  }
  await tools.write_file({ file_path: RECORD, content: JSON.stringify({ reply }, null, 2) });
});

/**
 * The grader behind a `grade:` assertion.
 *
 * Two halves of one job: the **evidence** a graded turn is shown — what the
 * session said, separated from what it did, bounded with visible elision — and
 * the **prompt** that grades it against the case's stated expectation. They are
 * one module because the evidence exists only to be graded; nothing else reads it.
 *
 * A grade is a soft threshold, not a gate: it scores, and the case's declared bar
 * decides pass or fail.
 */
import type { SessionView, ToolCallFact } from "../workflow/session-view.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { type AgentEnv, defaultModelFactory, loadEnv, type ModelFactory } from "../env.js";
import type { WorkflowTestsConfig } from "../machine/types.js";

/**
 * The evidence an offline-test `grade:` assertion hands the grading model:
 * the turn's final reply *and* a chronological record of how the run reached
 * it. Grading only the last assistant message grades prose — a criterion about
 * what the agent *did* ("looked up the order before answering", "never fetched
 * another customer's record") has nothing to read.
 *
 * Building and rendering are separate on purpose: composition (ordering,
 * call/output pairing, bounding) is asserted against a plain object, and only
 * the final string formatting is prompt-shaped.
 */

export type JudgeEvidenceEntry =
  | { kind: "message"; text: string }
  /** Something the runtime wrote into the transcript: a decision, a delivered event, an error route. */
  | { kind: "runtime"; note: string; text: string }
  | {
      kind: "tool";
      name: string;
      input: unknown;
      output?: unknown;
      status: ToolCallFact["status"];
    };

export interface JudgeEvidence {
  /** The turn's final assistant reply — what the user was told. */
  reply: string;
  /**
   * The turn in order: assistant messages and tool calls interleaved as they
   * happened. The final reply is not repeated here when it closed the turn —
   * it is rendered in its own section.
   */
  record: JudgeEvidenceEntry[];
}

/**
 * Per-value character cap for a rendered tool input, tool output, or record
 * message. The reply is deliberately exempt (see {@link renderJudgeEvidence}).
 */
export const MAX_VALUE_CHARS = 800;

/** Total character budget for the rendered record section. */
export const MAX_RECORD_CHARS = 12_000;

/**
 * Derive judge evidence from the view the step's other assertions evaluate
 * against, so a `judge` and a `calledTool` on the same step can never disagree
 * about what the run did.
 *
 * Order comes from `events` (chronological, but with no call→output pairing)
 * and pairing from `toolCalls` (paired by tool-call id, but flat). Both are
 * built in the same pass of `messagesToSessionView`, so the nth `tool.called` event
 * is `toolCalls[n]` — reading them together is exact, where re-pairing the
 * events by name here would re-implement that matching less accurately.
 */
export function judgeEvidenceFromView(view: SessionView): JudgeEvidence {
  const record: JudgeEvidenceEntry[] = [];
  let nthCall = 0;

  for (const event of view.events) {
    if (event.type === "message.completed") {
      const text = String(event.data?.message ?? "");
      if (text) record.push({ kind: "message", text });
      continue;
    }
    if (event.type === "runtime.note") {
      const text = String(event.data?.text ?? "");
      if (text) record.push({ kind: "runtime", note: String(event.data?.kind ?? ""), text });
      continue;
    }
    if (event.type !== "tool.called") continue;
    // `tool.completed` carries no id, so its output is read from the paired
    // fact instead — the event only marks position, which is already known.
    const fact = view.toolCalls[nthCall++];
    record.push({
      kind: "tool",
      name: fact?.name ?? String(event.data?.name ?? ""),
      input: fact ? fact.input : event.data?.input,
      ...(fact?.output !== undefined ? { output: fact.output } : {}),
      status: fact?.status ?? "pending",
    });
  }

  const reply = view.reply ?? "";
  // The closing message is the graded reply; it gets its own section, so
  // carrying it in the record too would spend budget saying it twice. Only
  // when it *closed* the turn — a reply followed by tool calls stays in place,
  // because "said this, then did that" is the ordering the judge needs.
  const last = record[record.length - 1];
  if (reply && last?.kind === "message" && last.text === reply) record.pop();

  return { reply, record };
}

/**
 * Render evidence for the grading prompt. Every reduction is visible: a capped
 * value names the characters it dropped and a record trimmed to its budget
 * opens with the number of entries omitted. A judge that silently received
 * less than the run produced would grade a run nobody can reconstruct.
 */
export function renderJudgeEvidence(evidence: JudgeEvidence): string {
  return [
    "What the assistant did, in order:",
    renderRecord(evidence.record),
    "",
    "Final reply to the user:",
    evidence.reply || "(empty)",
  ].join("\n");
}

function renderRecord(record: readonly JudgeEvidenceEntry[]): string {
  if (record.length === 0) return "(no tool calls or intermediate messages recorded)";

  // Numbered by original position, so the numbering stays coherent with the
  // omission marker when the oldest entries are dropped.
  const lines = record.map((entry, i) => `${i + 1}. ${renderEntry(entry)}`);

  // Oldest-first dropping: the graded reply is the end of the turn, so the
  // work nearest it is what a criterion most often concerns.
  let kept = 0;
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const next = total + lines[i].length + 1;
    if (kept > 0 && next > MAX_RECORD_CHARS) break;
    total = next;
    kept += 1;
  }

  const dropped = lines.length - kept;
  const body = lines.slice(dropped);
  return dropped > 0
    ? [
        `… ${dropped} earlier ${dropped === 1 ? "entry" : "entries"} omitted (evidence budget)`,
        ...body,
      ].join("\n")
    : body.join("\n");
}

function renderEntry(entry: JudgeEvidenceEntry): string {
  if (entry.kind === "message") return `[message] ${cap(entry.text)}`;
  if (entry.kind === "runtime") return `[runtime:${entry.note}] ${cap(entry.text)}`;
  const output =
    entry.output === undefined ? "(no output recorded)" : `output=${cap(stringify(entry.output))}`;
  return `[tool] ${entry.name} input=${cap(stringify(entry.input))} → ${entry.status} ${output}`;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function cap(text: string): string {
  if (text.length <= MAX_VALUE_CHARS) return text;
  return `${text.slice(0, MAX_VALUE_CHARS)} …(+${text.length - MAX_VALUE_CHARS} chars)`;
}

/**
 * What the judge model said: a score in `[0, 1]` and its reasoning. There is
 * deliberately no pass/fail here — the case's declared `atLeast` decides that,
 * in `assertions.ts`, so a record can never contradict the verdict beside it.
 */
export interface JudgeResult {
  score: number;
  reason?: string;
}

/**
 * Resolve the judge model through the model factory's `judge` role (default:
 * the env-configured model). `tests.judge.model` and `tests.judge.modelOptions`
 * (`temperature`, `maxTokens`) are applied over the environment the factory is
 * handed, so the default factory builds exactly the grader the spec names; a
 * factory that brings its own model ignores the env, and these with it.
 *
 * The environment is loaded lazily (same shape as the harness): a factory that
 * carries its own credentials never reads it, so a host with no `ARCHMAX_*`
 * variables can still grade a `grade:` expectation.
 */
export function createJudgeModel(
  config: WorkflowTestsConfig,
  modelFactory: ModelFactory = defaultModelFactory,
): BaseChatModel {
  const { model, modelOptions = {} } = config.judge ?? {};
  let cachedEnv: AgentEnv | undefined;
  const env = (): AgentEnv =>
    (cachedEnv ??= {
      ...loadEnv(),
      ...(model ? { model } : {}),
      ...(modelOptions.temperature !== undefined ? { temperature: modelOptions.temperature } : {}),
      ...(modelOptions.maxTokens !== undefined ? { maxTokens: modelOptions.maxTokens } : {}),
    });
  return modelFactory("judge", env);
}

/**
 * Grade one closed-QA criterion against a turn's run evidence (the offline-test
 * judge). The evidence carries what the assistant *did* as well as what it
 * said, so the two are weighed differently in the prompt: a criterion about
 * what the user was told is met only by the final reply, while a criterion
 * about behaviour may be met by the tool record. Without that split, adding the
 * record would let "tells the customer the refund is approved" pass on the
 * strength of an `approve_refund` call the customer never heard about.
 */
export async function gradeClosedQA(
  model: BaseChatModel,
  criteria: string,
  evidence: JudgeEvidence,
): Promise<JudgeResult> {
  const messages = [
    new SystemMessage(
      [
        "You grade whether an assistant's turn satisfies a yes/no criterion.",
        "You are given a chronological record of the turn — the assistant's messages, the tool calls it made with their inputs, outputs and status, and the runtime's own notes (marked [runtime:<kind>]: a person's decision that routed the run, an event delivered to it, an error route) — followed by the assistant's final reply to the user.",
        "Weigh them differently: a criterion about what the user was told is met only by the final reply, while a criterion about what the assistant did, or what happened to the run, may be met by the record.",
        'Reply with JSON only: {"score": number between 0 and 1, "pass": boolean, "reason": string}',
        "score 1 means the criterion is fully met; 0 means it is not met at all.",
        // The reason is printed beside a verdict line, so it has to fit there.
        // A bound in the prompt, not a truncation: cutting a model's
        // explanation mid-clause reads worse than asking for a short one.
        "Keep reason to 1-3 sentences: state the judgment and the evidence for it, nothing more.",
      ].join(" "),
    ),
    new HumanMessage(`Criterion: ${criteria}\n\n${renderJudgeEvidence(evidence)}`),
  ];

  const first = await model.invoke(messages);
  const verdict = parseVerdict(responseText(first));
  if (verdict) return verdict;

  // A grader that wrapped or mangled its JSON gets exactly one reminder before
  // its turn scores 0: a real model run failed a case this way, and re-asking
  // is cheaper than a false failure. The retry carries the first reply, so the
  // model corrects its own answer rather than grading afresh.
  const retry = await model.invoke([
    ...messages,
    first,
    new HumanMessage(
      "Your previous reply could not be read as JSON. Reply with the JSON object only — " +
        'no prose, no code fences: {"score": number, "pass": boolean, "reason": string}',
    ),
  ]);
  return (
    parseVerdict(responseText(retry)) ?? {
      score: 0,
      reason: "grader returned no readable JSON verdict",
    }
  );
}

/** The textual content of a model reply, whatever shape the provider used. */
function responseText(response: { content: unknown }): string {
  const { content } = response;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : ((p as { text?: string }).text ?? "")))
      .join("");
  }
  return String(content ?? "");
}

/**
 * Read the verdict out of a grader's reply. The reply is scanned for balanced
 * `{...}` blocks — so prose around the JSON, a markdown fence, or a brace
 * inside the prose (`the reply {mentions} …`) is tolerated — and the first
 * block that parses as an object wins. `null` when nothing parses.
 */
export function parseVerdict(raw: string): JudgeResult | null {
  for (const block of balancedObjects(raw)) {
    try {
      const parsed = JSON.parse(block) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      // The prompt asks the model for its own `pass` boolean (unchanged
      // wording, so grading stays calibrated); it is not read — the declared
      // `atLeast` is the only bar.
      const { score, reason } = parsed as { score?: unknown; reason?: unknown };
      return {
        score: Math.max(0, Math.min(1, Number(score ?? 0))),
        reason: typeof reason === "string" ? reason : undefined,
      };
    } catch {
      // Not JSON: try the next candidate.
    }
  }
  return null;
}

/** Every balanced `{...}` block in `raw`, in order of its opening brace. */
function* balancedObjects(raw: string): Generator<string> {
  let start = raw.indexOf("{");
  while (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end !== -1) yield raw.slice(start, end + 1);
    start = raw.indexOf("{", start + 1);
  }
}

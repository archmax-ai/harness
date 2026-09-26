/**
 * Shared support for the behaviour-level suite.
 *
 * Everything here drives the runtime through the **public API only** — the
 * `../index.js` barrel and `../public/testing.js` — so that an internal
 * restructuring can be verified against these tests without touching them. No
 * test in this directory imports from `src/workflow/*`, `src/machine/*`,
 * `src/kernel/*` or any other internal module.
 *
 * Three pieces:
 *
 *  - {@link ScriptedModel}: a fake chat model that replays a queue of turns —
 *    tool calls (`archmax_advance`, `archmax_wait`, `write_file`, a delegation
 *    tool, …) and final text replies — and records what it was bound with.
 *  - {@link makeWorkspace}: writes an authored workspace (workflow.yaml, hooks,
 *    skills) into a temp directory, cleaned up by {@link cleanupWorkspaces}.
 *  - {@link assemble} / {@link turn}: assemble a governed agent over a memory
 *    session store with an event sink, and drive one conversational turn.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stringify as toYaml } from "yaml";
import { AIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseChatModelCallOptions } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import {
  contentToString,
  createAgent,
  createMemorySessionStore,
  isAiMessage,
  type Agent,
  type CreateAgentParams,
  type SessionStore,
  type WorkflowLifecycleEvent,
  type WorkflowSurface,
} from "../index.js";

// --- Scripted model ------------------------------------------------------------

/** Token usage a scripted reply may report, so `model-usage` events are testable. */
export interface ScriptedUsage {
  input: number;
  output: number;
}

/**
 * The model id a scripted response echoes back in `response_metadata`. Omitted,
 * the response names no model — which is the ordinary case behind an
 * OpenAI-compatible proxy, and the one that used to cost a call its price.
 */
export type ScriptedModelName = string;

/** One scripted model turn. */
export type ScriptedTurn =
  /** A single tool call. */
  | { tool: string; args: Record<string, unknown>; usage?: ScriptedUsage; reports?: ScriptedModelName }
  /** Several tool calls issued in one assistant message (a tool batch). */
  | {
      batch: Array<{ tool: string; args: Record<string, unknown> }>;
      usage?: ScriptedUsage;
      reports?: ScriptedModelName;
    }
  /** A final text reply, ending the turn. */
  | { reply: string; usage?: ScriptedUsage; reports?: ScriptedModelName };

/** A tool call the scripted model issued, as recorded. */
export interface IssuedCall {
  name: string;
  args: Record<string, unknown>;
}

/** One model invocation as the fake observed it. */
export interface ModelCall {
  /** Tool names bound for this call (from the most recent `bindTools`). */
  tools: string[];
  /** The system prompt text, when one was present. */
  systemPrompt: string;
  /** Kinds of the messages the model was shown (`system`, `human`, `ai`, `tool`). */
  messageTypes: string[];
  /** The tool answers the model was shown, correlated by the call id they answer. */
  toolAnswers: Array<{ callId: string; content: string; status?: string }>;
}

/**
 * A model that replays a fixed script of turns. `bindTools` returns the same
 * instance so the cursor is shared across every binding the agent performs —
 * the script is the run's plan, not one binding's. When the script runs out the
 * model replies with a final `done`, so every turn terminates.
 */
export class ScriptedModel extends BaseChatModel<BaseChatModelCallOptions> {
  private cursor = 0;
  private lastBound: string[] = [];
  private seq = 0;
  /** Every tool the model was bound with, by name: what the model is told about each. */
  readonly boundTools = new Map<string, { description: string; schema: unknown }>();
  /** Tool calls the script actually issued, in order. */
  readonly issued: IssuedCall[] = [];
  /** Every model invocation, in order. */
  readonly calls: ModelCall[] = [];
  /** What to say when the script is exhausted. */
  readonly fallbackReply: string;
  /**
   * The id this model was configured to run, as a real client exposes it — what
   * `modelIdOf` reads and what the runtime prices against when a response names
   * no model. Left undefined by default so an existing case is unchanged.
   */
  readonly model?: string;

  constructor(
    private readonly turns: ScriptedTurn[],
    opts: { fallbackReply?: string; name?: string; model?: string } = {},
  ) {
    super({});
    this.fallbackReply = opts.fallbackReply ?? "done";
    if (opts.model !== undefined) this.model = opts.model;
  }

  _llmType(): string {
    return "archmax-behaviour-scripted";
  }

  /** How many scripted turns are still unplayed. */
  get remaining(): number {
    return Math.max(0, this.turns.length - this.cursor);
  }

  /** Append turns to the script — for a later conversational turn on the same agent. */
  enqueue(...turns: ScriptedTurn[]): void {
    this.turns.push(...turns);
  }

  bindTools(tools: unknown[]): BaseChatModel {
    this.lastBound = (tools as Array<{ name?: string }>).map((t) => String(t?.name ?? ""));
    for (const bound of tools as Array<{ name?: string; description?: string; schema?: unknown }>) {
      if (bound?.name) this.boundTools.set(bound.name, { description: String(bound.description ?? ""), schema: bound.schema });
    }
    return this as unknown as BaseChatModel;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const system = messages.find((m) => m.getType() === "system");
    this.calls.push({
      tools: [...this.lastBound],
      systemPrompt: system ? contentToString(system.content) : "",
      messageTypes: messages.map((m) => m.getType()),
      toolAnswers: messages
        .filter((m) => m.getType() === "tool")
        .map((m) => {
          const answer = m as BaseMessage & { tool_call_id?: string; status?: string };
          return {
            callId: String(answer.tool_call_id ?? ""),
            content: contentToString(answer.content),
            ...(answer.status ? { status: answer.status } : {}),
          };
        }),
    });

    // The cursor only moves past a scripted turn: a fallback reply consumes
    // nothing, so turns enqueued later are still played in order.
    const scripted = this.turns[this.cursor];
    if (scripted) this.cursor += 1;
    const turn: ScriptedTurn = scripted ?? { reply: this.fallbackReply };
    const usage = turn.usage
      ? {
          usage_metadata: {
            input_tokens: turn.usage.input,
            output_tokens: turn.usage.output,
            total_tokens: turn.usage.input + turn.usage.output,
          },
          ...(turn.reports ? { response_metadata: { model_name: turn.reports } } : {}),
        }
      : {};

    if ("reply" in turn) {
      const message = new AIMessage({ content: turn.reply, ...usage });
      return { generations: [{ text: turn.reply, message }] };
    }
    const calls = "batch" in turn ? turn.batch : [{ tool: turn.tool, args: turn.args }];
    const toolCalls = calls.map((c) => {
      this.issued.push({ name: c.tool, args: c.args });
      return { id: `call-${++this.seq}`, name: c.tool, args: c.args };
    });
    const message = new AIMessage({ content: "", tool_calls: toolCalls, ...usage });
    return { generations: [{ text: "", message }] };
  }
}

// --- Temp workspaces ----------------------------------------------------------

const tmpRoots: string[] = [];

/**
 * Write an authored workspace into a fresh temp directory. Values are file
 * contents; a non-string value is serialized as YAML (handy for `workflow.yaml`
 * declared as an object). Returns the root path.
 */
export function makeWorkspace(files: Record<string, string | object>): string {
  const root = mkdtempSync(join(tmpdir(), "archmax-behaviour-"));
  tmpRoots.push(root);
  for (const [rel, contents] of Object.entries(files)) {
    const full = resolve(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof contents === "string" ? contents : toYaml(contents));
  }
  return root;
}

/** Remove every workspace {@link makeWorkspace} created. Call from `afterEach`. */
export function cleanupWorkspaces(): void {
  while (tmpRoots.length) rmSync(tmpRoots.pop()!, { recursive: true, force: true });
}

/** A `SKILL.md` body with the frontmatter the skill loader requires. */
export function skillMarkdown(name: string, description = `The ${name} skill.`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

/**
 * One inline rubric, as the value of a `{ rubric: … }` hook. A rubric is
 * declared on the hook that applies it, so a fixture builds the declaration and
 * drops it straight into a state's `before`/`after`.
 */
export function rubricDeclaration(
  opts: { maxIterations?: number; model?: string; instructions?: string; metadata?: unknown } = {},
): Record<string, unknown> {
  return {
    instructions: opts.instructions ?? "Judge the reply. Reply with a JSON verdict.",
    ...(opts.maxIterations !== undefined ? { max_iterations: opts.maxIterations } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
  };
}

/** The default persona file every workspace here carries. */
export const AGENTS_MD = "# Agent\n\nDo what the workflow says.\n";

// --- Assembly and driving -----------------------------------------------------

export interface AssembleOptions {
  /** Workflow slug; defaults to `w`. */
  workflow?: string;
  /** The agent model's script. Ignored when `model` is supplied. */
  turns?: ScriptedTurn[];
  /** A prebuilt model (e.g. to share across two assemblies). */
  model?: ScriptedModel;
  /** A second scripted model for the `rubric` role (grading rubrics). */
  rubricModel?: ScriptedModel | JudgeModel;
  /**
   * Supplies the model per role and requested id, for a workflow that declares
   * models. Supplied, it replaces the explicit `model` — which would outrank
   * every declared id — so the ids the spec names actually resolve.
   */
  modelFactory?: CreateAgentParams["modelFactory"];
  /** The session store; defaults to a fresh memory store. */
  store?: SessionStore;
  /** Extra `createAgent` parameters merged in last. */
  params?: Partial<CreateAgentParams>;
}

export interface Assembled {
  agent: Agent & { workflow: WorkflowSurface };
  model: ScriptedModel;
  events: WorkflowLifecycleEvent[];
  store: SessionStore;
  root: string;
}

/** Assemble a governed agent over `root` with an event sink and memory storage. */
export async function assemble(root: string, opts: AssembleOptions = {}): Promise<Assembled> {
  const model = opts.model ?? new ScriptedModel(opts.turns ?? []);
  const events: WorkflowLifecycleEvent[] = [];
  const store = opts.store ?? createMemorySessionStore();
  const rubricModel = opts.rubricModel;
  const agent = await createAgent({
    workflow: opts.workflow ?? "w",
    ...(opts.modelFactory
      ? { modelFactory: opts.modelFactory }
      : rubricModel
        ? {
            modelFactory: (role) =>
              (role === "agent" ? model : rubricModel) as unknown as BaseChatModel,
          }
        : { model: model as unknown as BaseChatModel }),
    onEvent: (event) => events.push(event),
    workspace: { rootDir: root, sessionStore: store },
    ...opts.params,
  });
  if (!agent.workflow) throw new Error("expected a governed assembly");
  return { agent: agent as Agent & { workflow: WorkflowSurface }, model, events, store, root };
}

export interface TurnOutcome {
  /** The settled turn result's message list. */
  messages: unknown[];
  /** The last assistant message carrying text, as a person would read it. */
  reply: string;
}

/** Drive one conversational turn on `sessionId`. */
export async function turn(
  agent: Agent,
  sessionId: string,
  text: string,
  opts: { trigger?: { id: string } } = {},
): Promise<TurnOutcome> {
  const input = {
    messages: [{ role: "user", content: text }],
    ...(opts.trigger ? { trigger: opts.trigger } : {}),
  };
  const result = (await agent.invoke(input as never, {
    configurable: { thread_id: sessionId },
  } as never)) as { messages?: unknown[] };
  const messages = result.messages ?? [];
  return { messages, reply: lastAgentText(messages) };
}

/** The final assistant message carrying text, skipping tool results. */
export function lastAgentText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isAiMessage(message)) continue;
    const text = contentToString((message as { content?: unknown }).content).trim();
    if (text) return text;
  }
  return "";
}

/** The type of a message (`ai`, `human`, `tool`, `system`), read across shapes. */
export function messageType(message: unknown): string {
  const msg = message as Record<string, unknown>;
  const t =
    (msg._getType as (() => string) | undefined)?.call(msg) ??
    (msg.getType as (() => string) | undefined)?.call(msg) ??
    msg.type ??
    msg.role ??
    "";
  return String(t);
}

/** Tool results in a transcript: `{ name, content, status }`. */
export function toolResults(
  messages: unknown[],
): Array<{ name: string; content: string; status?: string }> {
  return messages
    .filter((m) => messageType(m) === "tool")
    .map((m) => {
      const msg = m as { name?: string; content?: unknown; status?: string };
      return {
        name: String(msg.name ?? ""),
        content: contentToString(msg.content),
        ...(msg.status ? { status: msg.status } : {}),
      };
    });
}

// --- Event selectors ----------------------------------------------------------

/** Events of one type, narrowed. */
export function eventsOf<T extends WorkflowLifecycleEvent["type"]>(
  events: WorkflowLifecycleEvent[],
  type: T,
): Array<Extract<WorkflowLifecycleEvent, { type: T }>> {
  return events.filter((e) => e.type === type) as Array<
    Extract<WorkflowLifecycleEvent, { type: T }>
  >;
}

/** The states entered, in order. */
export function statesEntered(events: WorkflowLifecycleEvent[]): string[] {
  return eventsOf(events, "state-enter").map((e) => e.state);
}

/** The agent-driven transitions (`from -> to`), in order — the opening arrival excluded. */
export function advances(events: WorkflowLifecycleEvent[]): Array<{ from: string; to: string; reason?: string }> {
  return eventsOf(events, "advance")
    .filter((e) => e.from !== "__start__")
    .map((e) => ({ from: e.from, to: e.to, ...(e.reason ? { reason: e.reason } : {}) }));
}

/** Names of the tools governance refused, in order. */
export function blockedTools(events: WorkflowLifecycleEvent[]): string[] {
  return eventsOf(events, "tool-blocked").map((e) => e.tool);
}

/** Events emitted for one session only. */
export function forSession(
  events: WorkflowLifecycleEvent[],
  sessionId: string,
): WorkflowLifecycleEvent[] {
  return events.filter((e) => e.sessionId === sessionId);
}

// --- Spec builders ------------------------------------------------------------

/**
 * A two-state linear machine: `start` (manual) → `done` (terminal), with the
 * runtime contract pinned. Extra keys are merged into the spec root.
 */
export function linearSpec(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runtime: { engine: "archmax-harness", version: "2" },
    states: {
      start: { triggers: { manual: null }, transitions: [{ to: "done", description: "Test edge to done." }] },
      done: {},
    },
    ...extra,
  };
}

/** The scripted turn that advances `to` with a reason. */
export function advanceTo(to: string, reason = `moving to ${to}`): ScriptedTurn {
  return { tool: "archmax_advance", args: { to, reason } };
}

/** A workspace with a persona and one workflow spec under `workflows/w/`. */
export function workspaceWith(
  spec: Record<string, unknown>,
  extraFiles: Record<string, string | object> = {},
): string {
  return makeWorkspace({
    "AGENTS.md": AGENTS_MD,
    "workflows/w/workflow.yaml": spec,
    ...extraFiles,
  });
}

// --- Judge model --------------------------------------------------------------

/** A lifecycle judge's answer. */
export interface JudgeVerdict {
  verdict: "ok" | "correct" | "veto";
  reason: string;
}

/**
 * A fake model for the `rubric` role that answers each dispatch with the next
 * scripted verdict. When the framework binds a structured-output tool
 * (`extract-*`) it is called with the verdict; otherwise the verdict is the reply
 * text as JSON — both reach the lifecycle runner as a parseable verdict.
 */
export class JudgeModel extends BaseChatModel<BaseChatModelCallOptions> {
  private cursor = 0;
  private lastBound: string[] = [];
  private seq = 0;
  /** How many times the judge was asked. */
  get dispatches(): number {
    return this.calls;
  }
  private calls = 0;

  constructor(
    private readonly verdicts: JudgeVerdict[],
    private readonly fallback: JudgeVerdict = { verdict: "ok", reason: "fine" },
    /**
     * Fail every dispatch instead of answering — how an unusable `model` id
     * surfaces, since a bad id is refused at invocation, not construction.
     */
    private readonly failWith?: string,
  ) {
    super({});
  }

  _llmType(): string {
    return "archmax-behaviour-judge";
  }

  bindTools(tools: unknown[]): BaseChatModel {
    this.lastBound = (tools as Array<{ name?: string }>).map((t) => String(t?.name ?? ""));
    return this as unknown as BaseChatModel;
  }

  async _generate(): Promise<ChatResult> {
    this.calls += 1;
    if (this.failWith) throw new Error(this.failWith);
    const verdict = this.verdicts[this.cursor++] ?? this.fallback;
    const extract = this.lastBound.find((name) => name.startsWith("extract-"));
    if (extract) {
      const message = new AIMessage({
        content: "",
        tool_calls: [{ id: `judge-${++this.seq}`, name: extract, args: { ...verdict } }],
      });
      return { generations: [{ text: "", message }] };
    }
    const text = JSON.stringify(verdict);
    return { generations: [{ text, message: new AIMessage(text) }] };
  }
}

// --- Store access -------------------------------------------------------------

/** Read one file from a session store by store-relative path, or `undefined`. */
export async function storeFile(store: SessionStore, path: string): Promise<string | undefined> {
  const result = await store.backend.readRaw(path);
  const data = (result as { data?: { content?: string } }).data;
  return typeof data?.content === "string" ? data.content : undefined;
}

// --- Session ids ---------------------------------------------------------------

let sessionSeq = 0;

/**
 * A session id no other test in this process has used. Sandbox REPL sessions
 * and other per-session resources are keyed by session id for the life of the
 * process, so tests that run hooks or scripts must not share one.
 */
export function freshSessionId(prefix = "s"): string {
  return `${prefix}-${process.pid}-${++sessionSeq}`;
}

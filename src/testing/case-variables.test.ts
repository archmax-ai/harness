/**
 * A case's `variables:` seed, driven end-to-end.
 *
 * The seeding channel itself is unit-covered (`case-schema.test.ts` parses the
 * block, `driver.test.ts` covers the session engine). What matters to an author
 * is the property those unit tests cannot state: a case seed is
 * **indistinguishable from a production host seed** to everything downstream of
 * it. So these tests drive real YAML cases through `runTests` against a real
 * governed runtime — real graph, real kernel, real QuickJS hook — and check the
 * four consumers a host seed reaches:
 *
 * - a state's `requires:` gate (satisfied by the seed, refused without it),
 * - a `${{…}}` reference in a `tools.allow` glob (resolved from the seed),
 * - a `${{…}}` reference the **agent** writes into a tool argument (resolved from
 *   the seed at the call boundary),
 * - a lifecycle hook script's read-only `args.variables` snapshot,
 * - `set_variables`, which must refuse a seeded name exactly as it refuses a
 *   host-seeded one.
 *
 * The model is scripted rather than mocked at the tool layer: governance
 * verdicts and the `requires` gate are decisions about *tool calls*, so a
 * text-only stub could not exercise them.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { BaseChatModel as BaseChatModelClass } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import { runTests } from "./runner.js";
import type { AssertionRecord } from "./runner.js";
import type { WorkflowLifecycleEvent } from "../core/events.js";

/** One scripted model turn: a tool call, or a final text reply. */
type Turn = { tool: string; args: Record<string, unknown> } | { reply: string };

/**
 * A model that replays a fixed script of turns. `bindTools` returns the same
 * instance so the cursor is shared across every bind the agent performs —
 * the script is the run's plan, not one binding's.
 */
class ScriptedModel extends BaseChatModelClass {
  private cursor = 0;
  /** Tool calls the script actually issued, in order (call names only). */
  readonly issued: string[] = [];

  constructor(private readonly turns: Turn[]) {
    super({});
  }

  _llmType(): string {
    return "archmax-scripted";
  }

  bindTools(): BaseChatModel {
    return this as unknown as BaseChatModel;
  }

  async _generate(): Promise<ChatResult> {
    const turn = this.turns[this.cursor++] ?? { reply: "done" };
    if ("reply" in turn) {
      return { generations: [{ text: turn.reply, message: new AIMessage(turn.reply) }] };
    }
    this.issued.push(turn.tool);
    const message = new AIMessage({
      content: "",
      tool_calls: [{ id: `call-${this.cursor}`, name: turn.tool, args: turn.args }],
    });
    return { generations: [{ text: "", message }] };
  }
}

const tmpRoots: string[] = [];

function makeWorkspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "case-variables-"));
  tmpRoots.push(root);
  for (const [rel, contents] of Object.entries(files)) {
    const full = resolve(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

afterEach(() => {
  while (tmpRoots.length) rmSync(tmpRoots.pop()!, { recursive: true, force: true });
});

/** Run exactly one case file, with its own scripted model. */
async function runCase(root: string, filter: string, turns: Turn[]) {
  const model = new ScriptedModel(turns);
  const events: WorkflowLifecycleEvent[] = [];
  const { results } = await runTests({
    workflow: "v",
    rootDir: root,
    filter,
    onEvent: (event) => events.push(event as WorkflowLifecycleEvent),
    modelFactory: () => model as unknown as BaseChatModel,
  });
  expect(results).toHaveLength(1);
  return { result: results[0]!, model, events };
}

/** Failed assertions, rendered kind-and-detail, for a readable diff. */
const failures = (records: AssertionRecord[]) =>
  records
    .filter((r) => r.status === "failed")
    .map((r) => (r.detail ? `${r.kind}: ${r.detail}` : r.kind));

const AGENTS = "# Agent\n\nAnswer the request.\n";

describe("a case seed satisfies a requires gate", () => {
  const WORKFLOW = [
    "runtime: { engine: archmax-harness, version: '2' }",
    "states:",
    "  start:",
    "    triggers: { manual: }",
    "    requires: [from_email]",
    "    transitions:",
    "      - to: done",
    "        description: Test edge to done.",
    "  done: {}",
  ].join("\n");

  const SEEDED = [
    "title: with-seed",
    "description: A case seed satisfies the start state's requires gate with no agent action.",
    "variables:",
    "  from_email: a@b.c",
    "steps:",
    "  - send: 'go'",
    "  - reachedState: done",
    "  - variables:",
    "      expect: { from_email: a@b.c }",
    "      locked: { from_email: true }",
  ].join("\n");

  const UNSEEDED = [
    "title: no-seed",
    "description: Without a seed the same gate refuses the advance, so the gate is real.",
    "steps:",
    "  - send: 'go'",
    "  - noTraversal: true",
  ].join("\n");

  const files = {
    "AGENTS.md": AGENTS,
    "workflows/v/workflow.yaml": WORKFLOW,
    "workflows/v/tests/with-seed.test.yaml": SEEDED,
    "workflows/v/tests/no-seed.test.yaml": UNSEEDED,
  };

  it("lets the advance through, and observes the seed as locked", async () => {
    const root = makeWorkspace(files);
    const { result } = await runCase(root, "with-seed", [
      { tool: "archmax_advance", args: { to: "done", reason: "gate satisfied" } },
      { reply: "answered" },
    ]);
    expect(failures(result.records)).toEqual([]);
    expect(result.verdict.status).toBe("passed");
  });

  it("refuses the same advance when nothing seeded the required name", async () => {
    const root = makeWorkspace(files);
    const { result } = await runCase(root, "no-seed", [
      { tool: "archmax_advance", args: { to: "done", reason: "no gate" } },
      { reply: "answered" },
    ]);
    expect(failures(result.records)).toEqual([]);
    expect(result.verdict.status).toBe("passed");
  });
});

describe("a case seed resolves a governance guard", () => {
  const WORKFLOW = [
    "runtime: { engine: archmax-harness, version: '2' }",
    "states:",
    "  start:",
    "    triggers: { manual: }",
    "    tools:",
    "      allow:",
    "        - { tool: write_file, args: { file_path: ['output/${{case_ref}}.json'] } }",
    "    transitions:",
    "      - to: done",
    "        description: Test edge to done.",
    "  done: {}",
  ].join("\n");

  const CASE = [
    "title: guard",
    "description: The seeded value is substituted into the allow glob, so only that path is writable.",
    "variables:",
    "  case_ref: K-9",
    "steps:",
    "  - send: 'go'",
    "  - calledTool: { name: write_file, input: { file_path: 'output/K-9.json' } }",
    "  - reachedState: done",
  ].join("\n");

  it("permits the call the seed names and blocks the one it does not", async () => {
    const root = makeWorkspace({
      "AGENTS.md": AGENTS,
      "workflows/v/workflow.yaml": WORKFLOW,
      "workflows/v/tests/guard.test.yaml": CASE,
    });

    const { result, events } = await runCase(root, "guard", [
      { tool: "write_file", args: { file_path: "output/K-9.json", content: "{}" } },
      { tool: "write_file", args: { file_path: "output/other.json", content: "{}" } },
      { tool: "archmax_advance", args: { to: "done", reason: "written" } },
      { reply: "answered" },
    ]);

    expect(failures(result.records)).toEqual([]);
    expect(result.verdict.status).toBe("passed");

    // The refusal is the other half: a glob resolved from the seed constrains
    // the argument, so the write to a path the seed does not name is blocked
    // rather than allowed as "some output path".
    const blocked = events.filter((e) => e.type === "tool-blocked");
    expect(blocked).toHaveLength(1);
    expect(JSON.stringify(blocked[0])).toContain("output/other.json");
  });
});

describe("a case seed is visible to a lifecycle hook script", () => {
  const WORKFLOW = [
    "runtime: { engine: archmax-harness, version: '2' }",
    "states:",
    "  start:",
    "    triggers: { manual: }",
    "    before:",
    "      script: hooks/see-variables.js",
    "    transitions:",
    "      - to: done",
    "        description: Test edge to done.",
    "  done: {}",
  ].join("\n");

  /**
   * The hook's whole contract: the seed is present in the read-only snapshot
   * under the name the case declared, with the value it declared. A missing or
   * renamed seed vetoes entry, which fails the case loudly.
   */
  const SCRIPT = [
    "/**",
    " * Entry gate that only passes when the case's seed reached the sandbox.",
    " */",
    "export default ({ variables }) =>",
    "  variables.from_email === 'a@b.c'",
    "    ? ok()",
    "    : veto('the case seed is not visible in args.variables');",
  ].join("\n");

  const CASE = [
    "title: hook",
    "description: The before hook sees the case's seed in args.variables, so entry is not vetoed.",
    "variables:",
    "  from_email: a@b.c",
    "steps:",
    "  - send: 'go'",
    "  - reachedState: done",
  ].join("\n");

  it("passes the seed into args.variables", async () => {
    const root = makeWorkspace({
      "AGENTS.md": AGENTS,
      "workflows/v/workflow.yaml": WORKFLOW,
      "workflows/v/hooks/see-variables.js": SCRIPT,
      "workflows/v/tests/hook.test.yaml": CASE,
    });

    const { result } = await runCase(root, "hook", [
      { tool: "archmax_advance", args: { to: "done", reason: "gate passed" } },
      { reply: "answered" },
    ]);

    expect(failures(result.records)).toEqual([]);
    expect(result.verdict.status).toBe("passed");
  });
});

describe("the agent cannot rewrite a case seed", () => {
  const WORKFLOW = [
    "runtime: { engine: archmax-harness, version: '2' }",
    "states:",
    "  start:",
    "    triggers: { manual: }",
    "    transitions:",
    "      - to: done",
    "        description: Test edge to done.",
    "  done: {}",
  ].join("\n");

  const CASE = [
    "title: locked",
    "description: A set_variables write against a seeded name is refused and the seeded value stands.",
    "variables:",
    "  from_email: a@b.c",
    "steps:",
    "  - send: 'go'",
    "  - reachedState: done",
    "  - variables:",
    "      expect: { from_email: a@b.c }",
    "      locked: { from_email: true }",
  ].join("\n");

  it("refuses the write and keeps the seeded value", async () => {
    const root = makeWorkspace({
      "AGENTS.md": AGENTS,
      "workflows/v/workflow.yaml": WORKFLOW,
      "workflows/v/tests/locked.test.yaml": CASE,
    });

    const { result } = await runCase(root, "locked", [
      { tool: "archmax_set_variables", args: { variables: { from_email: "attacker@x" } } },
      { tool: "archmax_advance", args: { to: "done", reason: "moving on" } },
      { reply: "answered" },
    ]);

    expect(failures(result.records)).toEqual([]);
    expect(result.verdict.status).toBe("passed");
  });
});

describe("a case seed resolves a reference the agent wrote", () => {
  const WORKFLOW = [
    "runtime: { engine: archmax-harness, version: '2' }",
    "states:",
    "  start:",
    "    triggers: { manual: }",
    "    tools:",
    "      allow:",
    "        - { tool: write_file, paths: ['scratchpad/**'] }",
    "    transitions:",
    "      - to: done",
    "        description: Test edge to done.",
    "  done: {}",
  ].join("\n");

  const CASE = [
    "title: interpolated",
    "description: The agent names a seeded value in its argument, and the tool receives the value.",
    "variables:",
    "  inbound_text: my order is late",
    "steps:",
    "  - send: 'go'",
    // Asserted in reference form on purpose: the transcript records what the
    // model wrote, which is the whole point — the value is not re-sent every turn.
    "  - calledTool:",
    "      name: write_file",
    "      input: { file_path: 'scratchpad/reply.txt' }",
    "  - reachedState: done",
  ].join("\n");

  const BODY = "Refunded.\n\n--- Original ---\n\n${{inbound_text}}";

  /** The one file the run wrote, found under whichever session id it minted. */
  function writtenFile(root: string, rel: string): string | undefined {
    const sessions = join(root, "sessions");
    for (const id of readdirSync(sessions, { withFileTypes: true })) {
      if (!id.isDirectory()) continue;
      const candidate = join(sessions, id.name, rel);
      try {
        return readFileSync(candidate, "utf8");
      } catch {
        continue;
      }
    }
    return undefined;
  }

  it("delivers the resolved text to the tool while the case asserts the reference", async () => {
    const root = makeWorkspace({
      "AGENTS.md": AGENTS,
      "workflows/v/workflow.yaml": WORKFLOW,
      "workflows/v/tests/interpolated.test.yaml": CASE,
    });
    const { result } = await runCase(root, "interpolated", [
      { tool: "write_file", args: { file_path: "scratchpad/reply.txt", content: BODY } },
      { tool: "archmax_advance", args: { to: "done", reason: "written" } },
      { reply: "answered" },
    ]);
    expect(failures(result.records)).toEqual([]);
    expect(result.verdict.status).toBe("passed");
    // The proof the reference was substituted: the *effect* holds the value, not
    // the placeholder. This is how a case pins delivered text.
    expect(writtenFile(root, "scratchpad/reply.txt")).toBe(
      "Refunded.\n\n--- Original ---\n\nmy order is late",
    );
  });

  it("refuses the call when the case seeds no such variable, and the run continues", async () => {
    const UNSEEDED = [
      "title: unseeded",
      "description: An unresolved reference refuses the call without ending the run.",
      "steps:",
      "  - send: 'go'",
      "  - reachedState: done",
    ].join("\n");
    const root = makeWorkspace({
      "AGENTS.md": AGENTS,
      "workflows/v/workflow.yaml": WORKFLOW,
      "workflows/v/tests/unseeded.test.yaml": UNSEEDED,
    });
    const { result } = await runCase(root, "unseeded", [
      { tool: "write_file", args: { file_path: "scratchpad/reply.txt", content: BODY } },
      { tool: "archmax_advance", args: { to: "done", reason: "moving on" } },
      { reply: "answered" },
    ]);
    // Correctable, not terminal: the advance still lands, so the case passes.
    expect(failures(result.records)).toEqual([]);
    expect(result.verdict.status).toBe("passed");
    expect(writtenFile(root, "scratchpad/reply.txt")).toBeUndefined();
  });
});

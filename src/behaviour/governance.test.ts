/**
 * Per-state tool governance: `tools.allow`, the essential file surface, the
 * always-open `scratchpad/`, read-only mounts, `policy.forbid_tools`, and
 * `skills.allow`. A refusal is observed as a `tool-blocked` event plus an error
 * tool result marked `governance_blocked`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { tool } from "langchain";
import { z } from "zod";
import type { StructuredTool } from "@langchain/core/tools";
import {
  advanceTo,
  assemble,
  blockedTools,
  cleanupWorkspaces,
  eventsOf,
  skillMarkdown,
  storeFile,
  toolResults,
  turn,
  workspaceWith,
} from "./support.js";

afterEach(cleanupWorkspaces);

const RUNTIME = { engine: "archmax-harness", version: "2" };

/** Two host tools, each echoing its name. */
function hostTools(): StructuredTool[] {
  const echo = (name: string) =>
    tool(async ({ q }: { q: string }) => `${name}:${q}`, {
      name,
      description: `The ${name} tool.`,
      schema: z.object({ q: z.string() }),
    }) as unknown as StructuredTool;
  return [echo("alpha"), echo("beta")];
}

/** The `governance_blocked` marker a refused call's tool result carries. */
function governanceBlocked(messages: unknown[], toolName: string): boolean {
  return messages.some((m) => {
    const msg = m as { name?: string; additional_kwargs?: Record<string, unknown> };
    return msg.name === toolName && msg.additional_kwargs?.governance_blocked === true;
  });
}

describe("tools.allow per state", () => {
  const spec = {
    runtime: RUNTIME,
    states: {
      start: { triggers: { manual: null }, tools: { allow: ["alpha"] }, transitions: [{ to: "done", description: "Test edge to done." }] },
      done: { tools: { allow: ["beta"] } },
    },
  };

  it("blocks a tool the state does not allow, with a governance-blocked result", async () => {
    const { agent, events } = await assemble(workspaceWith(spec), {
      turns: [{ tool: "beta", args: { q: "x" } }, { reply: "blocked" }],
      params: { tools: hostTools() },
    });
    const { messages } = await turn(agent, "s1", "go");

    expect(blockedTools(events)).toEqual(["beta"]);
    const blocked = eventsOf(events, "tool-blocked")[0];
    expect(blocked).toMatchObject({ state: "start", tool: "beta" });
    expect(blocked?.reason).toMatch(/not allowed in state 'start'/);
    expect(blocked?.reason).toMatch(/alpha/);
    expect(governanceBlocked(messages, "beta")).toBe(true);
    expect(toolResults(messages).find((r) => r.name === "beta")?.status).toBe("error");
    // A refused call is never announced as called.
    expect(eventsOf(events, "tool-called").map((e) => e.tool)).not.toContain("beta");
  });

  it("allows the same tool in a state that names it", async () => {
    const { agent, events } = await assemble(workspaceWith(spec), {
      turns: [
        { tool: "alpha", args: { q: "one" } },
        advanceTo("done"),
        { tool: "beta", args: { q: "two" } },
        { reply: "both ran" },
      ],
      params: { tools: hostTools() },
    });
    const { messages } = await turn(agent, "s1", "go");

    expect(blockedTools(events)).toEqual([]);
    const results = toolResults(messages);
    expect(results.find((r) => r.name === "alpha")?.content).toBe("alpha:one");
    expect(results.find((r) => r.name === "beta")?.content).toBe("beta:two");
    expect(eventsOf(events, "tool-result").filter((e) => e.tool === "beta")).toMatchObject([
      { state: "done", status: "ok" },
    ]);
  });

  it("discloses to the model only the tools the state allows, plus the essentials", async () => {
    const { agent, model } = await assemble(workspaceWith(spec), {
      turns: [advanceTo("done"), { reply: "ok" }],
      params: { tools: hostTools() },
    });
    await turn(agent, "s1", "go");
    const [inStart, inDone] = model.calls;
    expect(inStart?.tools).toContain("alpha");
    expect(inStart?.tools).not.toContain("beta");
    expect(inDone?.tools).toContain("beta");
    expect(inDone?.tools).not.toContain("alpha");
    for (const call of [inStart, inDone]) {
      expect(call?.tools).toEqual(expect.arrayContaining(["read_file", "write_file", "ls", "archmax_set_variables"]));
    }
  });

  it("grants a tool in every state through allow_always", async () => {
    const { agent, events } = await assemble(
      workspaceWith({ ...spec, tools: { allow_always: ["beta"] } }),
      {
        turns: [{ tool: "beta", args: { q: "x" } }, advanceTo("done"), { reply: "ok" }],
        params: { tools: hostTools() },
      },
    );
    await turn(agent, "s1", "go");
    expect(blockedTools(events)).toEqual([]);
  });

  it("constrains a tool's arguments when the entry declares an args guard", async () => {
    const guarded = {
      runtime: RUNTIME,
      states: {
        start: {
          triggers: { manual: null },
          tools: { allow: [{ tool: "alpha", args: { q: ["ok-*"] } }] },
          transitions: [{ to: "done", description: "Test edge to done." }],
        },
        done: {},
      },
    };
    const { agent, events } = await assemble(workspaceWith(guarded), {
      turns: [{ tool: "alpha", args: { q: "ok-1" } }, { tool: "alpha", args: { q: "bad" } }, { reply: "done" }],
      params: { tools: hostTools() },
    });
    await turn(agent, "s1", "go");
    expect(eventsOf(events, "tool-result").filter((e) => e.tool === "alpha")).toHaveLength(1);
    expect(blockedTools(events)).toEqual(["alpha"]);
  });

  it("refuses a call naming a tool that does not exist as an unknown tool, not a governance denial", async () => {
    const { agent, events } = await assemble(workspaceWith(spec), {
      turns: [{ tool: "gamma", args: { q: "x" } }, { reply: "hm" }],
      params: { tools: hostTools() },
    });
    const { messages } = await turn(agent, "s1", "go");
    expect(blockedTools(events)).toEqual([]);
    const result = toolResults(messages).find((r) => r.name === "gamma");
    expect(result?.content).toMatch(/not a tool/);
    expect(result?.status).toBe("error");
  });
});

describe("the essential file surface", () => {
  const spec = {
    runtime: RUNTIME,
    states: {
      start: { triggers: { manual: null }, tools: { allow: ["alpha"] }, transitions: [{ to: "done", description: "Test edge to done." }] },
      done: {},
    },
  };

  it("lets every state read, write and list scratchpad/ without a declaration", async () => {
    const { agent, events, store } = await assemble(workspaceWith(spec), {
      turns: [
        { tool: "write_file", args: { file_path: "scratchpad/a.txt", content: "one" } },
        advanceTo("done"),
        { tool: "write_file", args: { file_path: "scratchpad/b.txt", content: "two" } },
        { tool: "read_file", args: { file_path: "scratchpad/a.txt" } },
        { tool: "ls", args: { path: "scratchpad" } },
        { reply: "ok" },
      ],
      params: { tools: hostTools() },
    });
    const { messages } = await turn(agent, "s1", "go");

    expect(blockedTools(events)).toEqual([]);
    expect(await storeFile(store, "/s1/scratchpad/a.txt")).toBe("one");
    expect(await storeFile(store, "/s1/scratchpad/b.txt")).toBe("two");
    const results = toolResults(messages);
    expect(results.find((r) => r.name === "read_file")?.content).toContain("one");
    expect(results.find((r) => r.name === "ls")?.content).toMatch(/a\.txt/);
  });

  it("persists scratchpad files across turns of the same session, isolated per session", async () => {
    const { agent, model, store } = await assemble(workspaceWith(spec), {
      turns: [{ tool: "write_file", args: { file_path: "scratchpad/note.md", content: "kept" } }, { reply: "ok" }],
    });
    await turn(agent, "s1", "first");
    model.enqueue({ tool: "read_file", args: { file_path: "scratchpad/note.md" } }, { reply: "ok" });
    const { messages } = await turn(agent, "s1", "second");
    expect(toolResults(messages).find((r) => r.name === "read_file")?.content).toContain("kept");

    model.enqueue({ tool: "read_file", args: { file_path: "scratchpad/note.md" } }, { reply: "ok" });
    const other = await turn(agent, "s2", "other session");
    expect(toolResults(other.messages).find((r) => r.name === "read_file")?.content).toMatch(/not found/i);
    expect(await storeFile(store, "/s2/scratchpad/note.md")).toBeUndefined();
  });

  it("refuses a write outside scratchpad/ when the state narrows write_file to other paths, and admits the narrowed path", async () => {
    const narrowed = {
      runtime: RUNTIME,
      states: {
        start: {
          triggers: { manual: null },
          tools: { allow: [{ tool: "write_file", paths: ["output/**"] }] },
        },
      },
    };
    const { agent, events, store } = await assemble(workspaceWith(narrowed), {
      turns: [
        { tool: "write_file", args: { file_path: "output/report.md", content: "r" } },
        { tool: "write_file", args: { file_path: "notes/private.md", content: "n" } },
        { tool: "write_file", args: { file_path: "scratchpad/work.md", content: "w" } },
        { reply: "ok" },
      ],
    });
    await turn(agent, "s1", "go");

    expect(blockedTools(events)).toEqual(["write_file"]);
    expect(JSON.stringify(eventsOf(events, "tool-blocked")[0]?.args)).toContain("notes/private.md");
    expect(await storeFile(store, "/s1/output/report.md")).toBe("r");
    expect(await storeFile(store, "/s1/notes/private.md")).toBeUndefined();
    // scratchpad/ stays open even when write_file is narrowed.
    expect(await storeFile(store, "/s1/scratchpad/work.md")).toBe("w");
  });

  it("refuses a write into a read-only mount", async () => {
    const { agent, events, root } = await assemble(
      workspaceWith(spec, { "skills/data/SKILL.md": skillMarkdown("data") }),
      {
        turns: [
          { tool: "write_file", args: { file_path: "skills/data/SKILL.md", content: "tampered" } },
          { tool: "edit_file", args: { file_path: "skills/data/SKILL.md", old_string: "data", new_string: "x" } },
          { reply: "ok" },
        ],
      },
    );
    const { messages } = await turn(agent, "s1", "go");

    expect(blockedTools(events)).toEqual(["write_file", "edit_file"]);
    expect(eventsOf(events, "tool-blocked")[0]?.reason).toMatch(/read-only/);
    expect(governanceBlocked(messages, "write_file")).toBe(true);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(`${root}/skills/data/SKILL.md`, "utf8")).toBe(skillMarkdown("data"));
  });

  it("lets a state read authored content while refusing to write it", async () => {
    // The bundle is enabled here: this is about the read-only mount, not about
    // skill governance, which would otherwise refuse the read first.
    const enabling = {
      ...spec,
      skills: { allow_always: ["data"] },
      states: { ...spec.states },
    };
    const { agent, events } = await assemble(
      workspaceWith(enabling, { "skills/data/SKILL.md": skillMarkdown("data") }),
      { turns: [{ tool: "read_file", args: { file_path: "skills/data/SKILL.md" } }, { reply: "ok" }] },
    );
    const { messages } = await turn(agent, "s1", "go");
    expect(blockedTools(events)).toEqual([]);
    expect(toolResults(messages).find((r) => r.name === "read_file")?.content).toContain("name: data");
  });
});

describe("tools.forbid_always", () => {
  it("withholds and blocks a forbidden tool in every state, even an essential one", async () => {
    const spec = {
      runtime: RUNTIME,
      tools: { forbid_always: [{ tool: "archmax_eval" }, { tool: "alpha" }] },
      states: {
        start: { triggers: { manual: null }, tools: { allow: ["alpha"] }, transitions: [{ to: "done", description: "Test edge to done." }] },
        done: {},
      },
    };
    const { agent, events, model } = await assemble(workspaceWith(spec), {
      turns: [
        { tool: "archmax_eval", args: { code: "1 + 1" } },
        { tool: "alpha", args: { q: "x" } },
        advanceTo("done"),
        { reply: "ok" },
      ],
      params: { tools: hostTools() },
    });
    await turn(agent, "s1", "go");

    expect(blockedTools(events)).toEqual(["archmax_eval", "alpha"]);
    for (const e of eventsOf(events, "tool-blocked")) {
      expect(e.reason).toMatch(/forbidden by the workflow \(tools\.forbid_always\)/);
    }
    expect(model.calls[0]?.tools).not.toContain("archmax_eval");
    expect(model.calls[0]?.tools).not.toContain("alpha");
  });
});

describe("skills.allow per state", () => {
  const files = {
    "skills/orders/SKILL.md": skillMarkdown("orders", "Order records."),
    "skills/orders/assets/orders.json": '[{"id":"ORD-1"}]',
    "skills/policy/SKILL.md": skillMarkdown("policy", "Refund policy."),
    "skills/policy/assets/rules.md": "# Rules\n",
  };
  const spec = {
    runtime: RUNTIME,
    skills: { allow_always: [] },
    states: {
      start: { triggers: { manual: null }, skills: { allow: ["orders"] }, transitions: [{ to: "done", description: "Test edge to done." }] },
      done: { skills: { allow: [] } },
    },
  };

  it("refuses a read inside a bundle the state does not enable, and admits an enabled one", async () => {
    const { agent, events } = await assemble(workspaceWith(spec, files), {
      turns: [
        { tool: "read_file", args: { file_path: "skills/orders/assets/orders.json" } },
        { tool: "read_file", args: { file_path: "skills/policy/assets/rules.md" } },
        { reply: "ok" },
      ],
    });
    const { messages } = await turn(agent, "s1", "go");

    expect(eventsOf(events, "skills-loaded")[0]?.names).toEqual(["orders", "policy"]);
    expect(blockedTools(events)).toEqual(["read_file"]);
    const blocked = eventsOf(events, "tool-blocked")[0];
    expect(blocked?.reason).toMatch(/skill 'policy'/);
    expect(blocked?.reason).toMatch(/not enabled in state 'start'/);
    const reads = toolResults(messages).filter((r) => r.name === "read_file");
    expect(reads[0]?.content).toContain("ORD-1");
    expect(reads[1]?.status).toBe("error");
  });

  it("enables nothing in a state declaring an empty allow list", async () => {
    const { agent, events } = await assemble(workspaceWith(spec, files), {
      turns: [
        advanceTo("done"),
        { tool: "read_file", args: { file_path: "skills/orders/assets/orders.json" } },
        { tool: "grep", args: { pattern: "ORD", path: "skills/orders" } },
        { reply: "ok" },
      ],
    });
    await turn(agent, "s1", "go");
    expect(blockedTools(events)).toEqual(["read_file", "grep"]);
    expect(eventsOf(events, "tool-blocked")[0]?.reason).toMatch(/No skill is enabled/);
  });

  it("names only the enabled skills in the state's prompt", async () => {
    const { agent, model } = await assemble(workspaceWith(spec, files), {
      turns: [advanceTo("done"), { reply: "ok" }],
    });
    await turn(agent, "s1", "go");
    const [inStart, inDone] = model.calls;
    expect(inStart?.systemPrompt).toContain("orders");
    expect(inStart?.systemPrompt).not.toContain("Refund policy");
    expect(inDone?.systemPrompt).not.toContain("Order records");
  });

  it("enables nothing in a state that declares no skills block", async () => {
    // Under the superseded root `allow`, the root list is a ceiling, not a grant:
    // a state reaches a bundle only by naming it, exactly as it reaches a tool
    // only by allowing it.
    const saysNothing = {
      ...spec,
      states: { start: { triggers: { manual: null } } },
    };
    const { agent, events, model } = await assemble(workspaceWith(saysNothing, files), {
      turns: [
        { tool: "read_file", args: { file_path: "skills/orders/assets/orders.json" } },
        { tool: "ls", args: { path: "skills" } },
        { reply: "ok" },
      ],
    });
    const { messages } = await turn(agent, "s1", "go");

    // Refused, unnamed in the prompt, and invisible to a listing.
    expect(blockedTools(events)).toEqual(["read_file"]);
    expect(eventsOf(events, "tool-blocked")[0]?.reason).toMatch(/No skill is enabled/);
    // The heading form: the platform prompt names the section in prose, so a bare
    // phrase match would find that instead of the rendered section.
    expect(model.calls[0]?.systemPrompt).not.toContain("## Skills available in this state");
    expect(model.calls[0]?.systemPrompt).not.toContain("Order records");
    const listing = toolResults(messages).find((r) => r.name === "ls");
    expect(listing?.content).not.toContain("orders");
    expect(listing?.content).not.toContain("policy");
  });
});

describe("tools.forbid on a state", () => {
  // The workflow grants a tool everywhere; one state opts out of it.
  const spec = {
    runtime: RUNTIME,
    tools: { allow_always: [{ tool: "write_file" }] },
    states: {
      route: {
        triggers: { manual: null },
        tools: { forbid: [{ tool: "write_file" }] },
        transitions: [{ to: "work", description: "Test edge to work." }],
      },
      work: { transitions: [{ to: "done", description: "Test edge to done." }] },
      done: {},
    },
  };

  it("blocks a tool the workflow grants everywhere, and only in that state", async () => {
    const { agent, events, model } = await assemble(workspaceWith(spec), {
      turns: [
        { tool: "write_file", args: { file_path: "scratchpad/a.txt", content: "x" } },
        advanceTo("work"),
        { tool: "write_file", args: { file_path: "scratchpad/b.txt", content: "y" } },
        { reply: "ok" },
      ],
    });
    const { messages } = await turn(agent, "s1", "go");

    expect(blockedTools(events)).toEqual(["write_file"]);
    const blocked = eventsOf(events, "tool-blocked")[0];
    expect(blocked?.reason).toMatch(/forbidden by state 'route'/);
    expect(blocked?.reason).toMatch(/A denial beats every grant/);
    // Undisclosed where it is denied, disclosed where the grant still reaches.
    expect(model.calls[0]?.tools).not.toContain("write_file");
    expect(model.calls.at(-1)?.tools).toContain("write_file");
    const writes = toolResults(messages).filter((r) => r.name === "write_file");
    expect(writes[0]?.status).toBe("error");
    expect(writes[1]?.status).not.toBe("error");
  });
});

describe("skills.forbid on a state", () => {
  const files = {
    "skills/orders/SKILL.md": skillMarkdown("orders", "Order records."),
    "skills/orders/assets/orders.json": '[{"id":"ORD-1"}]',
  };
  // Granted in every state, taken away in the routing state — the shape the
  // always-on grant could not express before.
  const spec = {
    runtime: RUNTIME,
    skills: { allow_always: ["orders"] },
    states: {
      route: {
        triggers: { manual: null },
        skills: { forbid: ["orders"] },
        transitions: [{ to: "work", description: "Test edge to work." }],
      },
      work: { transitions: [{ to: "done", description: "Test edge to done." }] },
      done: {},
    },
  };

  it("makes a workflow-granted bundle unreadable, undisclosed and unlisted there", async () => {
    const { agent, events, model } = await assemble(workspaceWith(spec, files), {
      turns: [
        { tool: "read_file", args: { file_path: "skills/orders/assets/orders.json" } },
        { tool: "ls", args: { path: "skills" } },
        advanceTo("work"),
        { tool: "read_file", args: { file_path: "skills/orders/assets/orders.json" } },
        { reply: "ok" },
      ],
    });
    const { messages } = await turn(agent, "s1", "go");

    expect(blockedTools(events)).toEqual(["read_file"]);
    const blocked = eventsOf(events, "tool-blocked")[0];
    expect(blocked?.reason).toMatch(/state 'route' forbids/);
    expect(model.calls[0]?.systemPrompt).not.toContain("Order records");
    const listing = toolResults(messages).find((r) => r.name === "ls");
    expect(listing?.content).not.toContain("orders");
    // The next state keeps the workflow's grant.
    expect(model.calls.at(-1)?.systemPrompt).toContain("Order records");
    const reads = toolResults(messages).filter((r) => r.name === "read_file");
    expect(reads[1]?.content).toContain("ORD-1");
  });
});

describe("skills.allow_always at the workflow root", () => {
  const files = {
    "skills/orders/SKILL.md": skillMarkdown("orders", "Order records."),
    "skills/orders/assets/orders.json": '[{"id":"ORD-1"}]',
    "skills/policy/SKILL.md": skillMarkdown("policy", "Refund policy."),
    "skills/policy/assets/rules.md": "# Rules\n",
  };
  // The tools shape, for skills: the root grants `orders` everywhere, and a state
  // adds `policy` where it needs it.
  const spec = {
    runtime: RUNTIME,
    skills: { allow_always: ["orders"] },
    states: {
      start: { triggers: { manual: null }, transitions: [{ to: "review", description: "Test edge to review." }] },
      review: { skills: { allow: ["policy"] } },
    },
  };

  it("grants and discloses the always-on bundle in a state that declares no block", async () => {
    const { agent, events, model } = await assemble(workspaceWith(spec, files), {
      turns: [
        { tool: "read_file", args: { file_path: "skills/orders/assets/orders.json" } },
        { tool: "read_file", args: { file_path: "skills/policy/assets/rules.md" } },
        { tool: "ls", args: { path: "skills" } },
        { reply: "ok" },
      ],
    });
    const { messages } = await turn(agent, "s1", "go");

    // Enabled with no state entry and no `tools.allow` path entry beside it…
    const reads = toolResults(messages).filter((r) => r.name === "read_file");
    expect(reads[0]?.content).toContain("ORD-1");
    // …while a bundle no list names is still refused here.
    expect(blockedTools(events)).toEqual(["read_file"]);
    expect(eventsOf(events, "tool-blocked")[0]?.reason).toMatch(/skill 'policy'/);
    expect(reads[1]?.status).toBe("error");

    expect(model.calls[0]?.systemPrompt).toContain("Order records");
    expect(model.calls[0]?.systemPrompt).not.toContain("Refund policy");
    const listing = toolResults(messages).find((r) => r.name === "ls");
    expect(listing?.content).toContain("orders");
    expect(listing?.content).not.toContain("policy");
  });

  it("adds a state's own list to the always-on grant", async () => {
    const { agent, events, model } = await assemble(workspaceWith(spec, files), {
      turns: [
        advanceTo("review"),
        { tool: "read_file", args: { file_path: "skills/policy/assets/rules.md" } },
        { tool: "read_file", args: { file_path: "skills/orders/assets/orders.json" } },
        { reply: "ok" },
      ],
    });
    const { messages } = await turn(agent, "s1", "go");

    expect(blockedTools(events)).toEqual([]);
    const reads = toolResults(messages).filter((r) => r.name === "read_file");
    expect(reads[0]?.content).toContain("Rules");
    expect(reads[1]?.content).toContain("ORD-1");
    const inReview = model.calls[1];
    expect(inReview?.systemPrompt).toContain("Refund policy");
    expect(inReview?.systemPrompt).toContain("Order records");
  });
});

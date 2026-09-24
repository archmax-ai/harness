import { describe, expect, it } from "vitest";
import {
  assemble,
  blockedTools,
  eventsOf,
  skillMarkdown,
  toolResults,
  turn,
  workspaceWith,
} from "./support.js";

const RUNTIME = { engine: "archmax-harness", version: "2" };

/**
 * `archmax_run` is always-on, but which scripts it may execute is governed by the
 * state's enabled skills: a script inside a bundle the state does not enable is
 * refused exactly like a read inside it would be.
 */
describe("archmax_run under skills.allow", () => {
  const files = {
    "skills/orders/SKILL.md": skillMarkdown("orders", "Order records."),
    "skills/orders/scripts/list.js": "1 + 1;",
    "skills/policy/SKILL.md": skillMarkdown("policy", "Refund policy."),
    "skills/policy/scripts/check.js": "2 + 2;",
  };
  const spec = {
    runtime: RUNTIME,
    skills: { allow_always: [] },
    states: {
      start: { triggers: { manual: null }, skills: { allow: ["orders"] }, transitions: [{ to: "none", description: "Test edge to none." }] },
      none: { skills: { allow: [] } },
    },
  };

  it("runs a script from an enabled bundle and refuses one from a bundle the state does not enable", async () => {
    const { agent, events } = await assemble(workspaceWith(spec, files), {
      turns: [
        { tool: "archmax_run", args: { file_path: "skills/orders/scripts/list.js" } },
        { tool: "archmax_run", args: { file_path: "skills/policy/scripts/check.js" } },
        { reply: "ok" },
      ],
    });
    const { messages } = await turn(agent, "run-1", "go");

    expect(blockedTools(events)).toEqual(["archmax_run"]);
    expect(eventsOf(events, "tool-blocked")[0]?.reason).toMatch(/skill 'policy'/);
    const runs = toolResults(messages).filter((r) => r.name === "archmax_run");
    expect(runs[0]?.status).not.toBe("error");
    expect(runs[1]?.status).toBe("error");
  });

  it("refuses every skill script in a state that enables no skill", async () => {
    const { agent, events } = await assemble(workspaceWith(spec, files), {
      turns: [
        { tool: "archmax_advance", args: { to: "none", reason: "move" } },
        { tool: "archmax_run", args: { file_path: "skills/orders/scripts/list.js" } },
        { reply: "ok" },
      ],
    });
    await turn(agent, "run-2", "go");

    expect(blockedTools(events)).toEqual(["archmax_run"]);
    expect(eventsOf(events, "tool-blocked")[0]?.reason).toMatch(/skill 'orders'/);
  });
});

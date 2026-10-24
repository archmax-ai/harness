import { describe, expect, it } from "vitest";
import type { StructuredTool } from "@langchain/core/tools";
import type { WorkflowEventInput } from "../core/events.js";
import { NO_MOUNTS } from "../core/zones.js";
import { WorkflowMachine } from "../machine/machine.js";
import type { MachineSpec } from "../machine/types.js";
import { createAutomatedControls, createStepRecorder } from "./automated-controls.js";

const spec = {
  states: {
    check: {
      type: "code",
      script: "scripts/check.js",
      triggers: { manual: null },
      requires: ["verdict"],
      transitions: [
        { to: "done", description: "Checked." },
        { to: "review", description: "Needs a person." },
      ],
    },
    grade: {
      type: "grader",
      instructions: "Grade it.",
      transitions: [{ to: "done", description: "Fine." }],
    },
    review: { type: "human", instructions: "Review.", transitions: [{ to: "done", description: "Approve." }] },
    done: { type: "code", script: "scripts/done.js" },
  },
} as unknown as MachineSpec;

const machine = WorkflowMachine.fromSpec(spec);

function controls(state: string, session: unknown = {}) {
  const events: WorkflowEventInput[] = [];
  const writes: unknown[] = [];
  const recorder = createStepRecorder(state, session, (store) => writes.push(store));
  const tools = createAutomatedControls(
    { machine, emit: (event) => events.push(event), mountPrefixes: NO_MOUNTS },
    recorder,
    { messages: [{ role: "user", text: "hi" }], trail: [] },
  );
  const byName = (name: string) => tools.find((tool) => tool.name === name) as StructuredTool;
  return { recorder, tools, byName, events, writes };
}

describe("an automated state's controls", () => {
  it("are the automated control set, in order, for a code state and a grader alike", () => {
    const names = [
      "archmax_advance",
      "archmax_raise",
      "archmax_get_variables",
      "archmax_set_variables",
      "archmax_get_history",
    ];
    expect(controls("check").tools.map((tool) => tool.name)).toEqual(names);
    expect(controls("grade").tools.map((tool) => tool.name)).toEqual(names);
    // A terminal state is not offered the advance.
    expect(controls("done").tools.map((tool) => tool.name)).not.toContain("archmax_advance");
  });

  it("validate an advance against the live store and record one decision", async () => {
    const { recorder, byName, writes } = controls("check");
    await expect(byName("archmax_advance").invoke({ to: "done", reason: "early" })).rejects.toThrow(
      /cannot leave 'check' yet: 'verdict' is not set/,
    );
    await byName("archmax_set_variables").invoke({ variables: { verdict: "ok" } });
    expect(writes).toHaveLength(1);
    await expect(byName("archmax_advance").invoke({ to: "nowhere", reason: "x" })).rejects.toThrow(
      /Valid target slugs: done, review/,
    );
    await byName("archmax_advance").invoke({ to: "done", reason: "checked" });
    expect(recorder.decision).toMatchObject({ kind: "advance", to: "done", reason: "checked", evidence: [] });
    expect(recorder.delta).toEqual({ verdict: { value: "ok", locked: false } });

    await expect(byName("archmax_raise").invoke({ code: "late", reason: "too late" })).rejects.toThrow(
      /already moves the session to 'done'/,
    );
    await expect(byName("archmax_advance").invoke({ to: "review", reason: "again" })).rejects.toThrow(
      /One decision per state/,
    );
  });

  it("accept evidence only into a human state", async () => {
    const { byName } = controls("check", { variables: { verdict: { value: "ok", locked: false } } });
    await expect(
      byName("archmax_advance").invoke({ to: "done", reason: "x", evidence: ["scratchpad/a.json"] }),
    ).rejects.toThrow(/evidence can only be attached when advancing into a human decision state/);
    await byName("archmax_advance").invoke({ to: "review", reason: "x", evidence: ["scratchpad/a.json"] });
  });

  it("read and write variables as the agent's own tools do, locks included", async () => {
    const { byName, events } = controls("check", { variables: { seeded: { value: 1, locked: true } } });
    expect(JSON.parse(await byName("archmax_get_variables").invoke({ name: "seeded" }))).toEqual({
      value: 1,
      locked: true,
    });
    await expect(byName("archmax_set_variables").invoke({ variables: { seeded: 2 } })).rejects.toThrow(/is locked/);
    await byName("archmax_set_variables").invoke({ variables: { note: "x" } });
    expect(events).toEqual([expect.objectContaining({ type: "variables-set", state: "check", names: ["note"] })]);
  });

  it("hand a grader and a code state the same history", async () => {
    for (const state of ["grade", "check"]) {
      const history = JSON.parse(await controls(state).byName("archmax_get_history").invoke({}));
      expect(history).toEqual({ messages: [{ role: "user", text: "hi" }], trail: [] });
    }
  });
});

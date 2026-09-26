import { describe, expect, it } from "vitest";
import { WorkflowMachine } from "../machine/machine.js";
import type { MachineSpec } from "../machine/types.js";
import { renderStateGraph, renderWorkflowPrompt } from "./render-prompt.js";

/** Render the cacheable half the way the harness does: through the machine built from the spec. */
const render = (spec: MachineSpec): string => renderWorkflowPrompt(WorkflowMachine.fromSpec(spec));

/** Render the volatile half for one state of a spec. */
const graph = (spec: MachineSpec, state: string, trigger?: string): string =>
  renderStateGraph(WorkflowMachine.fromSpec(spec), state, trigger ? { trigger } : {}) ?? "";

const SPEC: MachineSpec = {
  title: "Order lookup",
  instructions: "Cite an order id in every answer.\n\nNever promise a refund.",
  states: {
    "identify-case": {
      triggers: { manual: null },
      instructions: "Route the request down exactly one path.",
      before: { script: "hooks/check-requester.js" },
      transitions: [
        { to: "orders-question", description: "Order questions." },
        { to: "refund-review", description: "Refunds." },
      ],
    },
    "orders-question": {
      instructions: "Answer from data/orders.json.",
      after: { rubric: { instructions: "Grade the reply against the order data." } },
    },
    "refund-review": {
      type: "human",
      instructions: "A human confirms the decision.",
      approvers: ["support-lead"],
      transitions: [{ to: "orders-question", type: "approve", description: "Approve." }],
    },
  },
};

describe("renderWorkflowPrompt — the cacheable half", () => {
  it("is deterministic (same spec, byte-identical output)", () => {
    expect(render(SPEC)).toBe(render(SPEC));
  });

  it("renders the title and the standing instructions, and nothing else", () => {
    expect(render(SPEC)).toBe(
      "# Workflow: Order lookup\n\n## Instructions\n\n" +
        "Cite an order id in every answer.\n\nNever promise a refund.",
    );
  });

  /**
   * The disclosure invariant, stated as an assertion: a state the agent cannot
   * advance to is a state it cannot name. Nothing of the graph is in the prefix,
   * so nothing of it is billed on calls made from anywhere else in the machine.
   */
  it("names no state, no marker and no transition", () => {
    const text = render(SPEC);
    for (const absent of [
      "identify-case",
      "orders-question",
      "refund-review",
      "## States",
      "start state",
      "human decision node",
      "terminal",
      "Hooks:",
      "rubric",
      "Order questions.",
      "support-lead",
      // A state's `instructions` body was never in the prefix and still is not.
      "Route the request down exactly one path.",
    ]) {
      expect(text).not.toContain(absent);
    }
  });

  // The token argument, as a test: the prefix is a function of the header alone.
  it("does not grow with the graph", () => {
    const header = { title: "Same", instructions: "Same standing rules." };
    const one: MachineSpec = { ...header, states: { only: { triggers: { manual: null } } } };
    const many: MachineSpec = {
      ...header,
      states: Object.fromEntries([
        ["s0", { triggers: { manual: null }, transitions: [{ to: "s1", description: "Onward." }] }],
        ...Array.from({ length: 18 }, (_, i) => [
          `s${i + 1}`,
          {
            summary: `State ${i + 1}.`,
            instructions: `Do step ${i + 1}.`,
            transitions: [{ to: `s${i + 2}`, description: "Onward." }],
          },
        ]),
        ["s19", {}],
      ]) as MachineSpec["states"],
    };
    expect(render(many)).toBe(render(one));
  });

  it("omits the instructions block entirely when the field is absent or blank", () => {
    for (const spec of [
      { title: "Bare", states: { only: { triggers: { manual: null } } } },
      { title: "Bare", instructions: "   \n ", states: { only: { triggers: { manual: null } } } },
    ] satisfies MachineSpec[]) {
      expect(render(spec)).toBe("# Workflow: Bare");
    }
  });

  it("renders a minimal spec without optional fields", () => {
    expect(render({ states: { only: { triggers: { manual: null } } } })).toBe("# Workflow");
  });

  // The block is billed on every model call if it leaks in, and buys the model
  // nothing: it describes where a node sits on someone's canvas.
  it("renders nothing from host presentation metadata", () => {
    const text = render({
      ...SPEC,
      editor: { nodes: { "identify-case": { x: 0, y: 40 } }, edges: {} },
    } as MachineSpec);
    expect(text).toBe(render(SPEC));
  });

  // An assembled disabled workflow only ever runs turns that began while it was
  // enabled, so the fact is not actionable by that agent.
  it("renders byte-identically with and without the disabled flag", () => {
    expect(render({ ...SPEC, disabled: true })).toBe(render(SPEC));
  });

  it("takes no options at all", () => {
    expect(renderWorkflowPrompt.length).toBe(1);
  });

  // A spec carrying the retired setting renders exactly as one without it.
  it("ignores a retired settings.prompt block rather than honouring it", () => {
    const withSetting = { ...SPEC, settings: { prompt: { profile: "full" } } } as unknown as MachineSpec;
    expect(render(withSetting)).toBe(render(SPEC));
  });
});

describe("renderStateGraph — the volatile half", () => {
  it("is deterministic (same spec and state, byte-identical output)", () => {
    expect(graph(SPEC, "identify-case")).toBe(graph(SPEC, "identify-case"));
  });

  it("discloses the active state's edges with their descriptions", () => {
    const text = graph(SPEC, "identify-case");
    expect(text).toContain(
      "Transitions — choose one with `archmax_advance` when this state's work is done:",
    );
    expect(text).toContain("- to `orders-question` (terminal) — Order questions.");
    expect(text).toContain("- to `refund-review` (human decision node) — Refunds.");
  });

  /**
   * The governance requirement, as an assertion: only the active state's edges.
   * `refund-review` is disclosed as a target, so its slug appears — but nothing
   * of the state behind it does, and a state no edge reaches is not named.
   */
  it("discloses nothing of a target beyond its slug and the edge's markers", () => {
    const text = graph(SPEC, "identify-case");
    for (const absent of [
      "A human confirms the decision.", // the target's instructions
      "support-lead", // its approvers
      "- to `orders-question` (approve)", // its own outgoing edge
      "Answer from data/orders.json.", // the other target's instructions
      "rubric", // the other target's hooks
    ]) {
      expect(text).not.toContain(absent);
    }
  });

  it("names no state that no edge from here reaches", () => {
    const spec: MachineSpec = {
      states: {
        triage: { triggers: { manual: null }, transitions: [{ to: "answer", description: "Answer it." }] },
        answer: { transitions: [{ to: "closed", description: "Done." }] },
        escalate: { summary: "Hand to tier 2.", transitions: [{ to: "closed", description: "Done." }] },
        closed: {},
      },
    };
    const text = graph(spec, "triage");
    expect(text).toContain("- to `answer` — Answer it.");
    expect(text).not.toContain("escalate");
    expect(text).not.toContain("closed");
  });

  it("marks a terminal target so the work is finished before the call", () => {
    expect(graph(SPEC, "identify-case")).toContain("(terminal) — Order questions.");
  });

  it("carries the declared type alongside the markers", () => {
    const text = graph(SPEC, "refund-review");
    expect(text).toContain("- to `orders-question` (approve, terminal) — Approve.");
  });

  // With the whole-graph listing gone there is nothing to infer terminality from,
  // so it is stated.
  it("states terminality rather than leaving it to an absent list", () => {
    const text = graph(SPEC, "orders-question");
    expect(text).toContain(
      "This state is terminal: no transition leads out of it. Finish its work and stop.",
    );
    expect(text).not.toContain("Transitions");
  });

  it("discloses a rubric hook by kind only", () => {
    const text = graph(SPEC, "orders-question");
    expect(text).toContain("Hooks: after: rubric");
    expect(text).not.toContain("Grade the reply against the order data.");
  });

  it("discloses a script hook by its path, in phase order", () => {
    expect(graph(SPEC, "identify-case")).toContain("Hooks: before: hooks/check-requester.js");
  });

  it("renders no hooks line for a state that declares none", () => {
    expect(graph(SPEC, "refund-review")).not.toContain("Hooks:");
  });

  describe("the run's trigger signature", () => {
    const signed: MachineSpec = {
      states: {
        enrich: {
          triggers: {
            "sub-workflow": { requires: ["order_id"], returns: ["enrichment_file", "delayed"] },
          },
          transitions: [{ to: "done", description: "Every order is enriched." }],
        },
        ask: { triggers: { manual: { returns: ["answer"] } }, transitions: [{ to: "done", description: "Answered." }] },
        done: {},
      },
    };

    it("names the inputs the run arrived with", () => {
      expect(graph(signed, "enrich", "sub-workflow")).toContain(
        "This run was started with: order_id.",
      );
    });

    it("names the returns and how they are set", () => {
      const text = graph(signed, "enrich", "sub-workflow");
      expect(text).toContain(
        "This run must set enrichment_file, delayed with `archmax_set_variables`",
      );
      expect(text).toContain("does not complete until every one is set");
    });

    /**
     * The signature follows the run, not the graph: a sibling trigger's contract
     * is another way of starting this workflow, which this run cannot take and
     * so must not be billed for or told about.
     */
    it("discloses nothing of a trigger this run did not start with", () => {
      const text = graph(signed, "enrich", "sub-workflow");
      expect(text).not.toContain("answer");
      expect(text).not.toContain("manual");
      // And from the other entry state, the reverse.
      const other = graph(signed, "ask", "manual");
      expect(other).toContain("This run must set answer");
      expect(other).not.toContain("enrichment_file");
    });

    describe("typed entries", () => {
      const typed: MachineSpec = {
        states: {
          refund: {
            triggers: {
              manual: {
                description: "Refund one order.",
                requires: ["order_id", { name: "due", type: "date", description: "The day the refund is due." }],
                returns: [{ name: "total", type: "number", description: "Refunded amount in EUR." }, "note"],
              },
            },
            transitions: [{ to: "done", description: "Refunded." }],
          },
          done: {},
        },
      };

      it("renders each entry on its own line with its type and description", () => {
        const text = graph(typed, "refund", "manual");
        expect(text).toContain(
          ["This run was started with:", "- order_id", "- due (date) — The day the refund is due."].join("\n"),
        );
        expect(text).toContain(
          [
            "This run must set these with `archmax_set_variables` — it does not complete until every one is set:",
            "- total (number) — Refunded amount in EUR.",
            "- note",
          ].join("\n"),
        );
      });

      it("never renders the declaration's description, which is for a caller", () => {
        expect(graph(typed, "refund", "manual")).not.toContain("Refund one order.");
      });

      it("renders a type without a description, and a description without a type", () => {
        const text = graph(
          {
            states: {
              a: { triggers: { manual: { requires: [{ name: "n", type: "integer" }, { name: "why", description: "Reason." }] } } },
            },
          },
          "a",
          "manual",
        );
        expect(text).toContain("- n (integer)\n- why — Reason.");
      });

      it("is deterministic for one signature", () => {
        expect(graph(typed, "refund", "manual")).toBe(graph(typed, "refund", "manual"));
      });
    });

    it("renders no signature when the run's trigger is unknown or unsigned", () => {
      expect(graph(signed, "enrich")).not.toContain("This run");
      expect(graph(signed, "enrich", "ghost")).not.toContain("This run");
      const unsigned: MachineSpec = {
        states: { ask: { triggers: { manual: null }, transitions: [{ to: "done", description: "Answered." }] }, done: {} },
      };
      expect(graph(unsigned, "ask", "manual")).not.toContain("This run");
    });
  });

  it("returns null for a state the spec does not declare", () => {
    expect(renderStateGraph(WorkflowMachine.fromSpec(SPEC), "ghost")).toBeNull();
  });

  // Movement mechanics — one state at a time, that the slug is what `to` takes,
  // that terminal means stop — belong to the platform graph-state prompt, which
  // owns them; restating them here would bill every model call twice.
  it("leaves movement mechanics to the platform prompt", () => {
    const text = graph(SPEC, "identify-case");
    expect(text).not.toContain("archmax_reset");
    expect(text).not.toContain("never a target");
    expect(text).not.toContain("## Reading the graph");
    expect(text).not.toContain("## Execution rules");
  });
});

import { describe, expect, it } from "vitest";
import { WorkflowMachine } from "../machine/machine.js";
import type { MachineSpec } from "../machine/types.js";
import { renderStateGraph, renderTransitions, renderWorkflowPrompt } from "./render-prompt.js";

/** Render the cacheable half the way the harness does: through the machine built from the spec. */
const render = (spec: MachineSpec): string => renderWorkflowPrompt(WorkflowMachine.fromSpec(spec));

/** Render the volatile half for one state of a spec. */
const graph = (spec: MachineSpec, state: string, trigger?: string, child = false): string =>
  renderStateGraph(WorkflowMachine.fromSpec(spec), state, { ...(trigger ? { trigger } : {}), child }) ?? "";

const SPEC: MachineSpec = {
  title: "Order lookup",
  instructions: "Cite an order id in every answer.\n\nNever promise a refund.",
  states: {
    "identify-case": {
      triggers: { manual: null },
      instructions: "Route the request down exactly one path.",
      transitions: [
        { to: "orders-question", description: "Order questions." },
        { to: "refund-review", description: "Refunds." },
      ],
    },
    "orders-question": {
      instructions: "Answer from data/orders.json.",
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

  it("discloses an edge's description and markers, and nothing of its target", () => {
    const spec: MachineSpec = {
      states: {
        triage: {
          triggers: { manual: null },
          transitions: [{ to: "lookup", type: "refine", description: "The order id is known." }],
        },
        lookup: {
          title: "Look up the order",
          summary: "Order lookup.",
          instructions: "Look the order up by its id.",
          tools: { allow: ["web_fetch"] },
          transitions: [{ to: "closed", description: "Done." }],
        },
        closed: {},
      },
    };
    const text = graph(spec, "triage");
    expect(text).toContain("- to `lookup` (refine) — The order id is known.");
    for (const absent of ["Look up the order", "Order lookup.", "Look the order up", "web_fetch", "closed"]) {
      expect(text).not.toContain(absent);
    }
  });

  /**
   * A lone undescribed edge has nothing to choose and no condition of its own:
   * the agent is told to take it once the state's instructions are done, and
   * not to wait for a go-ahead, and still nothing of the target is disclosed.
   */
  it("introduces a lone undescribed edge as the way on once the state's instructions are done", () => {
    const spec: MachineSpec = {
      states: {
        draft: { triggers: { manual: null }, instructions: "Draft the reply.", transitions: [{ to: "send" }] },
        send: { title: "Send it", instructions: "Send the reply with send_email." },
      },
    };
    expect(graph(spec, "draft")).toBe(
      [
        "Transition — the only one out of this state, with no condition of its own: take it with " +
          "`archmax_advance` as soon as this state's instructions are done, without asking anyone " +
          "whether to move on.",
        "- to `send` (terminal)",
      ].join("\n"),
    );
    expect(renderTransitions(WorkflowMachine.fromSpec(spec), "draft")).toEqual(["- to `send` (terminal)"]);
  });

  it("introduces a lone described edge like any other", () => {
    const spec: MachineSpec = {
      states: {
        draft: {
          triggers: { manual: null },
          instructions: "Draft the reply.",
          transitions: [{ to: "send", description: "The customer approved the draft." }],
        },
        send: { instructions: "Send the reply." },
      },
    };
    expect(graph(spec, "draft")).toBe(
      [
        "Transitions — choose one with `archmax_advance` when this state's work is done:",
        "- to `send` (terminal) — The customer approved the draft.",
      ].join("\n"),
    );
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

  /**
   * A grader or a code state runs on its own once entered and may send the run
   * straight back with a note — a consequence of taking the edge, so it is
   * marked. What it checks is not: neither its instructions nor its script.
   */
  describe("automated targets", () => {
    const automated: MachineSpec = {
      states: {
        draft: {
          triggers: { manual: null },
          transitions: [
            { to: "review-reply", description: "The reply is drafted." },
            { to: "check-refund", description: "A refund is recorded." },
          ],
        },
        "review-reply": {
          type: "grader",
          instructions: "Grade the reply against the order data.",
          transitions: [
            { to: "draft", type: "reject", description: "Send it back." },
            { to: "record", type: "approve", description: "Approve it." },
          ],
        },
        "check-refund": {
          type: "code",
          script: "scripts/check-refund.js",
          transitions: [{ to: "record", description: "The refund matches the policy." }],
        },
        record: { type: "code", script: "scripts/record.js" },
      },
    };

    it("marks a grader target and a code target", () => {
      const text = graph(automated, "draft");
      expect(text).toContain("- to `review-reply` (grader) — The reply is drafted.");
      expect(text).toContain("- to `check-refund` (code) — A refund is recorded.");
    });

    it("carries the declared type and terminality beside the marker", () => {
      expect(graph(automated, "review-reply")).toContain("- to `record` (approve, code, terminal) — Approve it.");
    });

    it("discloses nothing of what the automated target checks", () => {
      const text = graph(automated, "draft");
      expect(text).not.toContain("Grade the reply against the order data.");
      expect(text).not.toContain("scripts/");
      expect(text).not.toContain("Send it back.");
    });

    it("leaves the cacheable half unaware of them", () => {
      const text = render(automated);
      for (const absent of ["grader", "code", "review-reply", "check-refund"]) {
        expect(text).not.toContain(absent);
      }
    });
  });

  // A grader's task message renders the same lines, so what it may choose reads
  // exactly as an agent in that state would read it.
  it("renders each edge as one line, the lines the graph section lists", () => {
    const machine = WorkflowMachine.fromSpec(SPEC);
    expect(renderTransitions(machine, "identify-case")).toEqual([
      "- to `orders-question` (terminal) — Order questions.",
      "- to `refund-review` (human decision node) — Refunds.",
    ]);
    expect(graph(SPEC, "identify-case")).toContain(renderTransitions(machine, "identify-case").join("\n"));
    expect(renderTransitions(machine, "orders-question")).toEqual([]);
    expect(renderTransitions(machine, "ghost")).toEqual([]);
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

    it("names the returns, how they are set, and what finishing without them does", () => {
      const text = graph(signed, "enrich", "sub-workflow");
      expect(text).toContain(
        "This run must set enrichment_file, delayed with `archmax_set_variables`",
      );
      expect(text).toContain("before it finishes — finishing without every one set ends it rejected.");
    });

    it("tells a sub-workflow child its caller gets what it set, and the rest empty with a note", () => {
      const text = graph(signed, "enrich", "sub-workflow", true);
      expect(text).toContain(
        "This run must set enrichment_file, delayed with `archmax_set_variables` before it finishes — " +
          "your caller gets the ones you set, and any you leave unset as empty, with a note naming them.",
      );
      expect(text).not.toContain("rejected");
    });

    // Rendered in every state, so it must not read as "set these now": a return
    // written, let alone locked, before the work settles it is a guess the caller gets.
    it("says a return is set once final, is not needed to move, and is locked only when final", () => {
      const timing =
        "Set each once its final value is known — moving to another state does not need it — and " +
        "lock one only when it is final: a locked return can no longer change.";
      expect(graph(signed, "enrich", "sub-workflow", true)).toContain(`naming them. ${timing}`);
      expect(graph(signed, "enrich", "sub-workflow")).toContain(`ends it rejected. ${timing}`);
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
                returns: [{ name: "total", type: "number", description: "Refunded amount in EUR." }, "remark"],
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
            "This run must set these with `archmax_set_variables` before it finishes — finishing without every one set ends it rejected:",
            "- total (number) — Refunded amount in EUR.",
            "- remark",
            "Set each once its final value is known — moving to another state does not need it — and " +
              "lock one only when it is final: a locked return can no longer change.",
          ].join("\n"),
        );
      });

      it("renders an entry's rules after its type, in the words a refusal uses", () => {
        const text = graph(
          {
            states: {
              a: {
                triggers: {
                  manual: {
                    requires: [
                      { name: "quantity", type: "integer", minimum: 1, maximum: 100 },
                      { name: "due", type: "date", minimum: "today" },
                    ],
                    returns: [
                      { name: "contact", type: "string", format: "email", maxLength: 80, description: "The contact address." },
                      { name: "invoice", type: "file", accept: [".pdf"], maxSize: "10MB" },
                    ],
                  },
                },
              },
            },
          },
          "a",
          "manual",
        );
        expect(text).toContain("- quantity (integer; at least 1; at most 100)\n- due (date; not before today)");
        expect(text).toContain(
          "- contact (string; an email address; at most 80 characters) — The contact address.\n" +
            "- invoice (file; a .pdf file; at most 10 MB)",
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

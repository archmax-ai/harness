import { describe, expect, it, vi } from "vitest";
import { CALLING_STATE_KEY } from "../sessions/scope.js";
import type { DispatchSubWorkflowInput, SubWorkflowResult } from "./sub-workflow.js";
import {
  createDelegationTool,
  delegationCallResult,
  delegationToolDescription,
  delegationToolSchema,
} from "./workflow-tools.js";

const SIGNED = {
  workflow: "enrich-order",
  title: "Order enrichment",
  requires: [{ name: "order_id" }],
  returns: [{ name: "enrichment_file" }, { name: "delayed" }],
};
const UNSIGNED = { workflow: "audit" };

/** A dispatcher recording what it was asked for, answering with a fixed result. */
function stubDispatcher(result: Partial<SubWorkflowResult> = {}) {
  const calls: DispatchSubWorkflowInput[] = [];
  return {
    calls,
    refusal: vi.fn(async () => undefined),
    drainDispatches: vi.fn(() => []),
    release: vi.fn(),
    signature: vi.fn(async () => ({})),
    resume: vi.fn(async () => ({ result: "resumed", workflow: "w", state: "done" })),
    dispatch: vi.fn(async (input: DispatchSubWorkflowInput) => {
      calls.push(input);
      return {
        result: "done",
        workflow: input.workflow,
        state: "finished",
        ...result,
      } as SubWorkflowResult;
    }),
  };
}

describe("delegation tool schema", () => {
  it("declares one required property per declared requires", () => {
    expect(delegationToolSchema(SIGNED)).toMatchObject({
      type: "object",
      required: ["order_id"],
      properties: { order_id: { description: expect.stringContaining("order_id") } },
    });
  });

  it("stays open to undeclared optional inputs", () => {
    // `requires` states only what is mandatory; nothing declares the full
    // accepted set, so the schema cannot be closed without an `accepts:` half.
    expect(delegationToolSchema(SIGNED).additionalProperties).toBe(true);
  });

  it("names nothing for a target that requires nothing", () => {
    expect(delegationToolSchema(UNSIGNED)).toMatchObject({ required: [], properties: {} });
  });

  it("uses no root anyOf/oneOf, which strict-mode endpoints reject", () => {
    const schema = delegationToolSchema(SIGNED);
    expect(schema.anyOf).toBeUndefined();
    expect(schema.oneOf).toBeUndefined();
  });

  it("declares no fan-out property — one call runs one sub-run", () => {
    const properties = delegationToolSchema(SIGNED).properties as Record<string, unknown>;
    expect(Object.keys(properties)).toEqual(["order_id"]);
  });
});

describe("a typed delegation tool schema", () => {
  const TYPED = {
    workflow: "refund",
    requires: [
      { name: "order_id" },
      { name: "due", type: "date" as const, description: "The day the refund is due." },
      { name: "quantity", type: "integer" as const, description: "Units to refund" },
    ],
  };

  it("is the signature mapping, with the locked-variable wording in each description", () => {
    expect(delegationToolSchema(TYPED)).toEqual({
      type: "object",
      properties: {
        order_id: { description: "Required input 'order_id', seeded as a locked run variable." },
        due: {
          type: "string",
          format: "date",
          description: "The day the refund is due. Seeded as a locked run variable.",
        },
        quantity: { type: "integer", description: "Units to refund. Seeded as a locked run variable." },
      },
      required: ["order_id", "due", "quantity"],
      additionalProperties: true,
    });
  });
});

describe("delegation tool description", () => {
  it("leads with the entry's description, then the rest in order", () => {
    const description = delegationToolDescription({ ...SIGNED, description: "Enrich one order" });
    expect(description.startsWith("Enrich one order. Run the 'enrich-order' workflow (Order enrichment)")).toBe(
      true,
    );
    expect(description.indexOf("'order_id'")).toBeLessThan(description.indexOf("'enrichment_file'"));
  });

  it("carries nothing it is not given — a target's instructions have no way in", () => {
    const target = { ...SIGNED, instructions: "PRIVATE BRIEF" } as Parameters<typeof delegationToolDescription>[0];
    expect(delegationToolDescription(target)).not.toContain("PRIVATE BRIEF");
    expect(JSON.stringify(delegationToolSchema(target))).not.toContain("PRIVATE BRIEF");
  });

  it("names the workflow, its title, its required inputs and its returns", () => {
    const description = delegationToolDescription(SIGNED);
    expect(description).toContain("'enrich-order'");
    expect(description).toContain("Order enrichment");
    expect(description).toContain("'order_id'");
    expect(description).toContain("'enrichment_file' and 'delayed'");
  });

  it("says the result is the closing message for an unsigned target", () => {
    const description = delegationToolDescription(UNSIGNED);
    expect(description).toContain("closing message");
    expect(description).not.toContain("under 'returns'");
  });

  it("is deterministic", () => {
    expect(delegationToolDescription(SIGNED)).toBe(delegationToolDescription(SIGNED));
  });
});

describe("delegation call result", () => {
  it("carries the declared returns beside the message, never folded in", () => {
    const returns = { enrichment_file: "output/e.json", delayed: true };
    expect(
      delegationCallResult({ result: "Enriched.", workflow: "enrich-order", state: "done", returns }),
    ).toEqual({ message: "Enriched.", returns });
  });

  it("is the message alone for a target that declares no returns", () => {
    expect(delegationCallResult({ result: "Audited.", workflow: "audit", state: "done" })).toBe(
      "Audited.",
    );
  });
});

describe("delegation tool call", () => {
  const invoke = async (
    tool: ReturnType<typeof createDelegationTool>,
    input: Record<string, unknown>,
    configurable: Record<string, unknown> = {},
  ) => tool.invoke(input, { configurable } as never);

  it("is named for its target, with the slug verbatim", () => {
    expect(createDelegationTool(SIGNED, stubDispatcher(), "entry").name).toBe(
      "archmax_workflow_enrich-order",
    );
  });

  it("dispatches the call's arguments as the sub-run's params", async () => {
    const dispatcher = stubDispatcher();
    const tool = createDelegationTool(SIGNED, dispatcher, "entry");
    await invoke(tool, { order_id: "ORD-1003" });

    expect(dispatcher.calls[0]).toMatchObject({
      workflow: "enrich-order",
      params: { order_id: "ORD-1003" },
    });
  });

  it("passes no variables to resolve against", async () => {
    // A call's arguments are values the caller already produced. There is no
    // authored `${{…}}` to substitute, which is what frees the body from needing
    // the dispatching run's state.
    const dispatcher = stubDispatcher();
    await invoke(createDelegationTool(SIGNED, dispatcher, "entry"), { order_id: "A" });
    expect(dispatcher.calls[0]!.variables).toEqual({});
  });

  it("names the state it was called from", async () => {
    const dispatcher = stubDispatcher();
    const tool = createDelegationTool(SIGNED, dispatcher, "entry");
    await invoke(tool, { order_id: "A" }, { [CALLING_STATE_KEY]: "triage" });
    expect(dispatcher.calls[0]!.state).toBe("triage");
  });

  it("falls back to the entry state outside a segment", async () => {
    const dispatcher = stubDispatcher();
    await invoke(createDelegationTool(SIGNED, dispatcher, "entry"), { order_id: "A" });
    expect(dispatcher.calls[0]!.state).toBe("entry");
  });

  it("names the tool call it answers, so concurrent sub-runs stay attributable", async () => {
    const dispatcher = stubDispatcher();
    const tool = createDelegationTool(SIGNED, dispatcher, "entry");
    await tool.invoke(
      { order_id: "A" },
      { configurable: {}, toolCallId: "call-7" } as never,
    );
    expect(dispatcher.calls[0]!.toolCallId).toBe("call-7");
  });

  it("omits the call id when a script invokes it", async () => {
    // A PTC call carries no model-assigned id; the dispatch id still separates it.
    const dispatcher = stubDispatcher();
    await invoke(createDelegationTool(SIGNED, dispatcher, "entry"), { order_id: "A" });
    expect(dispatcher.calls[0]!.toolCallId).toBeUndefined();
  });

  it("dispatches once per call", async () => {
    const dispatcher = stubDispatcher();
    const tool = createDelegationTool(SIGNED, dispatcher, "entry");
    await Promise.all([invoke(tool, { order_id: "A" }), invoke(tool, { order_id: "B" })]);

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
    expect(dispatcher.calls.map((c) => c.params)).toEqual([{ order_id: "A" }, { order_id: "B" }]);
  });
});

describe("a delegation tool says nothing about the target being disabled", () => {
  // The description is built once at assembly, so "currently disabled" would be
  // stale by the time it mattered — and would destabilize the cacheable prefix.
  // The dispatch refusal is what tells the agent, when it matters.
  it("describes a disabled target exactly as an enabled one", () => {
    expect(delegationToolDescription({ ...SIGNED, disabled: true } as typeof SIGNED)).toBe(
      delegationToolDescription(SIGNED),
    );
  });
});

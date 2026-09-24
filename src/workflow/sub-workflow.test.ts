import { describe, expect, it } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { WorkflowMachine } from "../machine/machine.js";
import type { MachineSpec } from "../machine/types.js";
import type { WorkflowLifecycleEvent } from "../core/events.js";
import { messageTypeOf, runtimeNoteKind } from "../core/messages.js";
import { WORKFLOW_STATUSES } from "./state.js";
import { childRunConfig, parentSessionIdOf, SEED_VARIABLES_KEY } from "../sessions/scope.js";
import {
  closingMessage,
  createSubWorkflowDispatcher,
  isSubWorkflowRefusal,
  NO_RESULT_MESSAGE,
  resolveParams,
  SUB_RUN_OPENING,
  SubWorkflowError,
  type SubWorkflowRegistry,
} from "./sub-workflow.js";

/** One recorded child-graph invocation: what it was called with. */
interface Invocation {
  input: unknown;
  /** Narrowed at the recording site: the dispatcher always supplies one. */
  config: { configurable: Record<string, unknown> };
}

/** The parent machine. Dispatch bounds are the dispatcher's, not the spec's. */
function parentMachine(): WorkflowMachine {
  return WorkflowMachine.fromSpec({
    states: { start: { triggers: { manual: null } } },
  } as unknown as MachineSpec);
}

/** The variable store shape the dispatcher reads from the parent. */
const vars = (values: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v, locked: true }]));

/**
 * A registry whose child graph is a stub: it records the state it was invoked
 * with and answers with whatever `respond` returns.
 */
function stubRegistry(
  respond: (input: unknown, config: Record<string, unknown>) => unknown = () => ({
    messages: [new AIMessage("Enriched 3 accounts.")],
    workflowState: "finish",
    status: WORKFLOW_STATUSES.completed,
  }),
): { registry: SubWorkflowRegistry; invocations: Invocation[] } {
  const invocations: Invocation[] = [];
  const registry: SubWorkflowRegistry = {
    // The fixture child declares its `manual` entry and no signature, so its
    // contract is empty — the signed cases below build their own registries.
    signature: async () => ({}),
    resolve: async (workflow) => ({
      machine: WorkflowMachine.fromSpec({
        states: { plan: { triggers: { manual: null } } },
      } as unknown as MachineSpec),
      graph: {
        invoke: async (input: unknown, config: RunnableConfig) => {
          const configurable = (config.configurable ?? {}) as Record<string, unknown>;
          invocations.push({ input, config: { configurable } });
          return respond(input, configurable);
        },
      } as never,
      // `workflow` is unused by the stub but kept so the closure is honest.
      ...(workflow ? {} : {}),
    }),
  };
  return { registry, invocations };
}

const PARENT_CONFIG = { configurable: { thread_id: "session-7" } };

/** The variable seeds a recorded invocation carried down to its child. */
const seedsOf = (invocation: Invocation | undefined): Record<string, unknown> =>
  (invocation?.config.configurable[SEED_VARIABLES_KEY] ?? {}) as Record<string, unknown>;

function dispatcherFor(
  registry: SubWorkflowRegistry,
  opts: { settings?: Record<string, number>; onEvent?: (e: WorkflowLifecycleEvent) => void } = {},
) {
  return createSubWorkflowDispatcher({
    registry,
    machine: parentMachine(),
    ...(opts.settings ? { bounds: opts.settings } : {}),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
  });
}

const dispatch = (
  d: ReturnType<typeof dispatcherFor>,
  over: Partial<Parameters<ReturnType<typeof dispatcherFor>["dispatch"]>[0]> = {},
) =>
  d.dispatch({
    workflow: "enrich-account",
    variables: {},
    config: PARENT_CONFIG,
    state: "enrich",
    ...over,
  });

describe("a completed sub-run", () => {
  it("returns the child's closing message, slug, and finishing state", async () => {
    const { registry } = stubRegistry();
    await expect(dispatch(dispatcherFor(registry))).resolves.toEqual({
      result: "Enriched 3 accounts.",
      workflow: "enrich-account",
      state: "finish",
    });
  });

  it("opens with the harness's own line, so the request carries a message", async () => {
    const { registry, invocations } = stubRegistry();
    await dispatch(dispatcherFor(registry));
    const messages = (invocations[0]?.input as { messages: { content: string }[] }).messages;
    // Not a prompt: nothing is authored, nothing is substituted. It exists
    // because some providers reject a call whose `messages` array is empty.
    expect(messages).toHaveLength(1);
    expect(String(messages[0]?.content)).toBe(SUB_RUN_OPENING);
    // Human-role, because it is the child's whole transcript at this moment and
    // a request whose only message is a system message is not portable — marked
    // instead, so a host can still tell it from a request a person made.
    expect(messageTypeOf(messages[0])).toBe("human");
    expect(runtimeNoteKind(messages[0])).toBe("opening");
  });

  // A child is an ordinary session, not storage of its caller: its own id, its
  // own checkpoints, artifacts and run zone. The caller's id is not recorded
  // beside it — the child's id *is* the record, so there is one source for it.
  it("runs on its own session id, which carries the caller's", async () => {
    const { registry, invocations } = stubRegistry();
    await dispatch(dispatcherFor(registry));
    const configurable = invocations[0]?.config.configurable ?? {};
    expect(configurable.thread_id).toBe("session-7~enrich:enrich-account:0");
    expect(parentSessionIdOf(configurable.thread_id as string)).toBe("session-7");
  });

  it("reports a child that said nothing rather than an empty message", async () => {
    const { registry } = stubRegistry(() => ({
      messages: [],
      workflowState: "finish",
      status: WORKFLOW_STATUSES.completed,
    }));
    await expect(dispatch(dispatcherFor(registry))).resolves.toMatchObject({
      result: NO_RESULT_MESSAGE,
    });
  });
});

describe("only what the caller declared is seeded", () => {
  it("seeds this dispatch's params and nothing else", async () => {
    const { registry, invocations } = stubRegistry();
    await dispatch(dispatcherFor(registry), {
      params: { account_id: "acct-42" },
      // The dispatching run's own variables are NOT copied down: a sub-run sees
      // only what its caller declared.
      variables: vars({ stage: "b", secret: "nope" }),
    });
    expect(seedsOf(invocations[0])).toEqual({ account_id: "acct-42" });
  });

  it("seeds nothing when the dispatch declares no params", async () => {
    const { registry, invocations } = stubRegistry();
    await dispatch(dispatcherFor(registry), { variables: vars({ stage: "b" }) });
    expect(seedsOf(invocations[0])).toEqual({});
  });

  it("resolves ${{…}} in string params against the caller's variables", async () => {
    const { registry, invocations } = stubRegistry();
    await dispatch(dispatcherFor(registry), {
      params: { account_id: "${{account_id}}", limit: 5 },
      variables: vars({ account_id: "acct-42" }),
    });
    expect(seedsOf(invocations[0])).toMatchObject({ account_id: "acct-42", limit: 5 });
  });
});

describe("refusals happen before anything is composed", () => {
  it("refuses a chain deeper than max_depth, naming the chain", async () => {
    const { registry, invocations } = stubRegistry();
    const d = dispatcherFor(registry, { settings: { maxDepth: 1 } });
    const nested = childRunConfig(PARENT_CONFIG, {
      identity: "n:a:0",
      workflow: "a",
      dispatchId: "d1",
    });
    await expect(dispatch(d, { config: nested })).rejects.toThrow(/past the dispatcher's limit of 1/);
    expect(invocations).toHaveLength(0);
  });

  it("refuses a workflow already running in the chain", async () => {
    const { registry, invocations } = stubRegistry();
    const nested = childRunConfig(PARENT_CONFIG, {
      identity: "n:enrich-account:0",
      workflow: "enrich-account",
      dispatchId: "d1",
    });
    await expect(dispatch(dispatcherFor(registry), { config: nested })).rejects.toThrow(
      /already running in this chain/,
    );
    expect(invocations).toHaveLength(0);
  });

  it("refuses an unresolvable param, naming it", async () => {
    const { registry } = stubRegistry();
    await expect(
      dispatch(dispatcherFor(registry), { params: { id: "${{missing}}" } }),
    ).rejects.toThrow(/param 'id'/);
  });

  it("surfaces a registry failure as the sub-run failure it is", async () => {
    const registry: SubWorkflowRegistry = {
      signature: async (workflow) => {
        throw new SubWorkflowError("unknown-workflow", workflow, `Cannot run '${workflow}'.`);
      },
      resolve: async (workflow) => {
        throw new SubWorkflowError("unknown-workflow", workflow, `Cannot run '${workflow}'.`);
      },
    };
    await expect(dispatch(dispatcherFor(registry))).rejects.toThrow(SubWorkflowError);
  });
});

describe("a sub-run that suspends suspends the run with it", () => {
  /** What LangGraph throws out of a nested invoke when the child interrupts. */
  const graphInterrupt = () =>
    Object.assign(new Error("interrupt"), {
      name: "GraphInterrupt",
      interrupts: [{ id: "i1", value: { state: "review", transitions: [{ to: "done", description: "Test edge to done." }] } }],
    });

  it("rethrows the suspension untouched rather than reporting a failure", async () => {
    const { registry } = stubRegistry(() => {
      throw graphInterrupt();
    });
    // Not a SubWorkflowError: the parent's own graph must see the interrupt so
    // it parks, which is what makes a delegated decision resumable at all.
    await expect(dispatch(dispatcherFor(registry))).rejects.toMatchObject({
      name: "GraphInterrupt",
    });
  });

  it("reports the dispatch as parked, not as an error", async () => {
    const events: WorkflowLifecycleEvent[] = [];
    const { registry } = stubRegistry(() => {
      throw graphInterrupt();
    });
    await dispatch(dispatcherFor(registry, { onEvent: (e) => events.push(e) })).catch(() => {});

    expect(events.find((e) => e.type === "sub-workflow-result")).toMatchObject({
      status: "parked",
    });
  });

  it("fails a child that settles in an awaiting status with nothing to resume it", async () => {
    const { registry } = stubRegistry(() => ({
      messages: [],
      workflowState: "clarify",
      status: WORKFLOW_STATUSES.awaitingInput,
    }));
    await expect(dispatch(dispatcherFor(registry))).rejects.toThrow(
      /no pending suspension, so nothing could resume it/,
    );
  });

  it("fails when the child is rejected, carrying the reason", async () => {
    const { registry } = stubRegistry(() => ({
      messages: [],
      workflowState: "write",
      rejected: "judge veto: incomplete",
      status: WORKFLOW_STATUSES.rejected,
    }));
    await expect(dispatch(dispatcherFor(registry))).rejects.toThrow(/judge veto: incomplete/);
  });
});

describe("concurrency is bounded and queued", () => {
  it("runs at most max_concurrent sub-runs at once, and still completes them all", async () => {
    let active = 0;
    let peak = 0;
    const { registry } = stubRegistry(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return {
        messages: [new AIMessage("ok")],
        workflowState: "finish",
        status: WORKFLOW_STATUSES.completed,
      };
    });
    const d = dispatcherFor(registry, { settings: { maxConcurrent: 2 } });

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => dispatch(d, { params: { n: i } })),
    );

    expect(results).toHaveLength(6);
    expect(peak).toBeLessThanOrEqual(2);
  });

  // Distinct sessions is the whole of it: the scope a per-run resource is filed
  // under is the session id, so distinct sessions are distinct scopes by
  // construction rather than by a second key kept in step with them.
  it("gives concurrent dispatches distinct sessions", async () => {
    const { registry, invocations } = stubRegistry();
    const d = dispatcherFor(registry);
    await Promise.all([dispatch(d), dispatch(d)]);
    const sessions = invocations.map((i) => i.config.configurable.thread_id);
    expect(new Set(sessions).size).toBe(2);
  });
});

describe("dispatch events", () => {
  it("brackets a successful dispatch", async () => {
    const events: WorkflowLifecycleEvent[] = [];
    const { registry } = stubRegistry();
    await dispatch(dispatcherFor(registry, { onEvent: (e) => events.push(e) }));

    const start = events.find((e) => e.type === "sub-workflow-start");
    const result = events.find((e) => e.type === "sub-workflow-result");
    expect(start).toMatchObject({ workflow: "enrich-account", state: "enrich", depth: 1 });
    expect(result).toMatchObject({
      status: "ok",
      dispatchId: (start as { dispatchId: string }).dispatchId,
    });
  });

  it("reports a refused dispatch too, so nothing attempted is invisible", async () => {
    const events: WorkflowLifecycleEvent[] = [];
    const { registry } = stubRegistry();
    const d = dispatcherFor(registry, {
      settings: { maxDepth: 1 },
      onEvent: (e) => events.push(e),
    });
    const nested = childRunConfig(PARENT_CONFIG, {
      identity: "n:a:0",
      workflow: "a",
      dispatchId: "d1",
    });

    await expect(dispatch(d, { config: nested })).rejects.toThrow();

    expect(events.some((e) => e.type === "sub-workflow-start")).toBe(true);
    expect(events.find((e) => e.type === "sub-workflow-result")).toMatchObject({
      status: "error",
    });
  });
});

describe("helpers", () => {
  it("reads the last assistant text as the closing message", () => {
    const state = {
      messages: [new AIMessage("first"), new AIMessage("last")],
    };
    expect(closingMessage(state)).toBe("last");
  });

  it("passes non-string params through untouched", () => {
    expect(resolveParams({ n: 3, flag: true, obj: { a: 1 } }, {}, "w")).toEqual({
      n: 3,
      flag: true,
      obj: { a: 1 },
    });
  });
});

describe("the target's declared signature", () => {
  /** A stub registry whose child declares `requires`/`returns` and answers with `state`. */
  function signedRegistry(
    signature: { requires?: string[]; returns?: string[] },
    childState: Record<string, unknown> = {
      messages: [new AIMessage("Done.")],
      workflowState: "finish",
      status: WORKFLOW_STATUSES.completed,
    },
  ): SubWorkflowRegistry {
    let composed = 0;
    const registry: SubWorkflowRegistry & { composed: () => number } = {
      signature: async () => signature,
      resolve: async () => {
        composed += 1;
        return {
          machine: WorkflowMachine.fromSpec({
            states: { plan: { triggers: { manual: null } } },
          } as unknown as MachineSpec),
          graph: { invoke: async () => childState } as never,
        };
      },
      composed: () => composed,
    };
    return registry;
  }

  it("refuses a dispatch that does not supply a required input", async () => {
    const registry = signedRegistry({ requires: ["order_id"] });
    await expect(dispatch(dispatcherFor(registry), { params: { customer: "acme" } })).rejects.toThrow(
      /requires 'order_id', which this call does not supply/,
    );
  });

  // The refusal is the point of checking before composition: a dispatch that
  // cannot legally succeed must not cost a Deep Agent.
  it("composes no child when the input contract is unmet", async () => {
    const registry = signedRegistry({ requires: ["order_id"] }) as SubWorkflowRegistry & {
      composed: () => number;
    };
    await expect(dispatch(dispatcherFor(registry), { params: {} })).rejects.toThrow(
      SubWorkflowError,
    );
    expect(registry.composed()).toBe(0);
  });

  it("carries the missing-param kind so a caller can tell a refusal from a rejection", async () => {
    const registry = signedRegistry({ requires: ["order_id"] });
    await dispatch(dispatcherFor(registry), { params: {} }).catch((err: SubWorkflowError) => {
      expect(err.kind).toBe("missing-param");
      expect(err.workflow).toBe("enrich-account");
    });
  });

  it("accepts a supplied param, including an empty or null value", async () => {
    const registry = signedRegistry({ requires: ["order_id", "note"] });
    await expect(
      dispatch(dispatcherFor(registry), { params: { order_id: "", note: null } }),
    ).resolves.toMatchObject({ workflow: "enrich-account" });
  });

  it("reads exactly the declared returns out of the settled store", async () => {
    const registry = signedRegistry(
      { returns: ["enrichment_file", "delayed"] },
      {
        messages: [new AIMessage("Enriched ORD-1.")],
        workflowState: "finish",
        status: WORKFLOW_STATUSES.completed,
        variables: {
          enrichment_file: { value: "output/e/ORD-1.json", locked: false },
          delayed: { value: true, locked: false },
          scratch_note: { value: "ignore me", locked: false },
        },
      },
    );
    await expect(dispatch(dispatcherFor(registry))).resolves.toEqual({
      result: "Enriched ORD-1.",
      workflow: "enrich-account",
      state: "finish",
      returns: { enrichment_file: "output/e/ORD-1.json", delayed: true },
    });
  });

  it("returns nothing structured when the target declares no returns", async () => {
    const registry = signedRegistry({});
    const result = await dispatch(dispatcherFor(registry));
    expect(result.returns).toBeUndefined();
    expect(result.result).toBe("Done.");
  });

  it("reports the returned names on the settle event, never their values", async () => {
    const events: WorkflowLifecycleEvent[] = [];
    const registry = signedRegistry(
      { returns: ["enrichment_file"] },
      {
        messages: [new AIMessage("Done.")],
        workflowState: "finish",
        status: WORKFLOW_STATUSES.completed,
        variables: { enrichment_file: { value: "output/e/ORD-1.json", locked: false } },
      },
    );
    await dispatch(dispatcherFor(registry, { onEvent: (e) => events.push(e) }));
    const settled = events.find((e) => e.type === "sub-workflow-result");
    expect(settled).toMatchObject({ status: "ok", returns: ["enrichment_file"] });
    expect(JSON.stringify(settled)).not.toContain("output/e/ORD-1.json");
  });
});

describe("a refusal is separable from a failure", () => {
  const signed = (signature: { requires?: string[] }): SubWorkflowRegistry => ({
    signature: async () => signature,
    resolve: async () => {
      throw new Error("must not compose");
    },
  });

  it("reports a refusal without raising it", async () => {
    const d = dispatcherFor(signed({ requires: ["order_id"] }));
    const refusal = await d.refusal({
      workflow: "enrich-account",
      params: { customer: "acme" },
      variables: {},
      config: PARENT_CONFIG,
      state: "enrich",
    });
    expect(refusal?.kind).toBe("missing-param");
    expect(refusal?.message).toMatch(/requires 'order_id'/);
  });

  it("brackets a refusal as the attempt it was, naming the call", async () => {
    // The tool seam refuses agent-initiated calls here rather than letting the
    // dispatch raise, so without this a refused delegation would be invisible in
    // the dispatch stream while a script's — refused inside `dispatch` — was not.
    const events: WorkflowLifecycleEvent[] = [];
    const d = dispatcherFor(signed({ requires: ["order_id"] }), {
      onEvent: (e) => events.push(e),
    });

    const refusal = await d.refusal({
      workflow: "enrich-account",
      params: { customer: "acme" },
      variables: {},
      config: PARENT_CONFIG,
      state: "enrich",
      toolCallId: "call-7",
    });

    const start = events.find((e) => e.type === "sub-workflow-start");
    const result = events.find((e) => e.type === "sub-workflow-result");
    expect(start).toMatchObject({
      workflow: "enrich-account",
      state: "enrich",
      depth: 1,
      toolCallId: "call-7",
    });
    expect(result).toMatchObject({
      status: "error",
      toolCallId: "call-7",
      dispatchId: (start as { dispatchId: string }).dispatchId,
      reason: refusal?.message,
    });
    // One pair, not two: a refusal reports once.
    expect(events.filter((e) => e.type === "sub-workflow-start")).toHaveLength(1);
  });

  it("reports nothing for a call that would proceed", async () => {
    const d = dispatcherFor(signed({ requires: ["order_id"] }));
    const refusal = await d.refusal({
      workflow: "enrich-account",
      params: { order_id: "ORD-1" },
      variables: {},
      config: PARENT_CONFIG,
      state: "enrich",
    });
    expect(refusal).toBeUndefined();
  });

  it("emits nothing for a call it clears, leaving the pair to the dispatch", async () => {
    const events: WorkflowLifecycleEvent[] = [];
    const d = dispatcherFor(signed({ requires: ["order_id"] }), {
      onEvent: (e) => events.push(e),
    });

    await d.refusal({
      workflow: "enrich-account",
      params: { order_id: "ORD-1" },
      variables: {},
      config: PARENT_CONFIG,
      state: "enrich",
      toolCallId: "call-7",
    });

    expect(events.filter((e) => e.type.startsWith("sub-workflow-"))).toEqual([]);
  });

  it("classifies every kind where nothing ran as a refusal", () => {
    for (const kind of [
      "depth-exceeded",
      "cycle",
      "missing-param",
      "unknown-workflow",
      "not-delegatable",
      "disabled",
    ] as const) {
      expect(isSubWorkflowRefusal(new SubWorkflowError(kind, "w", "…"))).toBe(true);
    }
    // A child ran and did not finish: the caller has a failure to reckon with,
    // not a call to correct.
    for (const kind of ["rejected", "budget", "parked", "error"] as const) {
      expect(isSubWorkflowRefusal(new SubWorkflowError(kind, "w", "…"))).toBe(false);
    }
  });

  it("refuses on the same terms the dispatch would", async () => {
    // One source of refusal logic: a caller that skips the check is refused
    // anyway, just later and as a thrown error rather than a reported one.
    const d = dispatcherFor(signed({ requires: ["order_id"] }));
    const input = {
      workflow: "enrich-account",
      params: { customer: "acme" },
      variables: {},
      config: PARENT_CONFIG,
      state: "enrich",
    };
    const reported = await d.refusal(input);
    await expect(d.dispatch(input)).rejects.toThrow(reported!.message);
  });
});

describe("concurrent calls", () => {
  /** A registry whose children settle only when released, so overlap is observable. */
  function gatedRegistry() {
    let inFlight = 0;
    let peak = 0;
    const gates: (() => void)[] = [];
    const registry: SubWorkflowRegistry = {
      signature: async () => ({}),
      resolve: async () => ({
        machine: WorkflowMachine.fromSpec({
          states: { plan: { triggers: { manual: null } } },
        } as unknown as MachineSpec),
        graph: {
          invoke: async () => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise<void>((resolve) => gates.push(resolve));
            inFlight -= 1;
            return {
              messages: [new AIMessage("Done.")],
              workflowState: "finish",
              status: WORKFLOW_STATUSES.completed,
            };
          },
        } as never,
      }),
    };
    return { registry, peak: () => peak, releaseAll: () => gates.splice(0).forEach((g) => g()) };
  }

  it("runs calls concurrently up to the bound, queueing the rest", async () => {
    const gated = gatedRegistry();
    const d = dispatcherFor(gated.registry, { settings: { maxConcurrent: 2 } });

    const all = Promise.all([1, 2, 3, 4].map(() => dispatch(d)));
    // Let the first batch reach the gate, then release everything.
    await new Promise((r) => setTimeout(r, 0));
    expect(gated.peak()).toBe(2);
    gated.releaseAll();
    await new Promise((r) => setTimeout(r, 0));
    gated.releaseAll();

    const results = await all;
    expect(results).toHaveLength(4);
    expect(gated.peak()).toBeLessThanOrEqual(2);
  });

  it("lets one call fail without taking the others with it", async () => {
    const registry: SubWorkflowRegistry = {
      signature: async () => ({}),
      resolve: async () => ({
        machine: WorkflowMachine.fromSpec({
          states: { plan: { triggers: { manual: null } } },
        } as unknown as MachineSpec),
        graph: {
          invoke: async (input: unknown) => {
            const seeds = seedsOf({ input, config: { configurable: {} } } as never);
            void seeds;
            return {
              messages: [new AIMessage("Done.")],
              workflowState: "finish",
              status: WORKFLOW_STATUSES.completed,
            };
          },
        } as never,
      }),
    };
    const d = dispatcherFor(registry);

    const settled = await Promise.allSettled([
      dispatch(d, { params: { order_id: "A" } }),
      // Refused: unresolvable reference, so nothing is composed for this one.
      dispatch(d, { params: { order_id: "${{nope}}" } }),
      dispatch(d, { params: { order_id: "C" } }),
    ]);

    expect(settled.map((s) => s.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });
});

describe("a mock stands in for the sub-run, not for its contract", () => {
  const mocked = (result: unknown, signature: { returns?: string[] } = {}) => {
    const registry: SubWorkflowRegistry = {
      signature: async () => signature,
      resolve: async () => {
        throw new Error("a mocked dispatch must not compose the child");
      },
    };
    return dispatch(dispatcherFor(registry), {
      params: { order_id: "ORD-1" },
      config: {
        configurable: {
          ...PARENT_CONFIG.configurable,
          __toolMocks: [
            { name: "archmax_workflow_enrich-account", whenInput: { order_id: "ORD-1" }, result },
          ],
        },
      },
    });
  };

  it("answers the dispatch without composing the child", async () => {
    // Served by the dispatcher rather than short-circuited at the tool seam, so
    // a mocked delegation still emits its events and records its trail step.
    const result = await mocked({ message: "Enriched.", returns: { enrichment_file: "e.json" } }, {
      returns: ["enrichment_file"],
    });
    expect(result.result).toBe("Enriched.");
    expect(result.returns).toEqual({ enrichment_file: "e.json" });
  });

  it("fails a mock that omits a declared return", async () => {
    await expect(mocked({ message: "Enriched." }, { returns: ["enrichment_file"] })).rejects.toThrow(
      /supplies no 'enrichment_file'/,
    );
  });

  it("fails a bare-string mock for a signed target", async () => {
    await expect(mocked("Enriched.", { returns: ["enrichment_file"] })).rejects.toThrow(
      /stands in for the sub-run, not for its contract/,
    );
  });

  it("accepts any shape for a target that declares no returns", async () => {
    expect((await mocked("Audited.")).result).toBe("Audited.");
  });

  it("fails the dispatch when the mock declares an error", async () => {
    await expect(mocked({ error: "vetoed" })).rejects.toThrow(/failed \(mocked\): vetoed/);
  });

  it("records a mocked dispatch in the trail ledger like a real one", async () => {
    const d = dispatcherFor({
      signature: async () => ({}),
      resolve: async () => {
        throw new Error("must not compose");
      },
    });
    await d.dispatch({
      workflow: "enrich-account",
      params: { order_id: "ORD-1" },
      variables: {},
      config: {
        configurable: {
          ...PARENT_CONFIG.configurable,
          __toolMocks: [{ name: "archmax_workflow_enrich-account", result: "done" }],
        },
      },
      state: "enrich",
    });
    expect(d.drainDispatches("session-7")).toEqual([
      { workflow: "enrich-account", status: "ok" },
    ]);
  });
});

describe("a disabled target", () => {
  /** A registry whose target reports itself out of service. */
  function disabledRegistry() {
    const { registry, invocations } = stubRegistry();
    return {
      invocations,
      registry: { ...registry, signature: async () => ({ disabled: true }) },
    };
  }

  it("refuses the dispatch before composing a child", async () => {
    const { registry, invocations } = disabledRegistry();
    await expect(dispatch(dispatcherFor(registry))).rejects.toMatchObject({
      name: "SubWorkflowError",
      kind: "disabled",
      workflow: "enrich-account",
    });
    // Nothing ran: the child graph was never invoked.
    expect(invocations).toEqual([]);
  });

  it("names the flag and how to undo it", async () => {
    const { registry } = disabledRegistry();
    await expect(dispatch(dispatcherFor(registry))).rejects.toThrow(
      /is disabled \('disabled: true' in its workflow\.yaml\)/,
    );
  });

  it("is a refusal, so the caller may report or route it", async () => {
    const { registry } = disabledRegistry();
    const refusal = await dispatcherFor(registry).refusal({
      workflow: "enrich-account",
      variables: {},
      config: PARENT_CONFIG,
      state: "enrich",
    });
    expect(refusal?.kind).toBe("disabled");
    expect(isSubWorkflowRefusal(refusal)).toBe(true);
  });

  // A mock says "pretend this child ran"; a disabled target says it cannot. The
  // refusal wins, so a case can never assert a delegation production refuses.
  it("refuses even when the call is mocked", async () => {
    const { registry } = disabledRegistry();
    await expect(
      dispatch(dispatcherFor(registry), {
        config: {
          configurable: {
            ...PARENT_CONFIG.configurable,
            __toolMocks: [{ tool: "archmax_workflow_enrich-account", result: "pretend" }],
          },
        },
      }),
    ).rejects.toMatchObject({ kind: "disabled" });
  });

  it("does not refuse a target that reports itself enabled", async () => {
    const { registry } = stubRegistry();
    await expect(
      dispatch(dispatcherFor({ ...registry, signature: async () => ({ disabled: false }) })),
    ).resolves.toMatchObject({ workflow: "enrich-account" });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, WorkflowSurface } from "../agent.js";
import { outcomeOf, settle, type Outcome, type SendDisposition } from "../sessions/resume.js";
import {
  assertWorkflowGovernedTarget,
  exitCodeForVerdict,
  reduceVerdict,
  runTests,
  type AssertionRecord,
  type CaseResult,
} from "./runner.js";

describe("reduceVerdict", () => {
  it("passes when all gates pass", () => {
    const records: AssertionRecord[] = [
      {
        kind: "succeeded",
        threshold: null,
        status: "passed",
        step: 1,
      },
    ];
    expect(reduceVerdict(records).status).toBe("passed");
  });

  it("fails on gate miss", () => {
    const records: AssertionRecord[] = [
      {
        kind: "includes",
        threshold: null,
        status: "failed",
        detail: "missing",
        step: 1,
      },
    ];
    expect(reduceVerdict(records).status).toBe("failed");
  });

  // The bar the case author declared is the bar: a score under it fails the
  // case with no flag involved, and renders the score beside the threshold.
  it("fails a threshold miss and names the score against the bar", () => {
    const records: AssertionRecord[] = [
      {
        kind: "grade.closedQA",
        threshold: 0.8,
        status: "failed",
        score: 0.2,
        detail: "confirms the refund",
        step: 1,
      },
    ];
    const verdict = reduceVerdict(records);
    expect(verdict.status).toBe("failed");
    expect(verdict.failures).toEqual(["grade.closedQA: confirms the refund (score 0.2 < 0.8)"]);
    expect(exitCodeForVerdict(verdict)).toBe(1);
  });

  // An un-run gate assertion must not read as a gate failure: "did not run"
  // and "failed" are different, and `status` separates them.
  it("treats not-executed records as neither passed nor failed", () => {
    const notExecuted: AssertionRecord = {
      kind: "reachedState",
      threshold: null,
      status: "not-executed",
      step: 3,
    };
    expect(reduceVerdict([notExecuted]).status).toBe("passed");
    expect(reduceVerdict([notExecuted]).failures).toEqual([]);
  });

  it("reports only the real failure when a halt left later steps un-run", () => {
    const records: AssertionRecord[] = [
      {
        kind: "reachedState",
        threshold: null,
        status: "failed",
        detail: "refund-review",
        step: 1,
      },
      {
        kind: "reply",
        threshold: null,
        status: "not-executed",
        step: 3,
      },
      {
        kind: "judge",
        threshold: 0.7,
        status: "not-executed",
        step: 4,
      },
    ];
    const verdict = reduceVerdict(records);
    expect(verdict.status).toBe("failed");
    expect(verdict.failures).toEqual(["reachedState: refund-review"]);
  });
});

function agent(kind: "workflow" | "plain"): Agent {
  return { workflow: kind === "workflow" ? {} : undefined } as unknown as Agent;
}

describe("assertWorkflowGovernedTarget", () => {
  it("accepts a workflow-governed target", () => {
    expect(() => assertWorkflowGovernedTarget(agent("workflow"), "order-lookup")).not.toThrow();
  });

  // Pins the wording, because both the default target builder and `runTests`
  // report it — a caller-supplied target must be refused on identical terms.
  it("refuses a target with no workflow machine, naming the workflow", () => {
    expect(() => assertWorkflowGovernedTarget(agent("plain"), "order-lookup")).toThrow(
      "Case target 'order-lookup' has no workflow machine; " +
        "cases require a workflow-governed agent.",
    );
  });
});

const TESTS_DIR = "workflows/order-lookup/tests";
const FILE_A = `${TESTS_DIR}/alpha.test.yaml`;
const FILE_B = `${TESTS_DIR}/beta.test.yaml`;

const ALPHA = `
title: alpha
description: alpha case
steps:
  - send: "hi"
  - succeeded: true
`;

/** beta fails a gate: the fake target's reply never contains the token. */
const BETA = `
title: beta
description: beta case
steps:
  - send: "hi"
  - reply:
      includes: "boom-token"
`;

/** The workspace file tree each test serves; reset per test. */
let tree: Record<string, string>;

function resetTree() {
  tree = { [FILE_A]: ALPHA, [FILE_B]: BETA };
}
resetTree();

/**
 * The fake serves the authoring plane, which is where every file `runTests`
 * reads lives: the spec, the suite config, the case documents and their
 * fixtures. It is exposed under both keys because the context returns both, and
 * a case's *agent* never reads through either — its seeds are written into the
 * run's own zone by the driver.
 */
vi.mock("../core/workspace-context.js", () => {
  const plane = {
    async listDir(dir: string) {
      const seen = new Map<string, boolean>();
      for (const p of Object.keys(tree)) {
        if (!p.startsWith(`${dir}/`)) continue;
        const rest = p.slice(dir.length + 1);
        const head = rest.split("/")[0] as string;
        seen.set(`${dir}/${head}`, rest.includes("/") || seen.get(`${dir}/${head}`) === true);
      }
      return [...seen.entries()].map(([path, is_dir]) => ({ path, is_dir }));
    },
    async readText(rel: string) {
      return tree[rel] ?? null;
    },
    async exists(rel: string) {
      return rel in tree;
    },
  };
  return { createWorkspaceContext: () => ({ rootDir: "/ws", workspace: plane, authoring: plane }) };
});

/** The `tests:` block the mocked spec loader serves; null = no spec. */
let specTests: Record<string, unknown> | null = null;
/** Extra spec-root keys the mocked loader serves alongside `tests:`. */
let specRoot: Record<string, unknown> | null = null;

vi.mock("../machine/load-spec.js", () => ({
  loadMachineSpec: async () => ({
    spec:
      specTests || specRoot
        ? { ...(specRoot ?? {}), ...(specTests ? { tests: specTests } : {}) }
        : null,
  }),
}));

const createCaseTarget = vi.fn(async (_opts: unknown) => fakeTarget().target);
vi.mock("./target.js", () => ({
  createCaseTarget: (opts: unknown) => createCaseTarget(opts),
}));

vi.mock("./grade.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./grade.js")>();
  return {
    ...original,
    createJudgeModel: () => ({}) as never,
    gradeClosedQA: async () => ({ score: 1, pass: true }),
  };
});

/**
 * Give a fake target the `send` the engine drives through, composed over the
 * fake's own `invoke` / `decide` / `reply` / `deliver`. Production decides
 * "turn or reply" from the checkpoint; the fake decides it from the outcome it
 * last produced, which is the same fact.
 */
function withSend(agent: Agent & { workflow: WorkflowSurface }): Agent & { workflow: WorkflowSurface } {
  if (!agent.workflow) return agent;
  const held = new Map<string, boolean>();
  const wf = agent.workflow as unknown as Record<string, (...args: never[]) => Promise<Record<string, unknown>>>;
  const lastText = (messages: unknown[]): string => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as { type?: string; content?: unknown };
      if (m?.type === "ai" && typeof m.content === "string" && m.content) return m.content;
    }
    return "";
  };
  const asOutcome = (o: Record<string, unknown>, disposition: SendDisposition): Outcome => {
    const parked = o.reparked === true;
    const state = (o.state ?? o.state) as string | undefined;
    const messages = (o.messages ?? []) as unknown[];
    return {
      kind: parked ? "parked" : "completed",
      disposition,
      ...(o.status ? { status: o.status as Outcome["status"] } : {}),
      ...(state ? { state } : {}),
      ...(o.parkedChannel ? { parkedChannel: o.parkedChannel as Outcome["parkedChannel"] } : {}),
      reply: typeof o.reply === "string" ? o.reply : lastText(messages),
      messages,
      auditTrail: (o.auditTrail ?? []) as Outcome["auditTrail"],
      variables: (o.variables ?? {}) as Outcome["variables"],
    };
  };
  const remember = (sessionId: string, o: Outcome): Outcome => {
    held.set(sessionId, o.kind === "parked" && o.parkedChannel === "decision");
    return o;
  };
  wf.send = (async (sessionId: string, input: Record<string, unknown>, config?: { configurable?: Record<string, unknown> }) => {
    if ("decision" in input) return remember(sessionId, asOutcome(await wf.decide(sessionId as never, input.decision as never), "decide"));
    if ("delivery" in input) return remember(sessionId, asOutcome(await wf.deliver(sessionId as never, input.delivery as never), "deliver"));
    if (held.get(sessionId)) {
      // A reply never routes: production reports it parked on the decision channel.
      const replied = asOutcome(await wf.reply(sessionId as never, input.message as never), "reply");
      return { ...replied, kind: "parked", parkedChannel: "decision" };
    }
    const result = (await (agent as unknown as { invoke: (i: unknown, c: unknown) => Promise<Record<string, unknown>> }).invoke(
      {
        messages: [{ role: "user", content: input.message }],
        ...(input.trigger ? { trigger: input.trigger } : {}),
        ...(input.variables
          ? {
              variables: Object.fromEntries(
                Object.entries(input.variables as Record<string, unknown>).map(([k, v]) => [k, { value: v, locked: true }]),
              ),
            }
          : {}),
      },
      { ...config, configurable: { thread_id: sessionId, ...(config?.configurable ?? {}) } },
    )) as Record<string, unknown>;
    return remember(sessionId, outcomeOf(settle(result), "turn"));
  }) as never;
  return agent;
}

/**
 * A minimal target: records the session and input of every graph invocation
 * and every workspace seed, resolves the triggers a governed runtime would
 * (declared: `manual`, `report_requested`), and replies with a fixed message.
 */
function fakeTarget(
  kind: "workflow" | "plain" = "workflow",
  capabilities: { toolMocks: boolean } = { toolMocks: true },
  opts: { seedable?: boolean; reply?: string } = {},
): {
  target: Agent & { workflow: WorkflowSurface };
  sessions: string[];
  invocations: Array<Record<string, unknown>>;
  seeds: Array<{ sessionId: string; files: Record<string, unknown> }>;
  decisions: Array<{ sessionId: string; target: string; comment?: string }>;
} {
  const sessions: string[] = [];
  const invocations: Array<Record<string, unknown>> = [];
  const seeds: Array<{ sessionId: string; files: Record<string, unknown> }> = [];
  const decisions: Array<{ sessionId: string; target: string; comment?: string }> = [];
  const target = withSend({
    async invoke(input: Record<string, unknown>, config: { configurable: { thread_id: string } }) {
      sessions.push(config.configurable.thread_id);
      invocations.push(input);
      return {
        messages: opts.reply ? [{ type: "ai", content: opts.reply }] : [],
      };
    },
    // Session-level members sit on the agent for governed and plain alike, so the
    // stub carries them regardless of `kind`.
    toolMocks: capabilities.toolMocks,
    sessions:
      opts.seedable === false
        ? {}
        : {
            async seed(sessionId: string, files: Record<string, unknown>) {
              seeds.push({ sessionId, files });
            },
          },
    dispose() {},
    // A plain assembly has no governance surface at all — that absence is what
    // the target contract refuses, so the stub models it as `undefined` rather
    // than as a `kind` discriminant.
    workflow:
      kind === "plain"
        ? undefined
        : {
            resolveTrigger(trigger?: { id: string; args?: Record<string, unknown> }) {
              const id = trigger?.id ?? "manual";
              if (id !== "manual" && id !== "report_requested") {
                throw new Error(
                  `Unknown trigger '${id}'. Declared triggers: manual, report_requested.`,
                );
              }
              return { ...(trigger ?? { id }), startState: "start" };
            },
            async decide(sessionId: string, resolution: { target: string; comment?: string }) {
              decisions.push({ sessionId, ...resolution });
              return { messages: [], auditTrail: [], reparked: false };
            },
          },
  } as unknown as Agent & { workflow: WorkflowSurface });
  return { target, sessions, invocations, seeds, decisions };
}

afterEach(() => {
  resetTree();
  specTests = null;
  specRoot = null;
  createCaseTarget.mockClear();
  vi.restoreAllMocks();
});

describe("runTests discovery and verdicts", () => {
  it("runs YAML cases sorted by path and reduces verdicts", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { results, exitCode } = await runTests({ workflow: "order-lookup" });
    expect(results.map((r) => r.id)).toEqual(["alpha", "beta"]);
    expect(results.map((r) => r.verdict.status)).toEqual(["passed", "failed"]);
    expect(exitCode).toBe(1);
  });

  it("applies the path-substring filter", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { results } = await runTests({ workflow: "order-lookup", filter: "alpha" });
    expect(results.map((r) => r.id)).toEqual(["alpha"]);
  });

  // The per-file version axis is gone. A case carrying it fails at parse like any
  // other schema violation — the old whole-run throw was this key's own special
  // case, and removing the axis removes the special case with it.
  it("fails a case carrying a 'version' key as an unknown key", async () => {
    tree[FILE_B] = `version: "1"\ntitle: beta\ndescription: beta case\n`;
    const { results, exitCode } = await runTests({ workflow: "order-lookup", filter: "beta" });
    expect(exitCode).toBe(1);
    expect(results[0]?.verdict.status).toBe("failed");
    expect(results[0]?.error).toMatch(/unknown key 'version'/);
    // Nothing ran, so there is no session to attribute anything to.
    expect(results[0]?.sessionId).toBeUndefined();
  });

  it("reports how many cases the suite holds even when the filter matches none", async () => {
    const outcome = await runTests({ workflow: "order-lookup", filter: "zzz" });
    expect(outcome.results).toEqual([]);
    expect(outcome.discovered).toBe(2);
    expect(outcome.exitCode).toBe(0);
  });

  it("fails a case (never passes it) on an unknown step key", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    tree[FILE_A] = `
title: alpha
description: alpha case
steps:
  - send: hi
  - reachedstate: foo
`;
    const { results, exitCode } = await runTests({ workflow: "order-lookup", filter: "alpha" });
    expect(exitCode).toBe(1);
    expect(results[0]?.verdict.status).toBe("failed");
    expect(results[0]?.verdict.failures.join("\n")).toContain("unknown step 'reachedstate'");
  });

  it("fails a case whose assertion precedes any action", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { target, sessions } = fakeTarget();
    tree[FILE_A] = `
title: alpha
description: alpha case
steps:
  - succeeded: true
  - send: hi
`;
    const { results } = await runTests({
      workflow: "order-lookup",
      filter: "alpha",
      createTarget: async () => target,
    });
    expect(results[0]?.verdict.failures.join("\n")).toContain("no preceding action");
    expect(sessions).toHaveLength(0);
  });

  it("reports a skipped verdict without driving anything", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { target, sessions } = fakeTarget();
    tree[FILE_A] = `title: alpha\ndescription: alpha case\nskip: "pending fixture"\n`;
    const { results, exitCode } = await runTests({
      workflow: "order-lookup",
      filter: "alpha",
      createTarget: target,
    });
    expect(results[0]).toMatchObject({ skipReason: "pending fixture" });
    expect(results[0]?.verdict.status).toBe("skipped");
    expect(results[0]?.sessionId).toBeUndefined();
    expect(sessions).toHaveLength(0);
    expect(exitCode).toBe(0);
  });

  // Fixture directories are reached only through `from:`; a stray directory
  // beside the cases is not a case and not an error.
  it("ignores directories beside case files that no case references", async () => {
    tree[`${TESTS_DIR}/notes/trigger.json`] = "{}";
    const { results } = await runTests({ workflow: "order-lookup" });
    expect(results.map((r) => r.id)).toEqual(["alpha", "beta"]);
  });
});

describe("runTests reporter callbacks", () => {
  it("invokes onCaseStart before onCaseResult, per file, in discovery order", async () => {
    const events: string[] = [];
    await runTests({
      workflow: "order-lookup",
      onCaseStart: (file) => events.push(`start:${file}`),
      onCaseResult: (r) => events.push(`result:${r.id}:${r.verdict.status}`),
    });
    expect(events).toEqual([
      `start:${FILE_A}`,
      "result:alpha:passed",
      `start:${FILE_B}`,
      "result:beta:failed",
    ]);
  });

  it("returns the same results and exitCode with and without reporter callbacks", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    // Pinned session ids: the default ones carry a per-run timestamp.
    const sessionIdForCase = (file: string) => `pinned/${file}`;
    const plain = await runTests({ workflow: "order-lookup", sessionIdForCase });
    const reported: CaseResult[] = [];
    const withReporter = await runTests({
      workflow: "order-lookup",
      sessionIdForCase,
      onCaseResult: (r) => reported.push(r),
    });
    expect(withReporter.results).toEqual(plain.results);
    expect(withReporter.exitCode).toBe(plain.exitCode);
    expect(withReporter.exitCode).toBe(1);
    expect(reported).toEqual(withReporter.results);
  });

  // The runner returns data; rendering is the CLI's (or the host's) job.
  it("prints nothing itself, with or without reporter callbacks", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runTests({ workflow: "order-lookup" });
    await runTests({ workflow: "order-lookup", onCaseStart: () => {} });
    expect(log).not.toHaveBeenCalled();
  });
});

/**
 * A store-shaped authoring backend: the raw `BackendProtocolV2` surface a host
 * whose authored tree lives outside the filesystem hands in, so the test
 * exercises the same wrapping production does rather than a pre-wrapped plane.
 */
function authoringBackend(files: Record<string, string>) {
  const rel = (p: string) => p.replace(/^\/+/, "").replace(/\/+$/, "");
  return {
    async ls(path: string) {
      const dir = rel(path);
      const seen = new Map<string, boolean>();
      for (const key of Object.keys(files)) {
        if (!key.startsWith(`${dir}/`)) continue;
        const rest = key.slice(dir.length + 1);
        const head = rest.split("/")[0] as string;
        seen.set(`${dir}/${head}`, rest.includes("/") || seen.get(`${dir}/${head}`) === true);
      }
      return { files: [...seen.entries()].map(([path, is_dir]) => ({ path, is_dir })) };
    },
    async readRaw(path: string) {
      const key = rel(path);
      return key in files ? { data: { content: files[key] } } : { error: `no such file: ${key}` };
    },
  } as never;
}

describe("runTests host-supplied authoring backend", () => {
  // The regression this exists for: a host whose cases live in a store had them
  // read from the local filesystem instead, which holds no `workflows/` tree at
  // all — so every suite discovered nothing and reported an empty run rather
  // than failing to find its cases.
  it("discovers and runs the cases the supplied backend serves, not the filesystem's", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    // The filesystem plane still serves alpha and beta; the store serves one
    // case under a different name, and that is the one that must run.
    const { target } = fakeTarget();
    const { results } = await runTests({
      workflow: "order-lookup",
      authoring: authoringBackend({ [`${TESTS_DIR}/stored.test.yaml`]: ALPHA }),
      createTarget: target,
    });
    expect(results.map((r) => r.id)).toEqual(["stored"]);
    expect(results[0]?.verdict.status).toBe("passed");
  });

  // The fixtures a case's `workspace:` entries name are read from the same
  // plane the case came from — a store-backed suite would otherwise seed from
  // whatever the local root happens to hold.
  it("reads a case's file-sourced seeds from the supplied backend", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { target, seeds } = fakeTarget();
    await runTests({
      workflow: "order-lookup",
      authoring: authoringBackend({
        [`${TESTS_DIR}/stored.test.yaml`]: `
title: stored
description: stored case
workspace:
  order.json: { from: fixtures/order.json }
steps:
  - send: "hi"
  - succeeded: true
`,
        [`${TESTS_DIR}/fixtures/order.json`]: '{"id":"stored-fixture"}',
      }),
      createTarget: target,
    });
    expect(seeds[0]?.files["order.json"]).toBe('{"id":"stored-fixture"}');
  });
});

describe("runTests host-supplied target", () => {
  it("drives the caller's target and never builds the default one", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { target, sessions } = fakeTarget();
    const { results } = await runTests({
      workflow: "order-lookup",
      createTarget: async () => target,
    });
    expect(createCaseTarget).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(2);
    expect(results.map((r) => r.id)).toEqual(["alpha", "beta"]);
  });

  it("passes the resolved workspace root and the event handler to the factory", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const seen: Array<{ workflow: string; rootDir: string; onEvent?: unknown }> = [];
    const onEvent = () => {};
    await runTests({
      workflow: "order-lookup",
      onEvent,
      createTarget: async (ctx) => {
        seen.push(ctx);
        return fakeTarget().target;
      },
    });
    expect(seen).toEqual([{ workflow: "order-lookup", rootDir: "/ws", onEvent }]);
  });

  it("refuses a non-workflow-governed target with the same error the default builder raises", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { target, sessions } = fakeTarget("plain");
    await expect(
      runTests({ workflow: "order-lookup", createTarget: async () => target }),
    ).rejects.toThrow(
      "Case target 'order-lookup' has no workflow machine; " +
        "cases require a workflow-governed agent.",
    );
    expect(sessions).toHaveLength(0);
  });

  it("builds the default target with today's options when no factory is supplied", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const sandboxRuntime = { id: "fake" } as never;
    const modelFactory = (() => {}) as never;
    const onEvent = () => {};
    await runTests({ workflow: "order-lookup", onEvent, sandboxRuntime, modelFactory });
    expect(createCaseTarget).toHaveBeenCalledTimes(1);
    expect(createCaseTarget).toHaveBeenCalledWith({
      workflow: "order-lookup",
      rootDir: "/ws",
      onEvent,
      sandboxRuntime,
      modelFactory,
    });
  });

  it("holds an instance target to the workflow-governed guard", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { target } = fakeTarget("plain");
    await expect(runTests({ workflow: "order-lookup", createTarget: target })).rejects.toThrow(
      "has no workflow machine",
    );
  });
});

describe("runTests caller-addressable case sessions", () => {
  it("runs each case on the session the caller named", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { target, sessions } = fakeTarget();
    await runTests({
      workflow: "order-lookup",
      createTarget: async () => target,
      sessionIdForCase: (file) => `host-run-42/${file}`,
    });
    expect(sessions).toEqual([`host-run-42/${FILE_A}`, `host-run-42/${FILE_B}`]);
  });

  it("reports the session each case ran on, so a host can attribute usage to it", async () => {
    const { target } = fakeTarget();
    const { results } = await runTests({
      workflow: "order-lookup",
      createTarget: async () => target,
      sessionIdForCase: (file) => `host-run-42/${file}`,
    });
    expect(results.map((r) => r.sessionId)).toEqual([
      `host-run-42/${FILE_A}`,
      `host-run-42/${FILE_B}`,
    ]);
  });

  it("keeps the harness-minted session id when no hook is supplied", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { target, sessions } = fakeTarget();
    await runTests({
      workflow: "order-lookup",
      filter: "alpha",
      createTarget: async () => target,
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatch(
      /^test-default-test-run-\d+-workflows-order-lookup-tests-alpha\.test\.yaml$/,
    );
  });
});

describe("runTests fail-closed tool mocks", () => {
  const MOCKING_CASE = `
title: alpha
description: alpha case
mocks:
  - tool: read_file
    result: "[]"
steps:
  - send: hi
`;

  it("refuses a mock-declaring case against a target without the capability, before the agent runs", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { target, sessions, seeds } = fakeTarget("workflow", { toolMocks: false });
    tree[FILE_A] = MOCKING_CASE;
    const { results, exitCode } = await runTests({
      workflow: "order-lookup",
      filter: "alpha",
      createTarget: async () => target,
    });
    expect(sessions).toHaveLength(0);
    expect(seeds).toHaveLength(0);
    expect(exitCode).toBe(1);
    expect(results[0]?.verdict.status).toBe("failed");
    expect(results[0]?.verdict.failures.join("\n")).toContain("createToolMockMiddleware()");
  });

  it("passes declared mocks into every send of a capability-carrying target", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { target, sessions } = fakeTarget("workflow", { toolMocks: true });
    const invokeConfigs: Array<Record<string, unknown>> = [];
    const graph = target as unknown as { invoke: (i: unknown, c: never) => unknown };
    const originalInvoke = graph.invoke.bind(graph);
    graph.invoke = ((input: unknown, config: { configurable: Record<string, unknown> }) => {
      invokeConfigs.push(config.configurable);
      return originalInvoke(input, config as never);
    }) as never;
    tree[FILE_A] = MOCKING_CASE;

    await runTests({ workflow: "order-lookup", filter: "alpha", createTarget: async () => target });

    expect(sessions).toHaveLength(1);
    expect(invokeConfigs[0]?.__toolMocks).toEqual([{ name: "read_file", result: "[]" }]);
  });

  it("runs a mockless case against a capability-less target normally", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { target, sessions } = fakeTarget("workflow", { toolMocks: false });
    const { results } = await runTests({
      workflow: "order-lookup",
      filter: "alpha",
      createTarget: async () => target,
    });
    expect(sessions).toHaveLength(1);
    expect(results[0]?.verdict.status).toBe("passed");
  });
});

describe("runTests start conditions", () => {
  it("applies the case-declared trigger to every send", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { target, invocations } = fakeTarget();
    tree[FILE_A] = `
title: alpha
description: alpha case
trigger:
  id: report_requested
variables:
  company: Acme
steps:
  - send: hi
  - send: follow-up
`;
    await runTests({ workflow: "order-lookup", filter: "alpha", createTarget: async () => target });
    expect(invocations).toHaveLength(2);
    for (const input of invocations) {
      expect(input.trigger).toEqual({ id: "report_requested" });
      // The case's seeds ride every turn, locked — a trigger carries no payload.
      expect(input.variables).toEqual({ company: { value: "Acme", locked: true } });
    }
  });

  it("fails closed on an unknown trigger id before any step, even without steps", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { target, sessions } = fakeTarget();
    tree[FILE_A] = `
title: alpha
description: alpha case
trigger: { id: does_not_exist }
`;
    const { results, exitCode } = await runTests({
      workflow: "order-lookup",
      filter: "alpha",
      createTarget: async () => target,
    });
    expect(sessions).toHaveLength(0);
    expect(exitCode).toBe(1);
    expect(results[0]?.verdict.failures.join("\n")).toContain("Unknown trigger");
  });

  it("seeds declared workspace files before the first step", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { target, sessions, seeds } = fakeTarget();
    tree[FILE_A] = `
title: alpha
description: alpha case
workspace:
  trigger.json: { company: Acme }
steps:
  - send: hi
`;
    await runTests({
      workflow: "order-lookup",
      filter: "alpha",
      createTarget: async () => target,
      sessionIdForCase: () => "host-session",
    });
    expect(seeds).toEqual([
      { sessionId: "host-session", files: { "trigger.json": { company: "Acme" } } },
    ]);
    expect(sessions).toEqual(["host-session"]);
  });

  it("refuses declared files when the target's sessions handle cannot seed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { target, sessions } = fakeTarget("workflow", { toolMocks: true }, { seedable: false });
    tree[FILE_A] = `
title: alpha
description: alpha case
workspace:
  trigger.json: "x"
steps:
  - send: hi
`;
    const { results, exitCode } = await runTests({
      workflow: "order-lookup",
      filter: "alpha",
      createTarget: async () => target,
    });
    expect(sessions).toHaveLength(0);
    expect(exitCode).toBe(1);
    expect(results[0]?.verdict.failures.join("\n")).toContain("seed");
  });
});

describe("runTests file-sourced seeding", () => {
  it("resolves from: references within the tests directory", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { target, seeds } = fakeTarget();
    tree[`${TESTS_DIR}/shared/acme-trigger.json`] = `{"company":"Acme"}`;
    tree[FILE_A] = `
title: alpha
description: alpha case
workspace:
  trigger.json: { from: shared/acme-trigger.json }
steps:
  - send: hi
`;
    await runTests({
      workflow: "order-lookup",
      filter: "alpha",
      createTarget: async () => target,
      sessionIdForCase: () => "host-session",
    });
    expect(seeds).toEqual([
      { sessionId: "host-session", files: { "trigger.json": `{"company":"Acme"}` } },
    ]);
  });

  it("fails the case on a missing from: target, before any step", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { target, sessions } = fakeTarget();
    tree[FILE_A] = `
title: alpha
description: alpha case
workspace:
  trigger.json: { from: shared/missing.json }
steps:
  - send: hi
`;
    const { results } = await runTests({
      workflow: "order-lookup",
      filter: "alpha",
      createTarget: async () => target,
    });
    expect(sessions).toHaveLength(0);
    expect(results[0]?.verdict.status).toBe("failed");
    expect(results[0]?.verdict.failures.join("\n")).toContain("shared/missing.json");
  });

  it("fails the case on an escaping from: path", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { target, sessions } = fakeTarget();
    tree[FILE_A] = `
title: alpha
description: alpha case
workspace:
  orders.json: { from: ../data/orders.json }
steps:
  - send: hi
`;
    const { results } = await runTests({
      workflow: "order-lookup",
      filter: "alpha",
      createTarget: async () => target,
    });
    expect(sessions).toHaveLength(0);
    expect(results[0]?.verdict.failures.join("\n")).toContain("escapes the tests directory");
  });
});

describe("runTests steps", () => {
  it("routes decide steps through the target's decide with target and comment", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { target, decisions } = fakeTarget();
    tree[FILE_A] = `
title: alpha
description: alpha case
steps:
  - send: hi
  - decide:
      to: refund-closed
      comment: looks correct
`;
    await runTests({
      workflow: "order-lookup",
      filter: "alpha",
      createTarget: async () => target,
      sessionIdForCase: () => "host-session",
    });
    expect(decisions).toEqual([
      { sessionId: "host-session", target: "refund-closed", comment: "looks correct" },
    ]);
  });

  it("evaluates each assertion against the nearest preceding action", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { target } = fakeTarget("workflow", { toolMocks: true }, { reply: "ORD-1003 delayed" });
    tree[FILE_A] = `
title: alpha
description: alpha case
steps:
  - send: hi
  - reply:
      includes: "ORD-1003"
  - decide: { to: done }
  - succeeded: true
`;
    const { results } = await runTests({
      workflow: "order-lookup",
      filter: "alpha",
      createTarget: async () => target,
    });
    // The reply assertion saw the send's view; succeeded saw the decide's
    // (fake decide returns a clean, unparked view).
    expect(results[0]?.verdict.status).toBe("passed");
    expect(results[0]?.records.map((r) => r.kind)).toEqual(["reply.includes", "succeeded"]);
  });
});

describe("runTests record step attribution", () => {
  it("stamps each record with its index in the case's steps list", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { target } = fakeTarget("workflow", { toolMocks: true }, { reply: "ORD-1003 delayed" });
    tree[FILE_A] = `
title: alpha
description: alpha case
steps:
  - send: hi
  - reply:
      includes: "ORD-1003"
  - decide: { to: done }
  - succeeded: true
`;
    const { results } = await runTests({
      workflow: "order-lookup",
      filter: "alpha",
      createTarget: async () => target,
    });
    // Sparse by design: the actions at 0 and 2 produce no records.
    expect(results[0]?.records.map((r) => ({ kind: r.kind, step: r.step }))).toEqual([
      { kind: "reply.includes", step: 1 },
      { kind: "succeeded", step: 3 },
    ]);
  });

  it("distinguishes same-kind assertions at different steps", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { target } = fakeTarget("workflow", { toolMocks: true }, { reply: "ORD-1003 delayed" });
    tree[FILE_A] = `
title: alpha
description: alpha case
steps:
  - send: hi
  - reply:
      includes: "ORD-1003"
  - send: again
  - reply:
      includes: "delayed"
`;
    const { results } = await runTests({
      workflow: "order-lookup",
      filter: "alpha",
      createTarget: async () => target,
    });
    const records = results[0]?.records ?? [];
    expect(records.map((r) => r.kind)).toEqual(["reply.includes", "reply.includes"]);
    // Same kind, same verdict — only `step` tells them apart, and grouping by
    // it reconstructs the per-step view without relying on record order.
    expect(records.map((r) => r.step)).toEqual([1, 3]);
    expect(records.find((r) => r.step === 1)?.detail).toBe("ORD-1003");
    expect(records.find((r) => r.step === 3)?.detail).toBe("delayed");
  });
});

describe("runTests partial records on failure", () => {
  /** A target whose Nth send (1-based) throws; earlier sends reply normally. */
  function targetFailingOnSend(failOn: number, reply: string) {
    let sends = 0;
    const { target } = fakeTarget("workflow", { toolMocks: true }, { reply });
    const graph = target as unknown as { invoke: (i: never, c: never) => unknown };
    const original = graph.invoke.bind(graph);
    graph.invoke = ((input: never, config: never) => {
      sends += 1;
      if (sends === failOn) throw new Error("agent exploded");
      return original(input, config);
    }) as never;
    return target;
  }

  it("reports the records produced before a failing action", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    tree[FILE_A] = `
title: alpha
description: alpha case
steps:
  - send: hi
  - reply:
      includes: "ORD-1003"
  - succeeded: true
  - send: again
  - succeeded: true
`;
    const { results, exitCode } = await runTests({
      workflow: "order-lookup",
      filter: "alpha",
      createTarget: async () => targetFailingOnSend(2, "ORD-1003 delayed"),
    });
    expect(exitCode).toBe(1);
    expect(results[0]?.verdict.status).toBe("failed");
    expect(results[0]?.error).toBe("agent exploded");
    // The two steps that had already evaluated are still reported, attributed —
    // and the step after the throw is accounted for rather than dropped.
    expect(
      results[0]?.records.map((r) => ({ kind: r.kind, step: r.step, status: r.status })),
    ).toEqual([
      { kind: "reply.includes", step: 1, status: "passed" },
      { kind: "succeeded", step: 2, status: "passed" },
      { kind: "succeeded", step: 4, status: "not-executed" },
    ]);
  });

  it("lists the terminating error first and an earlier gate failure after it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    tree[FILE_A] = `
title: alpha
description: alpha case
steps:
  - send: hi
  - reply:
      includes: "boom-token"
  - send: again
  - succeeded: true
`;
    const { results } = await runTests({
      workflow: "order-lookup",
      filter: "alpha",
      createTarget: async () => targetFailingOnSend(2, "nothing matching"),
    });
    expect(results[0]?.verdict.failures).toEqual(["agent exploded", "reply.includes: boom-token"]);
    // The un-run step is reported but contributes no failure of its own.
    expect(results[0]?.records.map((r) => r.status)).toEqual(["failed", "not-executed"]);
  });

  it("reports the records produced before the case timed out", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    specTests = { caseTimeoutMs: 30 };
    const { target } = fakeTarget("workflow", { toolMocks: true }, { reply: "ORD-1003 delayed" });
    const graph = target as unknown as { invoke: (i: never, c: never) => unknown };
    const original = graph.invoke.bind(graph);
    let sends = 0;
    graph.invoke = (async (input: never, config: never) => {
      sends += 1;
      // The second send never settles, so the case's wall-clock budget expires
      // with the first send's assertions already recorded.
      if (sends === 2) await new Promise(() => {});
      return original(input, config);
    }) as never;
    tree[FILE_A] = `
title: alpha
description: alpha case
steps:
  - send: hi
  - reply:
      includes: "ORD-1003"
  - send: again
  - succeeded: true
`;
    const { results, exitCode } = await runTests({
      workflow: "order-lookup",
      filter: "alpha",
      createTarget: async () => target,
    });
    expect(exitCode).toBe(1);
    expect(results[0]?.verdict.status).toBe("failed");
    expect(results[0]?.error).toMatch(/timed out after 30ms/);
    expect(
      results[0]?.records.map((r) => ({ kind: r.kind, step: r.step, status: r.status })),
    ).toEqual([
      { kind: "reply.includes", step: 1, status: "passed" },
      { kind: "succeeded", step: 3, status: "not-executed" },
    ]);
  });

  it("reports every step un-run when the case is refused before its first step", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { target, sessions } = fakeTarget("workflow", { toolMocks: false });
    tree[FILE_A] = `
title: alpha
description: alpha case
mocks:
  - tool: read_file
    result: "[]"
steps:
  - send: hi
  - succeeded: true
`;
    const { results } = await runTests({
      workflow: "order-lookup",
      filter: "alpha",
      createTarget: async () => target,
    });
    expect(sessions).toHaveLength(0);
    expect(results[0]?.verdict.status).toBe("failed");
    // Nothing ran, so every assertion the case declared is accounted for as
    // un-run rather than silently absent.
    expect(
      results[0]?.records.map((r) => ({ kind: r.kind, step: r.step, status: r.status })),
    ).toEqual([{ kind: "succeeded", step: 1, status: "not-executed" }]);
    expect(results[0]?.verdict.failures.join("\n")).toContain("createToolMockMiddleware()");
  });
});

describe("runTests halts on structural failure", () => {
  /** The fake target never reaches `refund-review`, so `reachedState` misses. */
  const HALTING_CASE = `
title: alpha
description: alpha case
steps:
  - send: hi
  - reachedState: refund-review
  - send: again
  - reply:
      includes: ["a", "b"]
  - succeeded: true
`;

  it("stops driving the agent and reports the rest un-run", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { target, sessions } = fakeTarget("workflow", { toolMocks: true }, { reply: "hello" });
    tree[FILE_A] = HALTING_CASE;
    const { results, exitCode } = await runTests({
      workflow: "order-lookup",
      filter: "alpha",
      createTarget: async () => target,
    });
    // The second send never happens: one invocation, not two.
    expect(sessions).toHaveLength(1);
    expect(exitCode).toBe(1);
    expect(results[0]?.verdict.status).toBe("failed");
    // A halt is a verdict, not a case-level error.
    expect(results[0]?.error).toBeUndefined();
    expect(results[0]?.verdict.failures).toEqual(["reachedState: refund-review"]);
    // One record per un-run step — the two-token `reply` is one step, not two.
    expect(
      results[0]?.records.map((r) => ({ kind: r.kind, step: r.step, status: r.status })),
    ).toEqual([
      { kind: "reachedState", step: 1, status: "failed" },
      { kind: "reply", step: 3, status: "not-executed" },
      { kind: "succeeded", step: 4, status: "not-executed" },
    ]);
  });

  it("does not halt on a failed content assertion", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { target, sessions } = fakeTarget("workflow", { toolMocks: true }, { reply: "hello" });
    tree[FILE_A] = `
title: alpha
description: alpha case
steps:
  - send: hi
  - reply:
      includes: "boom-token"
  - send: again
  - succeeded: true
`;
    const { results } = await runTests({
      workflow: "order-lookup",
      filter: "alpha",
      createTarget: async () => target,
    });
    // Both sends happen; the case runs to the end despite the content miss.
    expect(sessions).toHaveLength(2);
    expect(results[0]?.records.map((r) => r.status)).toEqual(["failed", "passed"]);
  });
});

describe("runTests grade wiring", () => {
  it("scores grade steps through the configured grading model", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    specTests = { judge: { model: "gpt-test" } };
    const { target } = fakeTarget("workflow", { toolMocks: true }, { reply: "approved" });
    tree[FILE_A] = `
title: alpha
description: alpha case
steps:
  - send: hi
  - grade:
      closedQA: approves the refund
      atLeast: 0.7
`;
    const { results } = await runTests({
      workflow: "order-lookup",
      filter: "alpha",
      createTarget: async () => target,
    });
    expect(results[0]?.verdict.status).toBe("passed");
    expect(results[0]?.records[0]).toMatchObject({
      kind: "grade.closedQA",
      threshold: 0.7,
      score: 1,
    });
  });

  it("fails a grade step actionably when no grading model is configured", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { target } = fakeTarget();
    tree[FILE_A] = `
title: alpha
description: alpha case
steps:
  - send: hi
  - grade: { closedQA: approves, atLeast: 0.7 }
`;
    const { results, exitCode } = await runTests({
      workflow: "order-lookup",
      filter: "alpha",
      createTarget: async () => target,
    });
    // An unavailable judge is an actionable failure, not a silent pass — and
    // it fails the case with no flag involved.
    expect(results[0]?.verdict.status).toBe("failed");
    expect(results[0]?.verdict.failures.join("\n")).toContain("grading model unavailable");
    expect(exitCode).toBe(1);
  });
});

describe("runTests maxConcurrency guard", () => {
  it("fails loudly when tests.maxConcurrency is above 1", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    specTests = { maxConcurrency: 4 };
    await expect(runTests({ workflow: "order-lookup" })).rejects.toThrow(
      /maxConcurrency.*not.*implemented.*sequentially/s,
    );
    expect(createCaseTarget).not.toHaveBeenCalled();
  });

  it("accepts maxConcurrency: 1 unchanged", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    specTests = { maxConcurrency: 1 };
    const { results } = await runTests({ workflow: "order-lookup" });
    expect(results.map((r) => r.id)).toEqual(["alpha", "beta"]);
  });
});

describe("runTests skips a disabled workflow", () => {
  // *Not run* is not *failed*: retiring a workflow must not turn a CI run red.
  it("runs no case, reports the skip, and exits 0", async () => {
    specRoot = { disabled: true };
    const { results, exitCode, skipped } = await runTests({ workflow: "order-lookup" });
    expect(results).toEqual([]);
    expect(exitCode).toBe(0);
    expect(skipped).toBe("disabled");
    // Nothing was even assembled for the run.
    expect(createCaseTarget).not.toHaveBeenCalled();
  });

  it("is distinguishable from an empty suite, which reports no skip", async () => {
    tree = {};
    const { results, exitCode, skipped } = await runTests({ workflow: "order-lookup" });
    expect(results).toEqual([]);
    expect(exitCode).toBe(0);
    expect(skipped).toBeUndefined();
  });

  it("reads the flag fail-closed, so mis-authored junk still skips", async () => {
    specRoot = { disabled: "no" };
    expect((await runTests({ workflow: "order-lookup" })).skipped).toBe("disabled");
  });

  it("runs the suite when the flag is false", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    specRoot = { disabled: false };
    const { results, skipped } = await runTests({ workflow: "order-lookup" });
    expect(skipped).toBeUndefined();
    expect(results.map((r: CaseResult) => r.id).sort()).toEqual(["alpha", "beta"]);
  });
});

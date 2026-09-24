import { describe, expect, it } from "vitest";
import type { BackendProtocolV2 } from "deepagents";
import { Workspace } from "../core/workspace.js";
import { createScriptExecutor, type ScriptRunParams } from "./executor.js";
import type { SandboxRuntime } from "./runtime.js";

function workspaceWith(files: Record<string, string>): Workspace {
  const norm = (p: string) => `/${p.replace(/^\/+/, "")}`;
  const backend = {
    async readRaw(filePath: string) {
      const content = files[norm(filePath)];
      return content === undefined
        ? { error: "missing" }
        : { data: { content, mimeType: "text/plain", created_at: "", modified_at: "" } };
    },
  } as unknown as BackendProtocolV2;
  return new Workspace(backend);
}

/** Run one hook source as a lifecycle hook and return its outcome. */
async function runHook(source: string, args: Record<string, unknown> = {}, sessionId = "hook") {
  const executor = createScriptExecutor({ workspace: workspaceWith({ "/hooks/x.js": source }) });
  const params: ScriptRunParams = { sessionId, sessionNamespace: "process", args, lifecycle: true };
  const outcome = await executor.runFile("hooks/x.js", params);
  executor.dispose(sessionId);
  return outcome;
}

describe("createScriptExecutor.runCode", () => {
  it("evaluates inline code under the PTC contract when the prelude is asked for", async () => {
    const executor = createScriptExecutor({ workspace: workspaceWith({}) });
    const outcome = await executor.runCode("SANDBOX_CONTRACT.context", {
      sessionId: "e1",
      sessionNamespace: "agent",
      prelude: true,
    });
    executor.dispose("e1");
    expect(outcome.ok, outcome.error?.message).toBe(true);
    expect(outcome.value).toBe("ptc");
  });

  it("keeps REPL state across calls in one session, as the eval tool relies on", async () => {
    const executor = createScriptExecutor({ workspace: workspaceWith({}) });
    const params = { sessionId: "e2", sessionNamespace: "agent", prelude: true } as const;
    await executor.runCode("globalThis.total = 40", params);
    const outcome = await executor.runCode("total + 2", params);
    executor.dispose("e2");
    expect(outcome.value).toBe(42);
  });

  it("leaves code raw when no prelude is requested", async () => {
    const executor = createScriptExecutor({ workspace: workspaceWith({}) });
    const outcome = await executor.runCode("typeof SANDBOX_CONTRACT", {
      sessionId: "e3",
      sessionNamespace: "agent",
    });
    executor.dispose("e3");
    expect(outcome.value).toBe("undefined");
  });

  it("does not give the model's code the hook vocabulary", async () => {
    const executor = createScriptExecutor({ workspace: workspaceWith({}) });
    const outcome = await executor.runCode("[typeof veto, typeof defineHook, typeof t]", {
      sessionId: "e4",
      sessionNamespace: "agent",
      prelude: true,
    });
    executor.dispose("e4");
    expect(outcome.value).toEqual(["undefined", "undefined", "undefined"]);
  });
});

describe("createScriptExecutor.runFile", () => {
  it("reports a clear error when the script is not served by the backend", async () => {
    const executor = createScriptExecutor({ workspace: workspaceWith({}) });
    const outcome = await executor.runFile("scripts/missing.js", {
      sessionId: "t1",
      sessionNamespace: "agent",
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.message).toContain("scripts/missing.js");
  });

  it("reads and evaluates a script sourced from the backend, with its args", async () => {
    const executor = createScriptExecutor({
      workspace: workspaceWith({ "/scripts/add.js": "args.a + args.b + args.variables.c" }),
    });
    const outcome = await executor.runFile("scripts/add.js", {
      sessionId: "t2",
      sessionNamespace: "agent",
      args: { a: 40, b: 1, variables: { c: 1 } },
    });
    executor.dispose("t2");
    expect(outcome.ok).toBe(true);
    expect(outcome.value).toBe(42);
  });

  it("routes execution through a custom sandbox runtime, with namespaced disposal and quotas", async () => {
    const evals: { namespace: string; code: string }[] = [];
    const disposed: string[] = [];
    let seenQuotas: unknown;
    const stub: SandboxRuntime = {
      session(namespace, options) {
        seenQuotas = options.quotas;
        return {
          async eval(code: string) {
            evals.push({ namespace, code });
            return { ok: true, value: "from-stub", logs: [], formatted: "from-stub" };
          },
        };
      },
      dispose(namespace) {
        disposed.push(namespace);
      },
    };

    const executor = createScriptExecutor({
      workspace: workspaceWith({ "/scripts/x.js": "1 + 1" }),
      maxResultChars: 4096,
      sandboxRuntime: stub,
    });
    const outcome = await executor.runFile("scripts/x.js", { sessionId: "t3", sessionNamespace: "agent" });
    executor.dispose("t3", "agent");

    expect(outcome.value).toBe("from-stub");
    expect(evals[0]?.namespace).toBe("t3:agent");
    expect(evals[0]?.code).toContain("1 + 1");
    expect(seenQuotas).toMatchObject({ maxResultChars: 4096 });
    expect(disposed).toEqual(["t3:agent"]);
  });
});

describe("lifecycle hooks", () => {
  it("calls the default-export function with the hook input and takes its verdict", async () => {
    const outcome = await runHook(
      `/** Vetoes unless the state is expected. */
import { veto, ok } from "@archmax-ai/harness/sandbox";
export default async function hook({ state, phase, variables, messages, tools }) {
  if (state !== "expected") return veto(\`wrong state \${state} in \${phase}\`);
  if (variables.flag !== true || messages.length !== 1) return veto("input missing");
  return ok();
}`,
      { state: "other", phase: "before", variables: { flag: true }, messages: [{ role: "user", text: "hi" }] },
    );
    expect(outcome.ok, outcome.error?.message).toBe(true);
    expect(outcome.value).toEqual({ verdict: "veto", reason: "wrong state other in before" });

    const passing = await runHook(
      `export default ({ state, variables, messages }) =>
        state === "expected" && variables.flag === true && messages.length === 1 ? ok() : veto("no");`,
      { state: "expected", phase: "before", variables: { flag: true }, messages: [{ role: "user", text: "hi" }] },
    );
    expect(passing.value).toMatchObject({ verdict: "ok" });
  });

  it("treats a hook that returns nothing as ok, and a bare false as a veto", async () => {
    expect((await runHook(`export default async () => { console.log("fine"); };`)).value).toMatchObject({
      verdict: "ok",
    });
    expect((await runHook(`export default () => false;`)).value).toMatchObject({ verdict: "veto" });
  });

  it("fails closed on an object that is not a verdict, naming its keys", async () => {
    // A hook's return value is its verdict and nothing else, so an object that
    // is not one is a verdict its author got wrong. Read as `ok` it would
    // silently permit exactly what the hook meant to block.
    const retired = await runHook(`export default () => ({ ok: false, reason: "nope" });`);
    expect(retired.ok).toBe(false);
    expect(retired.error?.message).toContain("is not a verdict");
    expect(retired.error?.message).toContain("'ok', 'reason'");

    // The commonest way to get it wrong: the right key, the wrong value.
    const typo = await runHook(`export default () => ({ verdict: "VETO", reason: "shouting" });`);
    expect(typo.ok).toBe(false);
    expect(typo.error?.message).toContain("is not a verdict");

    const array = await runHook(`export default () => ["veto"];`);
    expect(array.ok).toBe(false);
    expect(array.error?.message).toContain("an array");
  });

  it("keeps every non-object return an opinion-free ok", async () => {
    // `return isAuthorized(x)` is the point of the `false` shorthand, so `true`
    // must stay `ok`; a bare-body script's incidental completion value likewise
    // says nothing about the verdict.
    for (const src of [
      `export default () => true;`,
      `export default () => undefined;`,
      `export default () => null;`,
      `/** Bare body. */
const orders = [1];
orders.length;`,
    ]) {
      const outcome = await runHook(src);
      expect(outcome.ok, src).toBe(true);
      expect(outcome.value, src).toMatchObject({ verdict: "ok" });
    }
  });

  it("accepts defineHook as an alias for export default", async () => {
    const outcome = await runHook(
      `import { defineHook, correct } from "@archmax-ai/harness/sandbox";\nexport default defineHook(() => correct("add the totals"));`,
    );
    expect(outcome.value).toEqual({ verdict: "correct", reason: "add the totals" });
  });

  it("takes a bare-body script's completion value as its verdict", async () => {
    const outcome = await runHook(`/** Bare body. */\nconst orders = [];\norders.length > 0 ? ok() : veto("no orders");`);
    expect(outcome.value).toEqual({ verdict: "veto", reason: "no orders" });
    const silent = await runHook(`/** Says nothing. */\nconsole.log("checked");`);
    expect(silent.value).toMatchObject({ verdict: "ok" });
    expect(silent.logs).toEqual(["checked"]);
  });

  it("fails closed when the hook throws", async () => {
    const outcome = await runHook(`export default () => { throw new Error("hook exploded"); };`);
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.message).toContain("hook exploded");
  });

  it("fails closed on a foreign import", async () => {
    const outcome = await runHook(`import fs from "node:fs";\nconsole.log(fs);`);
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.message).toContain("node:fs");
    expect(outcome.error?.message).toContain("@archmax-ai/harness/*");
  });

  it("fails closed on a source that does not parse", async () => {
    const outcome = await runHook(`export default async function ( {`);
    expect(outcome.ok).toBe(false);
  });

  it("exposes the hook input as the global args too", async () => {
    const outcome = await runHook(`args.state === "s" && args.phase === "after" ? ok() : veto("args missing");`, {
      state: "s",
      phase: "after",
    });
    expect(outcome.value).toMatchObject({ verdict: "ok" });
  });

  describe("a superseded hook vocabulary", () => {
    it("throws rather than being served by a compatibility prelude", async () => {
      // `t` is undefined in the sandbox: the source throws, which the runtime
      // reads as a fail-closed veto, and nothing reports a deprecation.
      const outcome = await runHook(`export default () => t.check(1, { equals: 1 });`);
      expect(outcome.ok).toBe(false);
      expect(outcome.error?.message ?? "").toMatch(/\bt\b/);
    });
  });
});

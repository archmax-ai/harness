import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchCli, parseVariablesJson } from "./cli.js";

/** Capture both streams; returns the exit code and what each stream received. */
async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const code = await dispatchCli(args);
    return {
      code,
      stdout: log.mock.calls.map((c) => String(c[0])).join("\n"),
      stderr: error.mock.calls.map((c) => String(c[0])).join("\n"),
    };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

const EXAMPLE = resolve(import.meta.dirname, "../examples/customer-support");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("help", () => {
  it("prints top-level help on stdout for --help, -h and 'help', exit 0", async () => {
    for (const args of [["--help"], ["-h"], ["help"]]) {
      const { code, stdout } = await run(args);
      expect(code).toBe(0);
      expect(stdout).toContain("Usage: archmax <command>");
      // Every command is listed with its argument shape.
      for (const line of [
        "run <workflow> <prompt...>",
        "test <workflow> [filter]",
        "validate <workflow>",
        "sessions [session]",
        "decide <session>",
        "reply <session> <message...>",
        "deliver <session>",
      ]) {
        expect(stdout).toContain(line);
      }
      expect(stdout).toContain("--root <dir>");
    }
  });

  it("prints a command's help for 'help <cmd>' and '<cmd> --help', generated from its table", async () => {
    const viaHelp = await run(["help", "decide"]);
    const viaFlag = await run(["decide", "--help"]);
    expect(viaHelp.code).toBe(0);
    expect(viaHelp.stdout).toBe(viaFlag.stdout);
    expect(viaHelp.stdout).toContain("Usage: archmax decide <session> [options]");
    expect(viaHelp.stdout).toContain("--to <state>");
    expect(viaHelp.stdout).toContain("--comment <text>");
    expect(viaHelp.stdout).toContain("--root <dir>");
  });

  it("says the workflow may be inferred, and that reply carries no target", async () => {
    const runHelp = await run(["run", "--help"]);
    expect(runHelp.stdout).toContain("exactly one");
    const replyHelp = await run(["reply", "--help"]);
    expect(replyHelp.stdout).toContain("stays parked");
    expect(replyHelp.stdout).not.toContain("--to");
    const sessionsHelp = await run(["sessions", "--help"]);
    expect(sessionsHelp.stdout).toContain("locked");
  });

  it("names the detail form of sessions", async () => {
    const { stdout } = await run(["help", "sessions"]);
    expect(stdout).toContain("archmax sessions [session]");
  });
});

describe("usage errors exit 2 with one line and a --help hint, never a usage dump", () => {
  it("rejects a missing command with the top-level help on stderr", async () => {
    const { code, stdout, stderr } = await run([]);
    expect(code).toBe(2);
    expect(stderr).toContain("Usage: archmax <command>");
    expect(stderr).toContain("a command is required");
    expect(stdout).toBe("");
  });

  it("rejects a bare prompt as an unknown command", async () => {
    const { code, stdout, stderr } = await run(["Explain", "what", "a", "state", "machine", "is."]);
    expect(code).toBe(2);
    expect(stderr).toContain("unknown command 'Explain'");
    expect(stderr).toContain("try: archmax help");
    expect(stdout).toBe("");
  });

  it("rejects an unknown flag", async () => {
    const { code, stderr } = await run(["validate", "order-lookup", "--bogus", "--root", EXAMPLE]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/Error: .*--bogus.*\(try: archmax validate --help\)/);
    expect(stderr.split("\n")).toHaveLength(1);
  });

  it("rejects the removed flag spellings the same way", async () => {
    for (const args of [
      ["run", "--directory", EXAMPLE, "--workflow", "order-lookup", "--prompt", "hi"],
      ["run", "order-lookup", "hi", "--workflow", "order-lookup"],
      ["reply", "th_1", "--message", "hi"],
      ["decide", "th_1", "--target", "done"],
      ["test", "order-lookup", "--strict"],
    ]) {
      const { code, stderr } = await run(args);
      expect(code, args.join(" ")).toBe(2);
      expect(stderr).toContain("(try: archmax");
    }
  });

  it("rejects an extra positional where a command declares none", async () => {
    const { code, stderr } = await run(["deliver", "th_1", "email_reply", "--trigger", "x"]);
    expect(code).toBe(2);
    expect(stderr).toContain("unexpected argument 'email_reply'");
  });

  it("requires both a workflow and a prompt for run (no default prompt, no default workflow)", async () => {
    const noWorkflow = await run(["run"]);
    expect(noWorkflow.code).toBe(2);
    expect(noWorkflow.stderr).toMatch(/workflow is required/);
    expect(noWorkflow.stdout).toBe("");

    const noPrompt = await run(["run", "order-lookup", "--root", EXAMPLE]);
    expect(noPrompt.code).toBe(2);
    expect(noPrompt.stderr).toContain("a prompt is required");
  });

  it("rejects malformed --variables before any assembly, on run and deliver", async () => {
    const onRun = await run([
      "run",
      "order-lookup",
      "hi",
      "--root",
      EXAMPLE,
      "--variables",
      "not-json",
    ]);
    expect(onRun.code).toBe(2);
    expect(onRun.stderr).toContain("--variables is not valid JSON");
    expect(onRun.stdout).toBe("");

    const onDeliver = await run([
      "deliver",
      "th_1",
      "--trigger",
      "email_reply",
      "--variables",
      "[1]",
      "--root",
      EXAMPLE,
    ]);
    expect(onDeliver.code).toBe(2);
    expect(onDeliver.stderr).toContain("must encode a JSON object");
  });

  it("requires a session id and the keyed option each session command depends on", async () => {
    expect((await run(["decide"])).stderr).toContain("a session id is required");
    expect((await run(["decide", "th_1"])).stderr).toContain("--to <state> is required");
    expect((await run(["reply", "th_1"])).stderr).toContain("a message is required");
    expect((await run(["reply", "th_1", "   "])).stderr).toContain("a message is required");
    expect((await run(["deliver", "th_1"])).stderr).toContain("--trigger <id> is required");
    for (const args of [["decide"], ["decide", "th_1"], ["reply", "th_1"], ["deliver", "th_1"]]) {
      expect((await run(args)).code).toBe(2);
    }
  });

  it("rejects an unusable session id before bootstrapping an agent", async () => {
    const { code, stderr } = await run(["sessions", "../escape", "--root", EXAMPLE]);
    expect(code).toBe(2);
    expect(stderr).toContain("invalid session id");
  });
});

describe("parseVariablesJson", () => {
  it("parses a JSON object", () => {
    expect(parseVariablesJson('{"from_email":"a@b.com","n":2}')).toEqual({
      from_email: "a@b.com",
      n: 2,
    });
    expect(parseVariablesJson(undefined)).toBeUndefined();
  });

  it("rejects malformed JSON and non-objects", () => {
    expect(() => parseVariablesJson("not-json")).toThrow(/not valid JSON/);
    for (const raw of ['"text"', "42", "null", "[1,2]"]) {
      expect(() => parseVariablesJson(raw)).toThrow(/must encode a JSON object/);
    }
  });
});

describe("validate", () => {
  it("prints diagnostics to stderr and one plain verdict line to stdout, exit 0", async () => {
    const { code, stdout, stderr } = await run(["validate", "order-lookup", "--root", EXAMPLE]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^valid — \d+ error\(s\), \d+ warning\(s\)$/);
    expect(stderr).toContain("order-lookup");
    expect(stderr).toContain("directory");
  });

  it("requires the workflow when the workspace has several, naming them", async () => {
    const { code, stderr } = await run(["validate", "--root", EXAMPLE]);
    expect(code).toBe(2);
    expect(stderr).toContain("this workspace has several: enrich-order, order-lookup");
  });

  it("writes only JSON to stdout with --json", async () => {
    const { code, stdout } = await run(["validate", "order-lookup", "--root", EXAMPLE, "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as {
      workflow: string;
      valid: boolean;
      diagnostics: unknown[];
    };
    expect(parsed.workflow).toBe("order-lookup");
    expect(parsed.valid).toBe(true);
    expect(Array.isArray(parsed.diagnostics)).toBe(true);
  });
});

describe("workspaces with several or no workflows", () => {
  const roots: string[] = [];

  function workspace(workflows: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "cli-ws-"));
    roots.push(root);
    for (const [slug, spec] of Object.entries(workflows)) {
      const file = resolve(root, `workflows/${slug}/workflow.yaml`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, spec);
    }
    return root;
  }

  const MINIMAL = ["states:", "  start:", "    triggers: { manual: }"].join("\n");
  const DISABLED = `disabled: true\n${MINIMAL}`;

  afterEach(() => {
    while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
  });

  it("infers the workflow when the workspace has exactly one", async () => {
    const root = workspace({ only: MINIMAL });
    const { code, stdout, stderr } = await run(["validate", "--root", root]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^valid/);
    expect(stderr).toContain("only");
  });

  it("says when there is nothing to infer from", async () => {
    const root = workspace({});
    const { code, stderr } = await run(["validate", "--root", root]);
    expect(code).toBe(2);
    expect(stderr).toContain("none was found");
  });

  // Assembly still succeeds (that is what serves `decide`/`reply`), so the
  // refusal is the command's: one line, exit 1, and no model call.
  it("refuses to run a disabled workflow, exit 1, nothing on stdout", async () => {
    vi.stubEnv("ARCHMAX_API_BASE_URL", "http://127.0.0.1:9/v1");
    vi.stubEnv("ARCHMAX_API_KEY", "unused-no-call-is-made");
    vi.stubEnv("ARCHMAX_MODEL", "stub-model");
    const { code, stdout, stderr } = await run([
      "run",
      "p",
      "hello",
      "--root",
      workspace({ p: DISABLED }),
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("workflow 'p' is disabled");
    expect(stderr).toContain("no session started");
    expect(stderr).toContain("Parked sessions can still be decided");
    expect(stdout).toBe("");
  });
});

describe("test", () => {
  it("fails with exit 1 and no model call when the filter matches nothing", async () => {
    vi.stubEnv("ARCHMAX_API_BASE_URL", "http://127.0.0.1:9/v1");
    vi.stubEnv("ARCHMAX_API_KEY", "unused-no-call-is-made");
    vi.stubEnv("ARCHMAX_MODEL", "stub-model");
    const { code, stdout, stderr } = await run(["test", "order-lookup", "zzz", "--root", EXAMPLE]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/no cases matched 'zzz' \(\d+ discovered\)/);
    expect(stdout).toBe("");
  });
});

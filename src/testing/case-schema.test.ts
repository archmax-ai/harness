import { describe, expect, it } from "vitest";
import {
  CaseSchemaError,
  caseIdForFile,
  collectFileReferences,
  isTestFile,
  normalizeFixturePath,
  parseCaseDocument,
} from "./case-schema.js";

const FILE = "workflows/order-lookup/tests/alpha.test.yaml";
const TESTS_DIR = "workflows/order-lookup/tests";

function parse(source: string) {
  return parseCaseDocument(FILE, source, TESTS_DIR);
}

describe("parseCaseDocument basics", () => {
  it("parses a minimal case", () => {
    const doc = parse(`
title: alpha
description: alpha case
steps:
  - send: "hi"
  - succeeded: true
`);
    expect(doc.id).toBe("alpha");
    expect(doc.steps).toEqual([
      { kind: "action", action: { action: "send", message: "hi" } },
      { kind: "assert", expect: { assert: "succeeded" } },
    ]);
  });

  // The per-file axis is gone: `runtime.version` versions the whole authoring
  // surface, so a case-file `version` is an unknown key like any other.
  it("rejects a case-file 'version' key as unknown", () => {
    expect(() => parse(`version: "1"\ntitle: alpha\ndescription: alpha case`)).toThrow(
      /unknown key 'version' \(known: title, description/,
    );
  });

  it("requires a description", () => {
    expect(() => parse(`title: t\nsteps: []`)).toThrow(/description.*required/);
    expect(() => parse(`{ title: t, description: "   " }`)).toThrow(/description/);
  });

  it("requires a title", () => {
    expect(() => parse(`description: alpha case`)).toThrow(/'title' is required/);
    expect(() => parse(`{ title: "  ", description: x }`)).toThrow(/'title' is required/);
  });

  it("keeps the prose fields short", () => {
    const long = (n: number) => "a ".repeat(n / 2).trim();
    expect(() => parse(`{ title: "${long(80)}", description: x }`)).toThrow(
      /'title' must be at most 60 characters \(got 79\)/,
    );
    expect(() => parse(`{ title: t, description: "${long(260)}" }`)).toThrow(
      /'description' must be at most 200 characters \(got 259\)/,
    );
  });

  it("rejects a multi-line title", () => {
    expect(() => parse(`title: |\n  one\n  two\ndescription: x`)).toThrow(
      /'title' is a single line/,
    );
  });

  it("measures prose length on whitespace-collapsed text", () => {
    const doc = parse(`
title: >-
  Alpha
  case
description: >-
  Drives   the alpha
  case.
`);
    expect(doc.title).toBe("Alpha case");
    expect(doc.description).toBe("Drives the alpha case.");
  });

  it("rejects unknown top-level keys", () => {
    expect(() => parse(`{ title: t, description: x, stepz: [] }`)).toThrow(
      /unknown key 'stepz' \(known: title, description/,
    );
  });

  it("rejects non-mapping documents and YAML parse errors", () => {
    expect(() => parse(`- just\n- a list`)).toThrow(/YAML mapping/);
    expect(() => parse(`description: "unterminated`)).toThrow(/YAML parse error/);
  });

  it("accepts a skip reason and rejects a non-string one", () => {
    expect(parse(`{ title: t, description: x, skip: "pending fixture" }`).skip).toBe(
      "pending fixture",
    );
    expect(() => parse(`{ title: t, description: x, skip: true }`)).toThrow(/reason string/);
  });
});

describe("parseCaseDocument flat steps", () => {
  it("interleaves actions and assertions as peers", () => {
    const doc = parse(`
title: script-like flow
description: a script-like flow
steps:
  - send: "refund ORD-1001 please"
  - parked: true
  - reachedState: refund-review
  - decide: { to: refund-closed, comment: ok }
  - succeeded: true
`);
    expect(doc.steps.map((s) => s.kind)).toEqual([
      "action",
      "assert",
      "assert",
      "action",
      "assert",
    ]);
  });

  it("rejects an assertion with no preceding action", () => {
    expect(() => parse(`{ title: t, description: x, steps: [{ succeeded: true }] }`)).toThrow(
      /assertion 'succeeded' has no preceding action/,
    );
  });

  it("rejects multi-key step entries", () => {
    expect(() =>
      parse(`
title: t
description: x
steps:
  - send: hi
    succeeded: true
`),
    ).toThrow(/exactly one key/);
  });

  // Legacy shapes (`expect:`, `parallel:`, `session:`) get no special-cased
  // rejection any more: the strict unknown-key error names them the same way.
  it("rejects legacy nesting and multi-session shapes as unknown keys", () => {
    expect(() =>
      parse(`
title: t
description: x
steps:
  - expect:
      - succeeded: true
`),
    ).toThrow(/unknown step 'expect'/);
    expect(() => parse(`{ title: t, description: x, steps: [{ parallel: [] }] }`)).toThrow(
      /unknown step 'parallel'/,
    );
    expect(() => parse(`{ title: t, description: x, sessions: { a: {} } }`)).toThrow(
      /unknown key 'sessions'/,
    );
  });

  it("rejects unknown step keys listing actions and assertions", () => {
    expect(() =>
      parse(`
title: t
description: x
steps:
  - send: hi
  - reachedstate: foo
`),
    ).toThrow(
      /unknown step 'reachedstate' \(actions: send, decide, deliver; assertions: succeeded/,
    );
  });

  it("rejects decide without a target and send without a message", () => {
    expect(() => parse(`{ title: t, description: x, steps: [{ decide: {} }] }`)).toThrow(/decide/);
    expect(() => parse(`{ title: t, description: x, steps: [{ send: 3 }] }`)).toThrow(
      /steps\[0\]\.send: takes a user message string/,
    );
  });
});

describe("parseCaseDocument assertion grammar", () => {
  it("rejects a boolean assertion with a non-true value", () => {
    expect(() =>
      parse(`{ title: t, description: x, steps: [{ send: hi }, { succeeded: false }] }`),
    ).toThrow(/'succeeded' takes the literal true/);
  });

  it("compiles /pattern/flags reply tokens, accepting scalar or list form", () => {
    const doc = parse(`
title: t
description: x
steps:
  - send: hi
  - reply:
      includes: "/approv/i"
  - reply:
      includes: ["plain", "/den/i"]
      excludes: "ORD-2001"
`);
    const single = doc.steps[1] as { expect: { includes: Array<{ regex?: RegExp }> } };
    expect(single.expect.includes).toHaveLength(1);
    expect(single.expect.includes[0]?.regex).toBeInstanceOf(RegExp);
    const multi = doc.steps[2] as {
      expect: { includes: Array<{ regex?: RegExp }>; excludes: Array<{ raw: string }> };
    };
    expect(multi.expect.includes).toHaveLength(2);
    expect(multi.expect.includes[0]?.regex).toBeUndefined();
    expect(multi.expect.excludes.map((t) => t.raw)).toEqual(["ORD-2001"]);
  });

  it("rejects malformed regex strings in reply tokens and tool inputs", () => {
    expect(() =>
      parse(`{ title: t, description: x, steps: [{ send: hi }, { reply: { includes: "/[/" } }] }`),
    ).toThrow(/malformed regex/);
    expect(() =>
      parse(
        `{ title: t, description: x, steps: [{ send: hi }, { calledTool: { name: t, input: { p: "/[/" } } }] }`,
      ),
    ).toThrow(/malformed regex/);
  });

  it("requires at least one of includes/excludes on reply", () => {
    expect(() =>
      parse(`{ title: t, description: x, steps: [{ send: hi }, { reply: {} }] }`),
    ).toThrow(/at least one of 'includes'\/'excludes'/);
  });

  it("rejects unknown keys inside assertion payloads (strict objects)", () => {
    expect(() =>
      parse(
        `{ title: t, description: x, steps: [{ send: hi }, { calledTool: { name: read_file, inputs: {} } }] }`,
      ),
    ).toThrow(/calledTool/);
  });

  it("requires trail to declare a matcher field alongside count", () => {
    expect(() =>
      parse(`{ title: t, description: x, steps: [{ send: hi }, { trail: { count: 2 } }] }`),
    ).toThrow(/at least one of 'to'\/'kind'\/'reason'/);
    const doc = parse(
      `{ title: t, description: x, steps: [{ send: hi }, { trail: { to: review, count: 2 } }] }`,
    );
    expect(doc.steps[1]).toEqual({
      kind: "assert",
      expect: { assert: "trail", to: "review", count: 2 },
    });
  });

  it("requires grade to carry closedQA and atLeast", () => {
    expect(() =>
      parse(`{ title: t, description: x, steps: [{ send: hi }, { grade: { closedQA: ok } }] }`),
    ).toThrow(/grade/);
    expect(() =>
      parse(
        `{ title: t, description: x, steps: [{ send: hi }, { grade: { closedQA: ok, atLeast: 2 } }] }`,
      ),
    ).toThrow(/grade/);
  });

  it("rejects 'judge' as an unknown step key", () => {
    expect(() =>
      parse(`{ title: t, description: x, steps: [{ send: hi }, { judge: { closedQA: ok, atLeast: 0.7 } }] }`),
    ).toThrow(/unknown step 'judge'/);
  });

  it("accepts regex strings inside mock whenInput and rejects malformed ones", () => {
    const doc = parse(
      `{ title: t, description: x, mocks: [{ tool: read_file, whenInput: { file_path: "/orders/" }, result: "[]" }] }`,
    );
    expect(doc.mocks[0]?.whenInput).toEqual({ file_path: "/orders/" });
    expect(() =>
      parse(
        `{ title: t, description: x, mocks: [{ tool: read_file, whenInput: { file_path: "/[/" }, result: "[]" }] }`,
      ),
    ).toThrow(/malformed regex/);
  });
});

describe("parseCaseDocument workspace and mocks", () => {
  it("classifies inline content and from-references", () => {
    const doc = parse(`
title: t
description: x
workspace:
  inline.json: { company: Acme }
  verbatim.txt: "hello"
  copied.json: { from: shared/fixture.json }
`);
    expect(doc.workspace["inline.json"]).toEqual({
      source: "inline",
      content: { company: "Acme" },
    });
    expect(doc.workspace["verbatim.txt"]).toEqual({ source: "inline", content: "hello" });
    expect(doc.workspace["copied.json"]).toEqual({ source: "file", from: "shared/fixture.json" });
  });

  it("rejects a malformed from reference", () => {
    expect(() => parse(`{ title: t, description: x, workspace: { a.json: { from: 3 } } }`)).toThrow(
      /'from' takes a tests\/-relative file path/,
    );
  });

  it("collects file references", () => {
    const doc = parse(`
title: t
description: x
workspace:
  a.json: { from: shared/a.json }
  b.json: { from: shared/b.json }
`);
    expect(collectFileReferences(doc).sort()).toEqual(["shared/a.json", "shared/b.json"]);
  });

  it("parses mocks with tool-mock semantics", () => {
    const doc = parse(`
title: t
description: x
mocks:
  - tool: read_file
    whenInput: { file_path: data/orders.json }
    result: "[]"
`);
    expect(doc.mocks).toEqual([
      { name: "read_file", whenInput: { file_path: "data/orders.json" }, result: "[]" },
    ]);
  });

  it("rejects unknown mock keys", () => {
    expect(() =>
      parse(`{ title: t, description: x, mocks: [{ name: read_file, result: "[]" }] }`),
    ).toThrow(CaseSchemaError);
  });
});

describe("path helpers", () => {
  it("classifies file names", () => {
    expect(isTestFile("a/b.test.yaml")).toBe(true);
    expect(isTestFile("a/b.test.yml")).toBe(true);
    expect(isTestFile("a/b.test.js")).toBe(false);
    expect(isTestFile("a/b.test.ts")).toBe(false);
  });

  it("derives ids", () => {
    expect(caseIdForFile(FILE, TESTS_DIR)).toBe("alpha");
    expect(caseIdForFile(`${TESTS_DIR}/nested/beta.test.yml`, TESTS_DIR)).toBe("nested/beta");
  });

  it("normalizes fixture paths and rejects escapes", () => {
    expect(normalizeFixturePath("shared//a.json", FILE)).toBe("shared/a.json");
    expect(() => normalizeFixturePath("../data/orders.json", FILE)).toThrow(/escapes/);
    expect(() => normalizeFixturePath("/abs/path.json", FILE)).toThrow(/tests\/-relative/);
  });
});

describe("run variables in cases", () => {
  it("parses a case-level variables seed", () => {
    const doc = parseCaseDocument(
      "a.test.yaml",
      `
title: t
description: d
variables:
  from_email: "a@b.com"
  order: { items: [{ sku: "A-1" }] }
steps:
  - send: hi
`,
      "tests",
    );
    expect(doc.variables).toEqual({
      from_email: "a@b.com",
      order: { items: [{ sku: "A-1" }] },
    });
  });

  it("rejects trigger args as an unknown key (input travels in variables)", () => {
    expect(() =>
      parseCaseDocument(
        "a.test.yaml",
        `
title: t
description: d
trigger:
  id: report_requested
  args: { company: Acme }
steps:
  - send: hi
`,
        "tests",
      ),
    ).toThrow(/trigger: unknown key 'args'/);
  });

  it("rejects an invalid variable name in a seed", () => {
    expect(() =>
      parseCaseDocument(
        "a.test.yaml",
        `
title: t
description: d
variables:
  From-Email: x
steps:
  - send: hi
`,
        "tests",
      ),
    ).toThrow(/valid variable name/);
  });

  it("parses a variables assertion with path and locked", () => {
    const doc = parseCaseDocument(
      "a.test.yaml",
      `
title: t
description: d
steps:
  - send: hi
  - variables:
      expect:
        company: "Acme"
      path:
        company: "name"
      locked:
        company: true
`,
      "tests",
    );
    const step = doc.steps[1];
    expect(step).toMatchObject({
      kind: "assert",
      expect: {
        assert: "variables",
        expect: { company: "Acme" },
        path: { company: "name" },
        locked: { company: true },
      },
    });
  });

  it("rejects an unknown key inside the variables assertion", () => {
    expect(() =>
      parseCaseDocument(
        "a.test.yaml",
        `
title: t
description: d
steps:
  - send: hi
  - variables:
      expect: { a: 1 }
      nope: true
`,
        "tests",
      ),
    ).toThrow();
  });
});

describe("deliver steps and pinned parks", () => {
  it("pins the state a park stopped in", () => {
    const parsed = doc(`  - send: "hi"\n  - parked: { channel: input, state: clarify }\n`);
    expect(parsed.steps[1]).toMatchObject({
      kind: "assert",
      expect: { assert: "parked", channel: "input", state: "clarify" },
    });
  });

  it("accepts a state without a channel", () => {
    const parsed = doc(`  - send: "hi"\n  - parked: { state: clarify }\n`);
    expect(parsed.steps[1]).toMatchObject({ expect: { assert: "parked", state: "clarify" } });
  });

  it("rejects an unknown key in the mapping form", () => {
    expect(() => doc(`  - send: "hi"\n  - parked: { node: clarify }\n`)).toThrow(/node/);
  });

  const doc = (steps: string) =>
    parseCaseDocument(
      "workflows/w/tests/a.test.yaml",
      `title: T\ndescription: D\nsteps:\n${steps}`,
      "workflows/w/tests",
    );

  it("parses a delivery's trigger and variables", () => {
    const parsed = doc(
      `  - send: "hi"\n  - deliver:\n      trigger: email_reply\n      variables: { reply_body: "yes" }\n`,
    );
    expect(parsed.steps[1]).toEqual({
      kind: "action",
      action: { action: "deliver", trigger: "email_reply", variables: { reply_body: "yes" } },
    });
  });

  it("requires the trigger and rejects unknown keys", () => {
    expect(() => doc(`  - send: "hi"\n  - deliver: { variables: {} }\n`)).toThrow(/trigger/);
    expect(() => doc(`  - send: "hi"\n  - deliver: { trigger: t, args: {} }\n`)).toThrow(/args/);
  });

  it("rejects a delivered variable name the run could not address", () => {
    expect(() =>
      doc(`  - send: "hi"\n  - deliver: { trigger: t, variables: { "Reply Body": 1 } }\n`),
    ).toThrow();
  });

  it("accepts a delivery as the action an assertion binds to", () => {
    const parsed = doc(`  - deliver: { trigger: t }\n  - reachedState: answer\n`);
    expect(parsed.steps[1]).toEqual({
      kind: "assert",
      expect: { assert: "reachedState", state: "answer" },
    });
  });

  it("pins the park channel when one is named", () => {
    expect(doc(`  - send: "hi"\n  - parked: input\n`).steps[1]).toEqual({
      kind: "assert",
      expect: { assert: "parked", channel: "input" },
    });
    expect(doc(`  - send: "hi"\n  - parked: true\n`).steps[1]).toEqual({
      kind: "assert",
      expect: { assert: "parked" },
    });
    expect(() => doc(`  - send: "hi"\n  - parked: waiting\n`)).toThrow(/decision.*input/);
  });
});

describe("ranWorkflow assertions", () => {
  const doc = (steps: string) =>
    parseCaseDocument(
      "workflows/w/tests/a.test.yaml",
      `title: T\ndescription: D\nsteps:\n${steps}`,
      "workflows/w/tests",
    );

  it("defaults to asserting a successful dispatch", () => {
    expect(doc(`  - send: "hi"\n  - ranWorkflow: { workflow: enrich-account }\n`).steps[1]).toEqual(
      {
        kind: "assert",
        expect: { assert: "ranWorkflow", workflow: "enrich-account", status: "ok" },
      },
    );
  });

  it("accepts an explicit error status and a count", () => {
    const parsed = doc(
      `  - send: "hi"\n  - ranWorkflow: { workflow: enrich-account, status: error, count: 2 }\n`,
    );
    expect(parsed.steps[1]).toEqual({
      kind: "assert",
      expect: { assert: "ranWorkflow", workflow: "enrich-account", status: "error", count: 2 },
    });
  });

  it("requires a workflow slug", () => {
    expect(() => doc(`  - send: "hi"\n  - ranWorkflow: { prompt: "x" }\n`)).toThrow();
  });

  it("fails closed on an unknown key", () => {
    expect(() =>
      doc(`  - send: "hi"\n  - ranWorkflow: { workflowName: enrich-account }\n`),
    ).toThrow(/workflowName/);
  });
});

describe("serializeCaseDocument", () => {
  const RICH = `
title: Everything at once
description: Exercises every step the grammar knows, so the inverse is checked over all of them.
skip: not yet
trigger: { id: email_received }
variables: { order_id: ORD-1, count: 2 }
workspace:
  trigger.json: { from: fixtures/trigger.json }
  scratchpad/notes.md: "# notes"
  scratchpad/data.json: { a: [1, 2] }
mocks:
  - tool: lookup_order
    whenInput: { order_id: /ORD-\\d+/ }
    result: { status: shipped }
  - tool: archmax_workflow_enrich
    result: { message: done }
steps:
  - send: "where is my order?"
  - succeeded: true
  - usedNoTools: true
  - noTraversal: true
  - parked: true
  - parked: decision
  - parked: { channel: input, state: clarify }
  - parked: { state: review }
  - reachedState: answer
  - triggerArrival: email_received
  - reply: { includes: ["shipped", /ORD-\\d+/i], excludes: "refund" }
  - reply: { excludes: ["a", "b"] }
  - calledTool: { name: lookup_order, input: { order_id: ORD-1 } }
  - notCalledTool: { name: refund }
  - blockedTool: { name: rm, input: { path: /.*/ } }
  - ranWorkflow: { workflow: enrich }
  - ranWorkflow: { workflow: enrich, status: error, count: 2 }
  - trail: { to: answer, count: 1 }
  - trail: { kind: human, reason: approved, count: 0 }
  - variables:
      expect: { order_id: ORD-1 }
      path: { order_id: id }
      locked: { order_id: true }
  - decide: { to: approved, comment: fine }
  - decide: { to: rejected }
  - deliver: { trigger: email_reply, variables: { reply_body: hi } }
  - deliver: { trigger: timer }
  - grade: { closedQA: Did it answer?, atLeast: 0.7 }
`;

  it("round-trips every step, seed and mock the grammar accepts", async () => {
    const { serializeCaseDocument } = await import("./case-schema.js");
    const doc = parse(RICH);
    const yaml = serializeCaseDocument(doc);
    expect(parseCaseDocument(FILE, yaml, TESTS_DIR)).toEqual(doc);
  });

  it("writes the grammar's key order", async () => {
    const { serializeCaseDocument } = await import("./case-schema.js");
    const doc = parse(`
title: alpha
description: alpha case
steps:
  - send: hi
  - grade: { closedQA: ok?, atLeast: 0.5 }
`);
    const yaml = serializeCaseDocument(doc);
    expect(yaml.indexOf("title:")).toBeLessThan(yaml.indexOf("description:"));
    expect(yaml.indexOf("description:")).toBeLessThan(yaml.indexOf("steps:"));
    expect(yaml).toContain("grade:");
    expect(yaml).not.toMatch(/^(file|id|workspace|mocks):/m);
  });

  it("keeps a long message on one line", async () => {
    const { serializeCaseDocument } = await import("./case-schema.js");
    const long = "word ".repeat(40).trim();
    const doc = parse(`title: t\ndescription: d\nsteps:\n  - send: "${long}"\n`);
    expect(serializeCaseDocument(doc)).toContain(`send: ${long}\n`);
  });
});

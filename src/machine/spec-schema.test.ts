import { describe, expect, it } from "vitest";
import { parseMachineSpec } from "./spec-schema.js";

/**
 * Strict keys are the capability this schema adds. `workflow.yaml` previously had
 * none: a misspelled `transtions:` silently produced a terminal state, and a
 * removed field ran ignored, doing nothing of what its author intended, with no
 * diagnostic naming it.
 */
const MINIMAL = {
  states: { start: { triggers: { manual: null }, transitions: [{ to: "done", description: "Test edge to done." }] }, done: null },
};

function issuesFor(spec: unknown): { path: string; message: string }[] {
  const result = parseMachineSpec(spec);
  return result.ok ? [] : result.issues;
}

describe("strict keys", () => {
  it("accepts a minimal spec, with a bare terminal state", () => {
    const result = parseMachineSpec(MINIMAL);
    expect(result.ok).toBe(true);
    // A bare `done:` is YAML null; it reads as an empty state, not a rejection.
    if (result.ok) expect(result.spec.states?.done).toEqual({});
  });

  it("rejects a misspelled key, naming the key and the state it is on", () => {
    const issues = issuesFor({
      states: { start: { triggers: { manual: null }, transtions: [{ to: "done" }] }, done: null },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("states.start");
    expect(issues[0]?.message).toContain('Unrecognized key: "transtions"');
  });

  it("rejects settings.sub_workflows, now the dispatcher's configuration", () => {
    const issues = issuesFor({ ...MINIMAL, settings: { sub_workflows: { max_depth: 2 } } });
    expect(issues[0]?.path).toBe("settings");
    expect(issues[0]?.message).toContain('Unrecognized key: "sub_workflows"');
  });

  it("rejects a transition's unknown key, naming its index", () => {
    const issues = issuesFor({
      states: { start: { triggers: { manual: null }, transitions: [{ to: "done", on: "x", description: "Test edge to done." }] }, done: null },
    });
    expect(issues[0]?.path).toBe("states.start.transitions.0");
    expect(issues[0]?.message).toContain('Unrecognized key: "on"');
  });

  it("rejects an unknown key at the spec root", () => {
    const issues = issuesFor({ ...MINIMAL, entry: "start" });
    expect(issues[0]?.path).toBe("");
    expect(issues[0]?.message).toContain('Unrecognized key: "entry"');
  });

  /**
   * The agent is disclosed the active state's edges and nothing else of the graph,
   * so a blank description hands it a bare slug and asks it to route. One message
   * covers every way of not writing one; the path names the edge.
   */
  describe("a transition's description", () => {
    const withDescription = (value: unknown) =>
      issuesFor({
        states: {
          start: {
            triggers: { manual: null },
            transitions: [
              { to: "done", description: "The question is answered." },
              value === undefined ? { to: "start" } : { to: "start", description: value },
            ],
          },
          done: null,
        },
      });

    it.each([
      ["absent", undefined],
      ["empty", ""],
      ["whitespace only", " \n "],
      ["not a string", 42],
    ])("is rejected when %s, naming the edge", (_label, value) => {
      const issues = withDescription(value);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.path).toBe("states.start.transitions.1.description");
      expect(issues[0]?.message).toContain("only thing the agent is told about this edge");
      // The message says what to write, not just that something is missing.
      expect(issues[0]?.message).toContain("Say when to take it");
    });

    it("accepts a described edge", () => {
      expect(withDescription("Loop back for another pass.")).toEqual([]);
    });
  });

  it("rejects the retired policy block: denial is declared beside the grant", () => {
    const issues = issuesFor({ ...MINIMAL, policy: { forbid_tools: ["archmax_eval"] } });
    expect(issues[0]?.path).toBe("");
    expect(issues[0]?.message).toContain('Unrecognized key: "policy"');
  });

  it("rejects the retired root skills ceiling", () => {
    const issues = issuesFor({ ...MINIMAL, skills: { allow: ["order-data"] } });
    expect(issues[0]?.path).toBe("skills");
    expect(issues[0]?.message).toContain('Unrecognized key: "allow"');
  });

  it("rejects a root governance key on a state, and a state key at the root", () => {
    const onState = issuesFor({
      states: { start: { triggers: { manual: null }, tools: { allow_always: ["read_file"] } } },
    });
    expect(onState[0]?.path).toBe("states.start.tools");
    expect(onState[0]?.message).toContain('Unrecognized key: "allow_always"');

    const atRoot = issuesFor({ ...MINIMAL, skills: { forbid: ["order-data"] } });
    expect(atRoot[0]?.path).toBe("skills");
    expect(atRoot[0]?.message).toContain('Unrecognized key: "forbid"');
  });

  it("accepts the four governance keys in their own positions", () => {
    expect(
      issuesFor({
        tools: { allow_always: ["read_file"], forbid_always: [{ tool: "*", paths: ["logs/**"] }] },
        skills: { allow_always: ["order-data"], forbid_always: ["refund-policy"] },
        mounts: { allow_always: ["reference"], forbid_always: ["catalogs/uk"] },
        states: {
          start: {
            triggers: { manual: null },
            tools: { allow: ["write_file"], forbid: [{ tool: "read_file", paths: ["secrets/**"] }] },
            skills: { allow: ["order-enrichment"], forbid: ["order-data"] },
            mounts: { allow: ["catalogs/eu"], forbid: ["reference"] },
          },
        },
      }),
    ).toEqual([]);
  });

  it("rejects the mounts ceiling spelling: there is one mounts model", () => {
    const issues = issuesFor({ ...MINIMAL, mounts: { allow: ["reference"] } });
    expect(issues[0]?.path).toBe("mounts");
    expect(issues[0]?.message).toContain('Unrecognized key: "allow"');
  });

  it("rejects a root mounts key on a state", () => {
    const issues = issuesFor({
      states: { start: { triggers: { manual: null }, mounts: { allow_always: ["reference"] } } },
    });
    expect(issues[0]?.path).toBe("states.start.mounts");
    expect(issues[0]?.message).toContain('Unrecognized key: "allow_always"');
  });
});

/**
 * The one slot for host data the SDK never reads. It exists so a host can keep an
 * authoring UI's canvas state — and, on a state, a node's own position, which
 * shares the node's identity instead of sitting in a slug-keyed side table. The
 * tests below pin both halves of the contract: the block is accepted at each of
 * its three positions and preserved, and nothing else about the root loosened to
 * make room for it.
 */
describe("host metadata", () => {
  const CANVAS = { zoom: 1.2, pan: { x: 0, y: 40 } };

  it("accepts a root metadata block and preserves it key for key", () => {
    const result = parseMachineSpec({ ...MINIMAL, metadata: CANVAS });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.metadata).toEqual(CANVAS);
  });

  it("accepts a metadata block on a state and preserves it", () => {
    const result = parseMachineSpec({
      states: { start: { triggers: { manual: null }, metadata: { x: 120, y: 340 } } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.states.start?.metadata).toEqual({ x: 120, y: 340 });
  });

  it("accepts a metadata block on an inline rubric and preserves it", () => {
    const result = parseMachineSpec({
      states: {
        start: {
          triggers: { manual: null },
          after: { rubric: { instructions: "judge the tone", metadata: { label: "Tone check" } } },
        },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const hook = result.spec.states.start?.after as { rubric: { metadata?: unknown } };
      expect(hook.rubric.metadata).toEqual({ label: "Tone check" });
    }
  });

  // Loose, not unchecked: the contents are the host's business, but the slot is
  // still a mapping, so a scalar there is an authoring mistake worth naming.
  it("rejects a metadata block that is not a mapping", () => {
    const issues = issuesFor({ ...MINIMAL, metadata: "left" });
    expect(issues[0]?.path).toBe("metadata");
  });

  // The slot is one named key at each position, not an opening.
  it.each([
    ["another root key", { ...MINIMAL, layout: {} }, "", "layout"],
    ["a nested extensions key", { ...MINIMAL, extensions: { metadata: {} } }, "extensions", "metadata"],
    [
      "another state key",
      { states: { start: { triggers: { manual: null }, position: {} } } },
      "states.start",
      "position",
    ],
  ])("still rejects %s", (_label, spec, path, key) => {
    const issues = issuesFor(spec);
    expect(issues[0]?.path).toBe(path);
    expect(issues[0]?.message).toContain(`Unrecognized key: "${key}"`);
  });

  // The retired spelling gets no special treatment: the schema keeps no memory
  // of a name it used to have, so `editor` reads as the typo it now is.
  it("reports the retired editor key as an ordinary unrecognized key", () => {
    const issues = issuesFor({ ...MINIMAL, editor: { nodes: {} } });
    expect(issues[0]?.path).toBe("");
    expect(issues[0]?.message).toContain(`Unrecognized key: "editor"`);
    expect(issues[0]?.message).not.toContain("metadata");
  });
});

/**
 * An allow entry's `source` names where the tool came from, for the host that
 * authored it. The SDK never reads it, so it constrains the value no further
 * than "a string".
 */
describe("allow-entry source", () => {
  const withSource = (source: unknown) => ({
    states: { start: { triggers: { manual: null }, tools: { allow: [{ tool: "search", source }] } } },
  });

  it.each(["ap", "platform", "activepieces", "mcp"])("accepts %s", (source) => {
    const result = parseMachineSpec(withSource(source));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const entry = result.spec.states?.start?.tools?.allow?.[0];
      expect(typeof entry === "object" && entry?.source).toBe(source);
    }
  });

  it("still rejects a non-string source", () => {
    const issues = issuesFor(withSource(3));
    expect(issues.length).toBeGreaterThan(0);
  });
});

/**
 * Hook provenance is a property of the *shape*: a script path is confined to the
 * workflow's own `hooks/` directory, so no caller can skip the check.
 */
describe("hook provenance", () => {
  it("accepts a script inside hooks/", () => {
    expect(
      parseMachineSpec({
        states: { start: { triggers: { manual: null }, before: { script: "hooks/check.js" } } },
      }).ok,
    ).toBe(true);
  });

  it.each([
    ["skills/order-data/scripts/run.js", "a skill bundle"],
    ["scripts/check.js", "the old location"],
    ["/abs/hooks/check.js", "an absolute path"],
    ["hooks/../escape.js", "a climb out of hooks/"],
  ])("refuses %s (%s)", (path) => {
    const issues = issuesFor({
      states: { start: { triggers: { manual: null }, before: { script: path } } },
    });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.path).toBe("states.start.before");
  });

  // The custom-kind escape hatch must not swallow a malformed built-in: without
  // the fence, `{ script: <bad path> }` would fail the strict branch and then
  // match as an unknown kind called "script", making the rule unenforceable.
  it("does not let the custom-kind branch rescue a bad script path", () => {
    const issues = issuesFor({
      states: { start: { triggers: { manual: null }, after: { script: "anywhere.js" } } },
    });
    expect(issues.length).toBeGreaterThan(0);
  });

  // A hook's kind is its single key other than the reserved sidecars, so an
  // object carrying none names no kind at all. Caught at load rather than left to
  // the runner's fail-closed veto: the author learns when they wrote it, not on
  // the transition it silently blocks.
  it.each([
    ["an empty object", {}],
    ["sidecars only", { max_corrections: 2 }],
    ["a non-string target", { webhook: 42 }],
  ])("refuses a hook that names no usable kind: %s", (_label, after) => {
    const issues = issuesFor({ states: { start: { triggers: { manual: null }, after } } });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.path).toBe("states.start.after");
  });

  it("still accepts a custom hook kind for an executor registered at assembly", () => {
    expect(
      parseMachineSpec({
        states: { start: { triggers: { manual: null }, after: { webhook: "https://example.test/h" } } },
      }).ok,
    ).toBe(true);
  });
});

/**
 * A `skills.allow` entry is a slug or the spec does not load: one mis-authored
 * line used to be dropped silently, which switched a grant off without a word.
 */
describe("skill slugs", () => {
  it("rejects a non-slug skills entry, naming its index", () => {
    const issues = issuesFor({
      ...MINIMAL,
      skills: { allow_always: ["order-data", 7, "skills/order-data/**"] },
    });
    expect(issues.map((issue) => issue.path)).toEqual([
      "skills.allow_always.1",
      "skills.allow_always.2",
    ]);
    expect(issues[0]?.message).toContain("is not a skill slug: 7");
    expect(issues[1]?.message).toContain("'skills/order-data/**' is not a skill slug");
  });

  it("rejects a scalar where a list belongs", () => {
    const issues = issuesFor({ ...MINIMAL, skills: { allow_always: "order-data" } });
    expect(issues).toEqual([
      { path: "skills.allow_always", message: "must be a list of skill slugs" },
    ]);
  });

  /**
   * A mounts entry names a mount, not a path pattern: a glob would read as a
   * grant over part of a mount, which is what `tools.allow` is for.
   */
  it("rejects a glob-shaped mounts entry, naming its index", () => {
    const issues = issuesFor({
      ...MINIMAL,
      states: { start: { triggers: { manual: null }, mounts: { allow: ["reference/**"] } } },
    });
    expect(issues.map((issue) => issue.path)).toEqual(["states.start.mounts.allow.0"]);
    expect(issues[0]?.message).toContain("'reference/**' is not a mount name");
  });

  it("rejects a leading slash, a trailing slash, a '..' segment and a non-string", () => {
    const issues = issuesFor({
      ...MINIMAL,
      mounts: { allow_always: ["/reference", "reference/", "a/../b", 7] },
    });
    expect(issues.map((issue) => issue.path)).toEqual([
      "mounts.allow_always.0",
      "mounts.allow_always.1",
      "mounts.allow_always.2",
      "mounts.allow_always.3",
    ]);
    expect(issues[3]?.message).toContain("must be a mount name");
    expect(issues[3]?.message).toContain("got 7");
  });

  it("accepts a nested mount name and a file mount name", () => {
    expect(issuesFor({ ...MINIMAL, mounts: { allow_always: ["catalogs/eu", "AGENTS.md"] } })).toEqual(
      [],
    );
  });

  it("rejects a scalar where a mounts list belongs", () => {
    const issues = issuesFor({ ...MINIMAL, mounts: { allow_always: "reference" } });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("mounts.allow_always");
    expect(issues[0]?.message).toContain("must be a list of mount names");
  });

  /**
   * The second half of a mount grant: which states see it, and what they may do
   * there. The bare name keeps meaning "the posture the host declared".
   */
  it("accepts a grant entry naming its access, in either position", () => {
    expect(
      issuesFor({
        mounts: { allow_always: [{ mount: "shared", access: "read_write" }, "reference"] },
        states: {
          start: {
            triggers: { manual: null },
            mounts: { allow: [{ mount: "shared", access: "read" }, { mount: "catalogs/eu" }] },
          },
        },
      }),
    ).toEqual([]);
  });

  it("rejects an unknown access, naming the two it accepts", () => {
    const issues = issuesFor({
      ...MINIMAL,
      mounts: { allow_always: [{ mount: "shared", access: "write" }] },
    });
    expect(issues[0]?.path).toBe("mounts.allow_always.0");
    expect(issues[0]?.message).toContain("read | read_write");
  });

  it("rejects an unknown key on a grant entry", () => {
    const issues = issuesFor({
      ...MINIMAL,
      mounts: { allow_always: [{ mount: "shared", write: true }] },
    });
    expect(issues[0]?.path).toBe("mounts.allow_always.0");
  });

  it("takes a name only in a forbid list: a denial has no access to qualify", () => {
    const issues = issuesFor({
      ...MINIMAL,
      mounts: { forbid_always: [{ mount: "shared", access: "read" }] },
    });
    expect(issues[0]?.path).toBe("mounts.forbid_always.0");
    expect(issues[0]?.message).toContain("is not a mount name");
  });

  it("leaves an unknown trigger-declaration key to the lint", () => {
    const result = parseMachineSpec({
      states: { start: { triggers: { chat: { somethingHostSpecific: true } } } },
    });
    expect(result.ok).toBe(true);
  });
});

/**
 * The rules that need the whole document, reported by the key an author has to
 * find.
 */
describe("document-level rules", () => {
  it("names the transition and the state a dangling target sits on", () => {
    const issues = issuesFor({
      states: { start: { triggers: { manual: null }, transitions: [{ to: "ghost", description: "Test edge to ghost." }] } },
    });
    expect(issues).toEqual([
      {
        path: "states.start.transitions.0.to",
        message: "State 'start' transitions to undefined state 'ghost'",
      },
    ]);
  });

  it("requires exactly one manual start state", () => {
    expect(issuesFor({ states: { a: {} } })[0]?.message).toContain("no start state");
    const two = issuesFor({ states: { a: { triggers: { manual: null } }, b: { triggers: { manual: null } } } });
    expect(two[0]?.path).toBe("states");
    expect(two[0]?.message).toContain("Multiple states declare trigger 'manual' (a, b)");
  });

  it("refuses an iteration budget sidecar on a before hook, where nothing retries", () => {
    const issues = issuesFor({
      states: { start: { triggers: { manual: null }, before: { script: "hooks/x.js", max_iterations: 2 } } },
    });
    expect(issues[0]?.path).toBe("states.start.before");
    expect(issues[0]?.message).toContain("before hooks are ok/veto only");
  });

  it("accepts an inline rubric on a hook, and a list of several", () => {
    const single = parseMachineSpec({
      states: { start: { triggers: { manual: null }, after: { rubric: { instructions: "tone" } } } },
    });
    expect(single.ok).toBe(true);

    const list = parseMachineSpec({
      states: {
        start: {
          triggers: { manual: null },
          after: [
            { rubric: { instructions: "tone", max_iterations: 2 } },
            { rubric: { instructions: "completeness" } },
            { script: "hooks/check.js", max_iterations: 1 },
          ],
        },
      },
    });
    expect(list.ok).toBe(true);
  });

  it("rejects a rubric named rather than declared, and a sidecar beside one", () => {
    // There is no rubric to point at: the declaration is the hook's value, so a
    // bare string is not a rubric and the budget lives inside the declaration.
    for (const after of [{ rubric: "tone" }, { rubric: { instructions: "tone" }, max_iterations: 2 }]) {
      const issues = issuesFor({ states: { start: { triggers: { manual: null }, after } } });
      expect(issues[0]?.path).toBe("states.start.after");
    }
  });

  it("requires instructions on an inline rubric", () => {
    const issues = issuesFor({
      states: { start: { triggers: { manual: null }, after: { rubric: { max_iterations: 2 } } } },
    });
    expect(issues[0]?.path).toBe("states.start.after");
  });

  it("rejects the retired sidecar as an ordinary schema error", () => {
    // No mapping to a replacement: the schema carries no memory of a spelling it
    // used to accept, so `max_corrections` reads as the malformed hook it makes.
    const issues = issuesFor({
      states: { start: { triggers: { manual: null }, before: { script: "hooks/x.js", max_corrections: 2 } } },
    });
    expect(issues[0]?.path).toBe("states.start.before");
    // Named as the unrecognized key it is, like any other; never mapped to the
    // sidecar that replaced it.
    expect(issues[0]?.message).toContain(`Unrecognized key: "max_corrections"`);
    expect(issues[0]?.message).not.toContain("max_iterations");
  });

  it("rejects a root rubrics block, now that a rubric is not a first-order item", () => {
    const issues = issuesFor({ ...MINIMAL, rubrics: { tone: { instructions: "tone" } } });
    expect(issues[0]?.path).toBe("");
    expect(issues[0]?.message).toContain(`Unrecognized key: "rubrics"`);
  });

  it("reads the retired hook kind as an unregistered custom kind", () => {
    // `{ subagent: … }` is not special-cased: it is shaped like any custom kind,
    // so the schema accepts it and the kind is refused where a kind is resolved —
    // `validate` offline (no `extensions.hooks` entry) and the runtime at
    // dispatch (no executor), which vetoes naming the kind.
    const result = parseMachineSpec({
      states: { start: { triggers: { manual: null }, before: { subagent: "judge" } } },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a model id at the root and on a state", () => {
    const result = parseMachineSpec({
      settings: { model: "small-model" },
      states: { start: { triggers: { manual: null }, model: "large-model" } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.settings?.model).toBe("small-model");
      expect(result.spec.states?.start?.model).toBe("large-model");
    }
  });

  it("rejects an empty model id at either position", () => {
    expect(issuesFor({ ...MINIMAL, settings: { model: "  " } })[0]?.path).toBe("settings.model");
    const stateIssues = issuesFor({
      states: { start: { triggers: { manual: null }, model: "" } },
    });
    expect(stateIssues[0]?.path).toBe("states.start.model");
    expect(stateIssues[0]?.message).toContain("non-empty");
  });

  it("rejects a model block, naming what belongs to the assembly instead", () => {
    const issues = issuesFor({
      states: { start: { triggers: { manual: null }, model: { id: "small-model", temperature: 0.2 } } },
    });
    expect(issues[0]?.path).toBe("states.start.model");
    expect(issues[0]?.message).toContain("must be a model id string");
    expect(issues[0]?.message).toContain("temperature");
  });

  it("rejects a non-string model id", () => {
    const issues = issuesFor({ ...MINIMAL, settings: { model: 3 } });
    expect(issues[0]?.path).toBe("settings.model");
    expect(issues[0]?.message).toContain("must be a model id string");
  });

  it("reports a malformed guard reference by its entry", () => {
    const issues = issuesFor({
      states: {
        start: { triggers: { manual: null }, tools: { allow: [{ tool: "send", args: { to: ["${{}}"] } }] } },
      },
    });
    expect(issues[0]?.path).toBe("states.start.tools.allow.0");
    expect(issues[0]?.message).toContain("not a valid variable reference");
  });
});

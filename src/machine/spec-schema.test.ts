import { describe, expect, it } from "vitest";
import { machineStateSchema, parseMachineSpec } from "./spec-schema.js";

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
    /** `start` → `lookup` with `value` as the edge's description and `lookup` carrying `instructions`. */
    const withDescription = (value: unknown, instructions?: string) =>
      issuesFor({
        states: {
          start: {
            triggers: { manual: null },
            transitions: [
              { to: "done", description: "The question is answered." },
              value === undefined ? { to: "lookup" } : { to: "lookup", description: value },
            ],
          },
          lookup: instructions === undefined ? null : { instructions },
          done: null,
        },
      });
    const UNDESCRIBED = [
      ["absent", undefined],
      ["empty", ""],
      ["whitespace only", " \n "],
    ] as const;

    it.each(UNDESCRIBED)("is accepted when %s and the target has instructions", (_label, value) => {
      expect(withDescription(value, "Look the order up by its id.")).toEqual([]);
    });

    it.each(UNDESCRIBED)("is rejected when %s and the target has none, naming the edge", (_label, value) => {
      for (const instructions of [undefined, "  \n "]) {
        const issues = withDescription(value, instructions);
        expect(issues).toHaveLength(1);
        expect(issues[0]?.path).toBe("states.start.transitions.1.description");
        expect(issues[0]?.message).toContain("'lookup' declares none");
        // The message says what to write, not just that something is missing.
        expect(issues[0]?.message).toContain("Say when to take this edge");
      }
    });

    it("is rejected when not a string, whatever the target", () => {
      const issues = withDescription(42, "Look the order up by its id.");
      expect(issues).toHaveLength(1);
      expect(issues[0]?.path).toBe("states.start.transitions.1.description");
      expect(issues[0]?.message).toContain("must be a string");
    });

    it("is required on a human state's transition, even to an instructed target", () => {
      const issues = issuesFor({
        states: {
          start: { triggers: { manual: null }, transitions: [{ to: "review", description: "Ready for review." }] },
          review: { type: "human", instructions: "Approve or send back.", transitions: [{ to: "lookup" }] },
          lookup: { instructions: "Look the order up by its id." },
        },
      });
      expect(issues).toHaveLength(1);
      expect(issues[0]?.path).toBe("states.review.transitions.0.description");
      expect(issues[0]?.message).toContain("button");
    });

    it("accepts a described edge", () => {
      expect(withDescription("Look it up.")).toEqual([]);
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
 * its two positions and preserved, and nothing else about the root loosened to
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

  // Loose, not unchecked: the contents are the host's business, but the slot is
  // still a mapping, so a scalar there is an authoring mistake worth naming.
  it("rejects a metadata block that is not a mapping", () => {
    const issues = issuesFor({ ...MINIMAL, metadata: "left" });
    expect(issues[0]?.path).toBe("metadata");
  });

  // The slot is one named key at each position, not an opening.
  it.each([
    ["another root key", { ...MINIMAL, layout: {} }, "", "layout"],
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
 * Every step of a workflow is a state, so the `before`/`after` hook slots and the
 * root `extensions` block that registered custom hook kinds are gone. The schema
 * keeps no memory of them: a leftover reads as the unrecognized key it now is,
 * naming the path — the same error any typo gets, not a special-cased message.
 */
describe("retired hook slots", () => {
  it.each([
    ["before", { script: "hooks/check.js" }],
    ["after", { rubric: { instructions: "judge the tone" } }],
    ["after", { webhook: "https://example.test/h" }],
  ])("rejects a leftover '%s:' on a state, naming the state", (key, hook) => {
    const issues = issuesFor({
      states: {
        start: { triggers: { manual: null }, [key]: hook, transitions: [{ to: "done", description: "Test edge to done." }] },
        done: null,
      },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("states.start");
    expect(issues[0]?.message).toContain(`Unrecognized key: "${key}"`);
  });

  it("rejects a leftover hook slot on a human state too", () => {
    const issues = issuesFor({
      states: {
        start: { triggers: { manual: null }, transitions: [{ to: "review", description: "Hand off." }] },
        review: {
          type: "human",
          instructions: "Approve it.",
          after: { rubric: { instructions: "review it" } },
          transitions: [{ to: "done", description: "Approve." }],
        },
        done: null,
      },
    });
    expect(issues[0]?.path).toBe("states.review");
    expect(issues[0]?.message).toContain(`Unrecognized key: "after"`);
  });

  it("rejects the root extensions block", () => {
    const issues = issuesFor({ ...MINIMAL, extensions: { hooks: ["webhook"] } });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("");
    expect(issues[0]?.message).toContain(`Unrecognized key: "extensions"`);
  });

  it("rejects a root rubrics block: grading is a grader state", () => {
    const issues = issuesFor({ ...MINIMAL, rubrics: { tone: { instructions: "tone" } } });
    expect(issues[0]?.path).toBe("");
    expect(issues[0]?.message).toContain(`Unrecognized key: "rubrics"`);
  });
});

/** The four state types, and nothing else under `type`. */
describe("state types", () => {
  it.each(["agent", "human", "grader", "code"])("accepts type '%s'", (type) => {
    const result = machineStateSchema.safeParse({
      type,
      ...(type === "code" ? { script: "scripts/check.js" } : {}),
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown type, naming the four it accepts", () => {
    const issues = issuesFor({
      states: { start: { triggers: { manual: null }, type: "judge" } },
    });
    expect(issues[0]?.path).toBe("states.start.type");
    expect(issues[0]?.message).toBe(
      "unknown state type 'judge' (expected 'agent', 'human', 'grader' or 'code')",
    );
  });
});

/**
 * A code state *is* its script, so where the script lives is a property of the
 * *shape*: confined to the workflow's own `scripts/` directory, segment by
 * segment, so no caller can skip the check. Which state may carry the key is a
 * document-level rule, because it depends on the state's `type`.
 */
describe("code-state scripts", () => {
  const codeState = (script: unknown) => ({
    states: {
      start: {
        triggers: { manual: null },
        type: "code",
        script,
        transitions: [{ to: "done", description: "The request is in order." }],
      },
      done: null,
    },
  });

  it.each(["scripts/a.js", "scripts/x/b.mjs"])("accepts %s", (path) => {
    const result = parseMachineSpec(codeState(path));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.states.start?.script).toBe(path);
  });

  it.each([
    ["hooks/a.js", "the retired hooks directory"],
    ["scripts/../a.js", "a climb out of scripts/"],
    ["scripts/x/../../a.js", "a deeper climb out of scripts/"],
    ["/scripts/a.js", "an absolute path"],
    ["scripts/a.ts", "a TypeScript source"],
    ["skills/order-data/scripts/run.js", "a skill bundle's script"],
  ])("refuses %s (%s), at the key", (path) => {
    const issues = issuesFor(codeState(path));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("states.start.script");
    expect(issues[0]?.message).toContain("inside 'scripts/' ending in .js or .mjs");
    expect(issues[0]?.message).toContain("no '..'");
  });

  it("refuses a script that is not a string", () => {
    const issues = issuesFor(codeState({ file: "scripts/a.js" }));
    expect(issues[0]?.path).toBe("states.start.script");
    expect(issues[0]?.message).toContain("must be a workflow-relative path string");
  });

  it("requires a script on a code state", () => {
    const issues = issuesFor({
      states: {
        start: { triggers: { manual: null }, type: "code", transitions: [{ to: "done", description: "Done." }] },
        done: null,
      },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("states.start.script");
    expect(issues[0]?.message).toContain("Code state 'start' declares no 'script'");
    expect(issues[0]?.message).toContain("scripts/start.js");
  });

  it.each([
    ["an untyped (agent)", undefined, "agent"],
    ["an agent", "agent", "agent"],
    ["a human", "human", "human"],
    ["a grader", "grader", "grader"],
  ])("refuses a script on %s state, naming its type", (_label, type, named) => {
    const issues = issuesFor({
      states: {
        start: {
          triggers: { manual: null },
          ...(type ? { type } : {}),
          instructions: "Decide.",
          script: "scripts/check.js",
          transitions: [{ to: "done", description: "Done." }],
        },
        done: null,
      },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("states.start.script");
    expect(issues[0]?.message).toContain("only a code state runs");
    expect(issues[0]?.message).toContain(`type '${named}'`);
  });
});

/**
 * A `skills.allow` entry is a slug or the spec does not load: one mis-authored
 * line used to be dropped silently, which switched a grant off without a word.
 */
/**
 * An undescribed edge routes on its target's instructions, which the agent is
 * then shown. A grader's instructions are its criteria and a code state has
 * none, so an edge into either must say when to take it; a code state's own
 * edges are routed by its script and need no description.
 */
describe("undescribed edges and automated states", () => {
  const withEdge = (target: Record<string, unknown>, source: Record<string, unknown> = {}) => ({
    states: {
      start: { triggers: { manual: null }, instructions: "Draft the reply.", transitions: [{ to: "next" }], ...source },
      next: { transitions: [{ to: "done", description: "Done." }], ...target },
      done: { instructions: "Say goodbye." },
    },
  });

  it("refuses an undescribed edge into a grader, whose criteria the agent is never shown", () => {
    const issues = issuesFor(withEdge({ type: "grader", instructions: "Judge the tone." }));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("states.start.transitions.0.description");
    expect(issues[0]?.message).toContain("'next' is a grader, whose instructions are its criteria");
  });

  it("refuses an undescribed edge into a code state, which has no instructions", () => {
    const issues = issuesFor(withEdge({ type: "code", script: "scripts/next.js" }));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("states.start.transitions.0.description");
    expect(issues[0]?.message).toContain("'next' is a code state, which has none");
  });

  it("lets a code state's own edges go undescribed: its script routes", () => {
    const spec = {
      states: {
        start: { triggers: { manual: null }, type: "code", script: "scripts/start.js", transitions: [{ to: "done" }] },
        done: null,
      },
    };
    expect(issuesFor(spec)).toEqual([]);
  });
});

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

describe("typed trigger signatures", () => {
  const withTrigger = (decl: unknown) => ({ states: { a: { triggers: { manual: decl } } } });
  const declarationIssues = (decl: unknown) => issuesFor(withTrigger(decl));

  it("accepts a typed entry beside a bare one", () => {
    const result = parseMachineSpec(
      withTrigger({
        description: "Refund one order and report the amount.",
        requires: ["order_id", { name: "due", type: "date", description: "The day the refund is due." }],
        returns: [{ name: "total", type: "number" }, { name: "remark" }],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("refuses an unknown type, naming the entry and the accepted types", () => {
    const [issue, ...rest] = declarationIssues({ requires: [{ name: "amount", type: "float" }] });
    expect(rest).toEqual([]);
    expect(issue?.path).toBe("states.a.triggers.manual.requires.0");
    expect(issue?.message).toContain("Entry 'amount'");
    expect(issue?.message).toContain('"float"');
    expect(issue?.message).toContain(
      "string, integer, number, boolean, date, date-time, object, array or file",
    );
  });

  it("accepts a file entry in requires and in returns", () => {
    const result = parseMachineSpec(
      withTrigger({
        requires: [{ name: "invoice", type: "file", description: "The invoice to reconcile." }],
        returns: [{ name: "report", type: "file" }],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("refuses an unknown entry key, naming the entry and the key", () => {
    const [issue, ...rest] = declarationIssues({
      returns: [{ name: "amount", type: "number", default: 0 }],
    });
    expect(rest).toEqual([]);
    expect(issue?.path).toBe("states.a.triggers.manual.returns.0");
    expect(issue?.message).toContain("Entry 'amount' declares 'default'");
    expect(issue?.message).toContain("'name', 'type' and 'description' only");
  });

  it("refuses an entry naming no variable", () => {
    const [issue] = declarationIssues({ requires: [{ type: "string" }] });
    expect(issue?.path).toBe("states.a.triggers.manual.requires.0");
    expect(issue?.message).toContain("needs a 'name'");
  });

  it("refuses an invalid name in the object spelling, at the name", () => {
    const [issue] = declarationIssues({ requires: [{ name: "Order Id" }] });
    expect(issue?.path).toBe("states.a.triggers.manual.requires.0.name");
    expect(issue?.message).toContain("'Order Id' is not a valid run-variable name");
  });

  it("refuses an empty entry description", () => {
    const [issue] = declarationIssues({ requires: [{ name: "due", description: "  " }] });
    expect(issue?.path).toBe("states.a.triggers.manual.requires.0.description");
    expect(issue?.message).toContain("'description' must be a non-empty string");
  });

  it("counts one name in both spellings as a duplicate", () => {
    const [issue, ...rest] = declarationIssues({ returns: ["total", { name: "total", type: "number" }] });
    expect(rest).toEqual([]);
    expect(issue?.path).toBe("states.a.triggers.manual.returns.1");
    expect(issue?.message).toBe("'total' is listed more than once.");
  });

  it("refuses the reserved returns in the object spelling too", () => {
    const issues = declarationIssues({ returns: [{ name: "trigger" }, { name: "title", type: "string" }] });
    expect(issues.map((i) => i.path)).toEqual([
      "states.a.triggers.manual.returns.0",
      "states.a.triggers.manual.returns.1",
    ]);
  });

  it("words a malformed list for both spellings", () => {
    const [issue] = declarationIssues({ requires: "order_id" });
    expect(issue?.message).toContain("must be a list of run-variable names");
    expect(issue?.message).toContain("{ name, type?, description? }");
    expect(issue?.message).not.toContain("names the contract only");
  });

  it("refuses an empty trigger description, naming the trigger", () => {
    const [issue, ...rest] = declarationIssues({ description: "  " });
    expect(rest).toEqual([]);
    expect(issue?.path).toBe("states.a.triggers.manual.description");
    expect(issue?.message).toContain("non-empty string");
  });

  it("reports the identical messages through validateSpec, as archmax validate does", async () => {
    const { validateSpec } = await import("./validate-spec.js");
    for (const decl of [
      { requires: [{ name: "amount", type: "float" }] },
      { returns: [{ name: "amount", default: 0 }] },
      { returns: ["total", { name: "total" }] },
      { requires: "order_id" },
      { description: "" },
    ]) {
      const expected = declarationIssues(decl);
      expect(validateSpec(withTrigger(decl)).schema.map((d) => ({ path: d.field, message: d.message }))).toEqual(
        expected,
      );
    }
  });
});

describe("a state's locks", () => {
  const spec = (states: Record<string, unknown>) => ({
    states: {
      start: { triggers: { manual: null }, transitions: [{ to: "done", description: "Test edge to done." }] },
      done: null,
      ...states,
    },
  });

  it("loads a state owning variables, guarded or not", () => {
    expect(issuesFor(spec({ start: { triggers: { manual: null }, locks: ["order_id", "summary"] } }))).toEqual([]);
  });

  it("refuses a variable owned by two states, naming both", () => {
    const issues = issuesFor(spec({ start: { triggers: { manual: null }, locks: ["order_id"] }, done: { locks: ["order_id"] } }));
    expect(issues).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/'order_id' is owned by more than one state \('start', 'done'\)/) }),
    ]);
  });

  it("refuses the reserved variables and a name listed twice", () => {
    const messages = issuesFor(spec({ start: { triggers: { manual: null }, locks: ["trigger", "title", "a", "a"] } })).map((i) => i.message);
    expect(messages).toEqual([
      "State 'start' cannot own the reserved variable 'trigger'",
      "State 'start' cannot own the reserved variable 'title'",
      "State 'start' lists 'a' in 'locks' twice",
    ]);
  });

  it("refuses locks on a human state", () => {
    const issues = issuesFor(
      spec({
        start: { triggers: { manual: null }, transitions: [{ to: "review", description: "Hand it over." }] },
        review: { type: "human", locks: ["x"], transitions: [{ to: "done", type: "approve", description: "Approve." }] },
      }),
    );
    expect(issues.map((i) => i.message)).toContain("State 'review' is a human state, which makes no tool calls, so it cannot own variables");
  });
});

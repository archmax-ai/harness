import { describe, expect, it } from "vitest";
import {
  pruneUndisclosedToolSections,
  upstreamSectionsFor,
} from "./prompt-pruning.js";
import { stripHtmlComments } from "./render-prompt.js";

const PROMPT = [
  "# Persona",
  "",
  "You are helpful.",
  "",
  "## Important Task Tool Usage Notes to Remember",
  "",
  "Long task guidance.",
  "",
  "### A nested heading inside the task section",
  "",
  "More task guidance.",
  "",
  "## Filesystem Tools",
  "",
  "Keep me.",
].join("\n");

describe("pruneUndisclosedToolSections", () => {
  it("removes a section up to the next same-level heading, keeping nested content with it", () => {
    const result = pruneUndisclosedToolSections(PROMPT, ["task"]);
    expect(result.removed).toEqual(["## Important Task Tool Usage Notes to Remember"]);
    expect(result.missingTools).toBeUndefined();
    expect(result.text).not.toContain("task guidance");
    expect(result.text).not.toContain("A nested heading inside the task section");
    expect(result.text).toContain("Keep me.");
  });

  it("collapses the blank runs left behind so output is stable", () => {
    const once = pruneUndisclosedToolSections(PROMPT, ["task"]).text;
    const twice = pruneUndisclosedToolSections(PROMPT, ["task"]).text;
    expect(once).toBe(twice);
    expect(once).not.toMatch(/\n{3,}/);
  });

  it("ignores tools with no known upstream sections", () => {
    // The essential built-ins (`write_todos` among them) are always disclosed,
    // so they own no prunable section and nothing is reported for them.
    for (const tool of ["some_host_tool", "write_todos", "read_file"]) {
      const result = pruneUndisclosedToolSections(PROMPT, [tool]);
      expect(result.text, tool).toBe(PROMPT);
      expect(result.removed, tool).toEqual([]);
      expect(result.missingTools, tool).toBeUndefined();
    }
  });

  it("reports a tool whose guidance was found nowhere", () => {
    const result = pruneUndisclosedToolSections("# Persona\n\nNothing upstream.", ["task"]);
    expect(result.missingTools).toEqual(["task"]);
  });
});

describe("upstream heading contract", () => {
  // `task` is the only prunable built-in, and upstream exports no constant for
  // its heading — drift is caught at runtime instead: an unmatched heading leaves
  // the prompt intact and emits one `warning` event (see the middleware tests).
  it("knows both sections owned by the task tool and nothing for always-on tools", () => {
    // Both, deliberately: a partial match counts as a successful prune, so
    // naming only one of them silently ships the other on every model call.
    expect(upstreamSectionsFor("task")).toEqual([
      "## `task` (subagent spawner)",
      "## Important Task Tool Usage Notes to Remember",
    ]);
    expect(upstreamSectionsFor("write_todos")).toHaveLength(0);
    expect(upstreamSectionsFor("read_file")).toHaveLength(0);
  });
});

describe("stripHtmlComments", () => {
  it("removes comments and normalizes the whitespace they leave behind", () => {
    const text = "# Title\n\n<!--\nreader-only diagram\n-->\n\nDomain constraints.\n";
    expect(stripHtmlComments(text)).toBe("# Title\n\nDomain constraints.");
  });

  it("returns the input unchanged when there is nothing to strip", () => {
    const text = "# Title\n\nDomain constraints.";
    expect(stripHtmlComments(text)).toBe(text);
  });

  it("removes several comments, including inline ones", () => {
    expect(stripHtmlComments("a <!-- one --> b <!-- two --> c")).toBe("a  b  c");
  });
});

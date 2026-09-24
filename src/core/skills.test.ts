import { describe, expect, it } from "vitest";
import type { BackendProtocolV2 } from "deepagents";
import { Workspace } from "./workspace.js";
import type { WorkflowLifecycleEvent } from "./events.js";
import {
  DEFAULT_SKILL_SOURCES,
  discoverSkills,
  inspectSkillMarkdown,
  skillOfPath,
  skillOfPattern,
  skillPrefixes,
} from "./skills.js";

function fakeBackend(files: Record<string, string>): BackendProtocolV2 {
  const norm = (p: string) => `/${p.replace(/^\/+/, "")}`;
  return {
    async readRaw(filePath: string) {
      const content = files[norm(filePath)];
      if (content === undefined) return { error: `not found: ${filePath}` };
      return { data: { content, mimeType: "text/plain", created_at: "", modified_at: "" } };
    },
    async ls(dirPath: string) {
      const prefix = norm(dirPath).replace(/\/$/, "");
      const seen = new Set<string>();
      for (const path of Object.keys(files)) {
        if (!path.startsWith(`${prefix}/`)) continue;
        const rest = path.slice(prefix.length + 1);
        const [head, ...tail] = rest.split("/");
        seen.add(tail.length ? `${prefix}/${head}/` : `${prefix}/${head}`);
      }
      return { files: [...seen].map((p) => ({ path: p, is_dir: p.endsWith("/") })) };
    },
  } as unknown as BackendProtocolV2;
}

const skill = (name: string, description = "What it does.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

function collect() {
  const events: WorkflowLifecycleEvent[] = [];
  return {
    onEvent: (event: WorkflowLifecycleEvent) => events.push(event),
    warnings: () =>
      events
        .filter((e) => e.type === "warning")
        .map((e) => (e as { message: string }).message),
  };
}

describe("inspectSkillMarkdown", () => {
  it("parses a well-formed SKILL.md", () => {
    const { definition, errors, warnings } = inspectSkillMarkdown(
      skill("order-data", "The order records."),
      "order-data",
    );
    expect(definition).toEqual({ slug: "order-data", description: "The order records." });
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("rejects an empty file, missing frontmatter, and a missing description", () => {
    expect(inspectSkillMarkdown("", "x").errors).toEqual(["file is empty"]);
    expect(inspectSkillMarkdown("# no frontmatter", "x").errors).toEqual([
      "no valid YAML frontmatter found",
    ]);
    expect(inspectSkillMarkdown("---\nname: x\n---\nbody", "x").errors).toEqual([
      "missing required 'description'",
    ]);
  });

  it("warns on a name/directory mismatch but keeps the directory as the slug", () => {
    const { definition, errors, warnings } = inspectSkillMarkdown(
      skill("order_data"),
      "order-data",
    );
    expect(errors).toEqual([]);
    expect(definition?.slug).toBe("order-data");
    expect(warnings[0]).toContain("should match directory name 'order-data'");
  });

  it("warns when the directory is not a slug, since no allow entry can name it", () => {
    const { warnings } = inspectSkillMarkdown(skill("Order_Data"), "Order_Data");
    expect(warnings.some((w) => w.includes("not a kebab-case slug"))).toBe(true);
  });

  it("needs no name field at all", () => {
    const parsed = inspectSkillMarkdown("---\ndescription: d\n---\nbody", "order-data");
    expect(parsed.definition).toEqual({ slug: "order-data", description: "d" });
    expect(parsed.warnings).toEqual([]);
  });
});

describe("discoverSkills", () => {
  it("discovers every bundle of a parent-directory source", async () => {
    const ws = new Workspace(
      fakeBackend({
        "/skills/order-data/SKILL.md": skill("order-data", "Orders."),
        "/skills/order-data/assets/orders.json": "[]",
        "/skills/refund-policy/SKILL.md": skill("refund-policy", "Refunds."),
      }),
    );
    const registry = await discoverSkills(ws, DEFAULT_SKILL_SOURCES);
    expect([...registry.keys()]).toEqual(["order-data", "refund-policy"]);
    expect(registry.get("order-data")).toEqual({
      slug: "order-data",
      description: "Orders.",
      prefix: "skills/order-data",
      skillFile: "skills/order-data/SKILL.md",
    });
  });

  it("accepts a direct bundle path as a source", async () => {
    const ws = new Workspace(
      fakeBackend({
        "/skills/order-data/SKILL.md": skill("order-data"),
        "/skills/refund-policy/SKILL.md": skill("refund-policy"),
      }),
    );
    const registry = await discoverSkills(ws, ["skills/order-data/"]);
    expect([...registry.keys()]).toEqual(["order-data"]);
  });

  it("normalizes source spellings", async () => {
    const ws = new Workspace(fakeBackend({ "/skills/a-b/SKILL.md": skill("a-b") }));
    for (const source of ["skills", "skills/", "./skills/", "/skills//"]) {
      expect([...(await discoverSkills(ws, [source])).keys()]).toEqual(["a-b"]);
    }
  });

  it("skips a directory with no SKILL.md, silently", async () => {
    const events = collect();
    const ws = new Workspace(
      fakeBackend({
        "/skills/order-data/SKILL.md": skill("order-data"),
        "/skills/notes/readme.md": "not a skill",
      }),
    );
    const registry = await discoverSkills(ws, DEFAULT_SKILL_SOURCES, events.onEvent);
    expect([...registry.keys()]).toEqual(["order-data"]);
    expect(events.warnings()).toEqual([]);
  });

  it("skips an unloadable bundle with a warning naming the slug", async () => {
    const events = collect();
    const ws = new Workspace(
      fakeBackend({
        "/skills/broken/SKILL.md": "no frontmatter here",
        "/skills/order-data/SKILL.md": skill("order-data"),
      }),
    );
    const registry = await discoverSkills(ws, DEFAULT_SKILL_SOURCES, events.onEvent);
    expect([...registry.keys()]).toEqual(["order-data"]);
    expect(events.warnings()[0]).toContain("Skipping skill 'broken'");
  });

  it("lets a later source shadow an earlier slug, with a warning", async () => {
    const events = collect();
    const ws = new Workspace(
      fakeBackend({
        "/base/order-data/SKILL.md": skill("order-data", "Base."),
        "/local/order-data/SKILL.md": skill("order-data", "Local."),
      }),
    );
    const registry = await discoverSkills(ws, ["base/", "local/"], events.onEvent);
    expect(registry.get("order-data")?.description).toBe("Local.");
    expect(registry.get("order-data")?.prefix).toBe("local/order-data");
    expect(events.warnings()[0]).toContain("shadows the one at base/order-data");
  });

  it("returns an empty registry for a source that serves nothing", async () => {
    const ws = new Workspace(fakeBackend({ "/AGENTS.md": "persona" }));
    const registry = await discoverSkills(ws, DEFAULT_SKILL_SOURCES);
    expect(registry.size).toBe(0);
  });
});

describe("skillPrefixes and skillOfPath", () => {
  const skills = skillPrefixes(
    new Map([
      [
        "order-data",
        {
          slug: "order-data",
          description: "d",
          prefix: "skills/order-data",
          skillFile: "skills/order-data/SKILL.md",
        },
      ],
      [
        "refund-policy",
        {
          slug: "refund-policy",
          description: "d",
          prefix: "skills/refund-policy",
          skillFile: "skills/refund-policy/SKILL.md",
        },
      ],
    ]),
  );

  it("resolves a path inside a bundle, including the bundle root itself", () => {
    expect(skillOfPath("skills/order-data", skills)).toBe("order-data");
    expect(skillOfPath("skills/order-data/SKILL.md", skills)).toBe("order-data");
    expect(skillOfPath("skills/order-data/assets/orders.json", skills)).toBe("order-data");
  });

  it("canonicalizes `./`, `//`, and `..` spellings before matching", () => {
    expect(skillOfPath("./skills/order-data/SKILL.md", skills)).toBe("order-data");
    expect(skillOfPath("/skills//order-data/./SKILL.md", skills)).toBe("order-data");
    expect(skillOfPath("skills/refund-policy/../order-data/SKILL.md", skills)).toBe("order-data");
    expect(skillOfPath("skills/order-data/assets/../SKILL.md", skills)).toBe("order-data");
  });

  it("resolves a sibling prefix by exact boundary, not by string prefix", () => {
    expect(skillOfPath("skills/order-data-archive/x", skills)).toBeNull();
  });

  it("returns null for a path in no bundle", () => {
    expect(skillOfPath("skills", skills)).toBeNull();
    expect(skillOfPath("skills/stray.md", skills)).toBeNull();
    expect(skillOfPath("scratchpad/report.md", skills)).toBeNull();
    expect(skillOfPath("../skills/order-data/SKILL.md", skills)).toBeNull();
    expect(skillOfPath("", skills)).toBeNull();
  });

  it("returns null against an empty table", () => {
    expect(skillOfPath("skills/order-data/SKILL.md")).toBeNull();
  });

  it("orders longest prefix first so a nested bundle wins", () => {
    const nested = skillPrefixes(
      new Map([
        ["outer", { slug: "outer", description: "d", prefix: "skills/outer", skillFile: "x" }],
        [
          "inner",
          {
            slug: "inner",
            description: "d",
            prefix: "skills/outer/inner",
            skillFile: "x",
          },
        ],
      ]),
    );
    expect(skillOfPath("skills/outer/inner/SKILL.md", nested)).toBe("inner");
    expect(skillOfPath("skills/outer/SKILL.md", nested)).toBe("outer");
  });

  it("resolves a pattern that can only match inside one bundle", () => {
    expect(skillOfPattern("skills/order-data/scripts/**", skills)).toBe("order-data");
    expect(skillOfPattern("skills/order-data/**/*.js", skills)).toBe("order-data");
    expect(skillOfPattern("/skills/order-data/assets/orders.json", skills)).toBe("order-data");
  });

  it("leaves a pattern spanning several bundles to the runtime rule", () => {
    expect(skillOfPattern("skills/**", skills)).toBeNull();
    expect(skillOfPattern("skills/*/scripts/**", skills)).toBeNull();
    expect(skillOfPattern("scratchpad/**", skills)).toBeNull();
  });
});

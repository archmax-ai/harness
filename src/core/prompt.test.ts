import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { Workspace } from "./workspace.js";
import { buildSystemPrompt, resolveSystemPrompt } from "./prompt.js";
import { PLATFORM_PROMPT } from "./platform-prompt.generated.js";
import { PLATFORM_PROMPT_PATH } from "../workflow/paths.js";
import { renderWorkspaceZones } from "./workspace-prompt.js";
import { defaultMounts, resolveMounts } from "./mounts.js";
import {
  NO_MOUNTS,
  SESSION_INTERNAL_DIRS,
  SESSION_OFFLOAD_DIRS,
  SESSION_OPEN_DIR,
} from "./zones.js";

const PLATFORM_BACKEND_PATH = PLATFORM_PROMPT_PATH;

/**
 * The prompt as one line, so an assertion pins the rule it is about and not the
 * column the sentence happened to wrap at. Rewrapping a paragraph must not fail
 * a test, or the prompt cannot be edited without editing its tests too.
 */
function flat(prompt: string): string {
  return prompt.replace(/\s+/g, " ");
}

/**
 * The prompt with the rendered workspace-zones section removed. That section is
 * framework fact assembled from the mount table on every resolve, so the layer
 * tests below assert on the layers they are about rather than restating it.
 */
function layersOnly(prompt: string, mounts = NO_MOUNTS): string {
  return prompt.replace(renderWorkspaceZones(mounts), "").replace(/\n{3,}/g, "\n\n").trim();
}

/** In-memory Workspace stub: `readText` keyed by path, everything else unused. */
/**
 * A backend stand-in for a mount table: only the resolved *keys* reach the
 * prompt, so nothing here is ever called.
 */
function fakeBackendSpec() {
  return {} as never;
}

function fakeWorkspace(files: Record<string, string>): Workspace {
  return {
    async readText(path: string) {
      return files[path] ?? null;
    },
  } as unknown as Workspace;
}

/** A plain agent's options: no platform layer, so the other layers stand alone. */
function baseOpts() {
  return { platformBackendPath: null };
}

/** A governed agent's options: the platform layer, overridable at the conventional path. */
function governedOpts() {
  return { platformBackendPath: PLATFORM_BACKEND_PATH };
}

describe("resolveSystemPrompt", () => {
  describe("workflow prompt layer", () => {
    it("appends the caller-composed workflow prompt (rendered section + prose)", async () => {
      const workspace = fakeWorkspace({});

      const prompt = await resolveSystemPrompt(workspace, {
        ...baseOpts(),
        workflowPrompt: "# Workflow: order-lookup\n\nRendered graph.\n\nProse addendum.",
      });
      expect(prompt).toContain("Rendered graph.");
      expect(prompt).toContain("Prose addendum.");
    });

    it("contributes nothing when no workflow prompt is supplied", async () => {
      const workspace = fakeWorkspace({ "AGENTS.md": "Persona only.\n" });

      const prompt = await resolveSystemPrompt(workspace, baseOpts());
      expect(layersOnly(prompt)).toBe("Persona only.");
    });

    it("contributes nothing when the workflow prompt is null", async () => {
      const workspace = fakeWorkspace({ "AGENTS.md": "Persona only.\n" });

      const prompt = await resolveSystemPrompt(workspace, { ...baseOpts(), workflowPrompt: null });
      expect(layersOnly(prompt)).toBe("Persona only.");
    });
  });

  describe("platform prompt layer", () => {
    it("uses the bundled prompt when the workspace serves no override", async () => {
      const prompt = await resolveSystemPrompt(fakeWorkspace({}), governedOpts());
      expect(layersOnly(prompt)).toBe(PLATFORM_PROMPT.trim());
    });

    it("uses the workspace's override when it serves one", async () => {
      const workspace = fakeWorkspace({
        [PLATFORM_BACKEND_PATH]: "Platform rules from backend.\n",
      });

      const prompt = await resolveSystemPrompt(workspace, governedOpts());
      expect(layersOnly(prompt)).toBe("Platform rules from backend.");
    });

    it("leaves the platform layer out for a plain agent, override or not", async () => {
      const workspace = fakeWorkspace({
        "AGENTS.md": "Persona.\n",
        [PLATFORM_BACKEND_PATH]: "Platform rules from backend.\n",
      });

      const prompt = await resolveSystemPrompt(workspace, baseOpts());
      expect(layersOnly(prompt)).toBe("Persona.");
    });

    // The runtime never reads the Markdown: `npm run build` regenerates the
    // module from it, and this is what catches a commit that edited one alone.
    it("ships exactly what platform-prompt.md says", async () => {
      const markdown = await readFile(new URL("./platform-prompt.md", import.meta.url), "utf8");
      expect(PLATFORM_PROMPT).toBe(markdown);
    });
  });

  describe("layer ordering", () => {
    it("merges layers in order: agents, extra, platform, workspace, workflow", async () => {
      const workspace = fakeWorkspace({
        "AGENTS.md": "Persona layer.\n",
        [PLATFORM_BACKEND_PATH]: "Platform layer.\n",
      });

      const prompt = await resolveSystemPrompt(workspace, {
        ...governedOpts(),
        extra: "Extra layer.",
        workflowPrompt: "Workflow layer.",
      });

      const agentsIdx = prompt.indexOf("Persona layer.");
      const extraIdx = prompt.indexOf("Extra layer.");
      const platformIdx = prompt.indexOf("Platform layer.");
      const workflowIdx = prompt.indexOf("Workflow layer.");
      const workspaceIdx = prompt.indexOf("## Workspace zones");
      expect(agentsIdx).toBeGreaterThanOrEqual(0);
      expect(agentsIdx).toBeLessThan(extraIdx);
      expect(extraIdx).toBeLessThan(platformIdx);
      expect(platformIdx).toBeLessThan(workspaceIdx);
      expect(workspaceIdx).toBeLessThan(workflowIdx);
    });

    it("honors a custom agentsPath", async () => {
      const workspace = fakeWorkspace({ "custom/PERSONA.md": "Custom persona.\n" });

      const prompt = await resolveSystemPrompt(workspace, {
        ...baseOpts(),
        agentsPath: "custom/PERSONA.md",
      });
      expect(layersOnly(prompt)).toBe("Custom persona.");
    });
  });

  describe("workspace layer", () => {
    it("describes the mounts the assembly resolved, not a hand-written list", async () => {
      const workspace = fakeWorkspace({});
      const { prefixes } = resolveMounts(defaultMounts("/ws"));

      const prompt = await resolveSystemPrompt(workspace, {
        ...baseOpts(),
        mountPrefixes: prefixes,
      });

      expect(prompt).toContain("## Workspace zones");
      expect(prompt).toContain("`skills/`");
      // Never an authoring-plane prefix: neither is a mount, so no prompt layer
      // can name one as somewhere the agent may look.
      expect(prompt).not.toContain("`workflows/`");
      expect(prompt).not.toContain("`subagents/`");
    });

    it("names no directory the resolved mount table does not serve", async () => {
      // The guard for the `hitl/` class of bug: prose that outlives its mount.
      // Every backticked `<name>/` the assembled prompt presents as available
      // must be a resolved mount or a run area the framework owns.
      const workspace = fakeWorkspace({});
      const { prefixes } = resolveMounts(defaultMounts("/ws"));

      const prompt = await resolveSystemPrompt(workspace, {
        ...governedOpts(),
        mountPrefixes: prefixes,
        workflowPrompt: null,
      });

      const served = new Set([
        ...prefixes.dirs,
        ...SESSION_INTERNAL_DIRS,
        ...SESSION_OFFLOAD_DIRS,
        SESSION_OPEN_DIR,
      ]);
      const advertised = [...prompt.matchAll(/`([A-Za-z0-9._-]+)\/`/g)].map((m) => m[1]);

      expect(advertised.length).toBeGreaterThan(0);
      expect([...new Set(advertised)].filter((name) => !served.has(name))).toEqual([]);
    });

    it("carries the section even when the workspace serves no mounts", async () => {
      const prompt = await resolveSystemPrompt(fakeWorkspace({}), baseOpts());

      expect(prompt).toContain("## Workspace zones");
      expect(prompt).toContain("`scratchpad/`");
    });

    /**
     * The static prefix is the cacheable half of every model call, so it cannot
     * carry anything that varies with the state. A governed mount does vary, so
     * it is named here in no state and disclosed in the volatile block instead.
     */
    it("names no governed mount, whatever the state, and says where they are listed", async () => {
      const workspace = fakeWorkspace({});
      const { prefixes } = resolveMounts({
        "/skills/": fakeBackendSpec(),
        "/reference/": { backend: fakeBackendSpec(), governed: true },
        "/catalogs/eu/": { backend: fakeBackendSpec(), governed: true },
      });

      const prompt = await resolveSystemPrompt(workspace, {
        ...baseOpts(),
        mountPrefixes: prefixes,
      });

      expect(prompt).toContain("`skills/`");
      expect(prompt).not.toContain("`reference/`");
      expect(prompt).not.toContain("`catalogs/eu/`");
      expect(prompt).toContain("Mounts available in this state");
      // One table, one prefix: the layer is a pure function of the table, so
      // every state's model call is handed byte-identical text.
      const again = await resolveSystemPrompt(workspace, {
        ...baseOpts(),
        mountPrefixes: prefixes,
      });
      expect(again).toBe(prompt);
    });
  });

  describe("agent-argument interpolation is disclosed", () => {
    // The capability is worthless undisclosed: the runtime substitutes `${{…}}`
    // in the agent's own tool arguments, and nothing else in the prompt says so.
    const shippedPlatformPrompt = async () =>
      resolveSystemPrompt(fakeWorkspace({}), { ...governedOpts(), workflowPrompt: null });

    it("states the syntax, the embedding property and the escape", async () => {
      const prompt = await shippedPlatformPrompt();
      expect(prompt).toContain("${{name}}");
      expect(prompt).toContain("${{name.path.to.value}}");
      expect(prompt).toContain("$${{name}}");
      expect(prompt).toContain("inside** a longer string");
    });

    it("points at the variable tool rather than enumerating variables", async () => {
      const prompt = await shippedPlatformPrompt();
      expect(prompt).toContain("archmax_get_variables");
    });

    // A reference costs the model the name and the tool gets the value, so the
    // prompt has to say *prefer this*, not merely that the syntax exists.
    it("asks for the reference over the retyped value, and says why", async () => {
      const prompt = await shippedPlatformPrompt();
      expect(flat(prompt)).toContain("Prefer the reference to writing the value out");
      expect(flat(prompt)).toContain("what you spend tokens on");
      expect(flat(prompt)).toContain("cannot paraphrase, truncate or mistype");
    });
  });

  describe("programmatic tool calling is instructed, not merely offered", () => {
    // `archmax_eval` used to be described as available. Described, a model reaches
    // for one tool call at a time and pays for every intermediate result twice —
    // once arriving, then on every later call of the turn. The instruction is the
    // point, so it is pinned here with the reason a model can act on.
    const shippedPlatformPrompt = async () =>
      resolveSystemPrompt(fakeWorkspace({}), { ...governedOpts(), workflowPrompt: null });

    it("tells the agent to default to code over a sequence of calls", async () => {
      const prompt = await shippedPlatformPrompt();
      expect(flat(prompt)).toContain("Write code instead of many calls");
      expect(flat(prompt)).toContain("Reach for it by default");
      expect(prompt).toContain("archmax_eval");
    });

    it("names what comes back, which is the whole token argument", async () => {
      const prompt = await shippedPlatformPrompt();
      expect(flat(prompt)).toContain("only your last expression and whatever you `console.log`");
      expect(flat(prompt)).toContain("never enters the conversation");
    });

    it("keeps the governance and persistence facts a model needs to use it", async () => {
      const prompt = await shippedPlatformPrompt();
      expect(flat(prompt)).toContain("governed exactly as your own calls are");
      expect(flat(prompt)).toContain("The REPL keeps its state between calls");
      expect(prompt).toContain("archmax_run");
    });

    // The trap the instruction above would otherwise set: `archmax_eval` is handed
    // no `args.variables` and may not call `archmax_get_variables` (a PTC-excluded
    // control), so the only route from the store into inline code is the `${{…}}`
    // substitution its `code` argument does go through — and only for a scalar.
    it("says how a variable reaches inline code, and where structured values go instead", async () => {
      const prompt = await shippedPlatformPrompt();
      expect(flat(prompt)).toContain("Your code cannot read the run's variables");
      expect(flat(prompt)).toContain("interpolate a scalar one into it with `${{name}}`");
      expect(flat(prompt)).toContain("args.variables");
    });
  });

  describe("movement has one author", () => {
    // The rendered graph section restates none of this (see
    // `workflow/render-prompt.test.ts`), so the platform prompt alone must say
    // what `to` takes, what a terminal state is, and which hooks gate a move.
    const shippedPlatformPrompt = async () =>
      resolveSystemPrompt(fakeWorkspace({}), { ...governedOpts(), workflowPrompt: null });

    it("states that the slug is the routing token", async () => {
      const prompt = await shippedPlatformPrompt();
      expect(prompt).toContain("`to` takes the target's **slug**");
      expect(prompt).toMatch(/backticked token on the transition line/);
    });

    // The graph is disclosed per state, so there is no listing to infer this
    // from: the prompt has to say both that it will be stated and what to do.
    it("says a state with no transitions ends the run", async () => {
      const prompt = await shippedPlatformPrompt();
      expect(flat(prompt)).toContain("A state with no transitions says so");
      expect(prompt).toContain("finish its work and stop");
    });

    // The one place the disclosure boundary is taught: no map to consult, and no
    // routing to a slug that arrived from anywhere but a transition line.
    it("says the graph is disclosed only from the state you are in", async () => {
      const prompt = await shippedPlatformPrompt();
      expect(flat(prompt)).toContain("nothing else of the graph");
      expect(flat(prompt)).toContain("there is no map of the workflow to consult");
      expect(prompt).toContain("Do not guess at slugs");
    });

    it("names both hooks that gate an advance", async () => {
      const prompt = await shippedPlatformPrompt();
      expect(prompt).toMatch(/`after` hook and then the\s+target's `before` hook/);
    });

    it("points at the per-state skills section, not a fixed path", async () => {
      const prompt = await shippedPlatformPrompt();
      expect(prompt).toMatch(/Skills\s+available in this state/);
      expect(prompt).not.toContain("skills/<name>/SKILL.md");
    });
  });

  describe("the reserved title is disclosed", () => {
    // Nothing else tells the agent the run has a name to set: no state's
    // `instructions` can be relied on for it, which is why it lives here.
    const shippedPlatformPrompt = async () =>
      resolveSystemPrompt(fakeWorkspace({}), { ...governedOpts(), workflowPrompt: null });

    // Adherence turned out to depend on *where* this sits: as a paragraph in the
    // Tools section the model routinely skipped it, so it is step 1 of the
    // movement list — the part a run actually follows.
    it("makes naming the run step 1 of how you move", async () => {
      const prompt = await shippedPlatformPrompt();
      expect(prompt).toContain("1. **Name the run first.**");
      expect(prompt).toMatch(/1\. \*\*Name the run first\.\*\*[\s\S]{0,200}archmax_set_variables/);
    });

    it("states it as an obligation that outranks the state's own instructions", async () => {
      const prompt = await shippedPlatformPrompt();
      expect(prompt).toContain("it is not optional");
      expect(flat(prompt)).toContain(
        "it still goes first when the state's instructions tell you to do something else first",
      );
      expect(flat(prompt)).toContain("before any other tool call");
    });

    it("asks for updates as the task changes", async () => {
      const prompt = await shippedPlatformPrompt();
      expect(flat(prompt)).toContain("the old title no longer describes");
    });

    it("names the tool that writes it and warns off locking", async () => {
      const prompt = await shippedPlatformPrompt();
      expect(prompt).toContain('archmax_set_variables({ "variables": { "title"');
      expect(flat(prompt)).toContain("Never pass `lock` with it");
    });

    it("carries it with no workflow prompt at all", async () => {
      // It is platform text, so a workspace that says nothing about a title
      // still gets the instruction.
      const prompt = await shippedPlatformPrompt();
      expect(prompt).toContain("Naming the run");
    });
  });
});

describe("buildSystemPrompt", () => {
  it("returns an empty string when no layers are provided", () => {
    expect(buildSystemPrompt({})).toBe("");
  });

  it("merges layers in order: agents, extra, platform, workspace, workflow", () => {
    const prompt = buildSystemPrompt({
      agents: "Customer support agent.",
      extra: "Extra instructions.",
      platform: "Platform graph rules.",
      workspace: "## Workspace zones",
      workflow: "Workflow graph.",
    });
    const at = (s: string) => prompt.indexOf(s);
    expect(at("Customer support agent.")).toBeLessThan(at("Extra instructions."));
    expect(at("Extra instructions.")).toBeLessThan(at("Platform graph rules."));
    expect(at("Platform graph rules.")).toBeLessThan(at("## Workspace zones"));
    expect(at("## Workspace zones")).toBeLessThan(at("Workflow graph."));
  });
});

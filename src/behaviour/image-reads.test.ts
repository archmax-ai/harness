/**
 * With `images` on, an image the model reads reaches it as an image — in a
 * `user` message right after that batch of tool results, added to the request
 * only — while the history, checkpoints, events and scripts carry no bytes, and
 * every other binary file stays refused.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgent, createMemorySessionStore } from "../index.js";
import {
  AGENTS_MD,
  assemble,
  cleanupWorkspaces,
  eventsOf,
  freshSessionId,
  makeWorkspace,
  ScriptedModel,
  skillMarkdown,
  toolResults,
  turn,
  workspaceWith,
  type ModelCall,
} from "./support.js";

afterEach(cleanupWorkspaces);

const RUNTIME = { engine: "archmax-harness", version: "2" };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const OTHER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0e]);
const PDF = Buffer.from("%PDF-1.4\n%âã\n");
const PNG_URL = `data:image/png;base64,${PNG.toString("base64")}`;
const LOGO = "skills/media/assets/logo.png";

const spec = {
  runtime: RUNTIME,
  skills: { allow_always: [] },
  states: { start: { triggers: { manual: null }, skills: { allow: ["media"] } } },
};

function mediaWorkspace(): string {
  const root = workspaceWith(spec, {
    "skills/media/SKILL.md": skillMarkdown("media", "Brand media."),
    "skills/secret/SKILL.md": skillMarkdown("secret", "Not enabled anywhere."),
  });
  mkdirSync(join(root, "skills/media/assets"), { recursive: true });
  writeFileSync(join(root, LOGO), PNG);
  writeFileSync(join(root, "skills/media/assets/other.png"), OTHER);
  writeFileSync(join(root, "skills/media/assets/brief.pdf"), PDF);
  writeFileSync(join(root, "skills/secret/hidden.png"), PNG);
  return root;
}

const read = (file_path: string) => ({ tool: "read_file", args: { file_path } });

/** The image URLs a model call carried, by the kind of message carrying them. */
function imagesIn(call: ModelCall | undefined): Array<{ type: string; url: string }> {
  return (call?.parts ?? []).flatMap(({ type, parts }) =>
    parts
      .filter((part) => part.type === "image_url")
      .map((part) => ({ type, url: String((part.image_url as { url?: string }).url) })),
  );
}

/** Every text part of the user messages a model call carried. */
function userTexts(call: ModelCall | undefined): string[] {
  return (call?.parts ?? [])
    .filter(({ type }) => type === "human")
    .flatMap(({ parts }) => parts.filter((p) => p.type === "text").map((p) => String(p.text)));
}

describe("with images on", () => {
  it("shows the image in a user message after the tool results, and nowhere else", async () => {
    const { agent, model, events } = await assemble(mediaWorkspace(), {
      turns: [read(LOGO), { reply: "a logo" }],
      params: { images: true },
    });
    const { messages } = await turn(agent, freshSessionId(), "what is in the logo?");

    expect(toolResults(messages).find((r) => r.name === "read_file")?.content).toBe(
      `Image '${LOGO}' (image/png, 12 B) is shown below.`,
    );
    const after = model.calls[1];
    expect(imagesIn(after)).toEqual([{ type: "human", url: PNG_URL }]);
    // Right after the batch's tool results, before the model answers.
    const kinds = after!.parts.map((p) => p.type);
    expect(kinds.slice(-3)).toEqual(["ai", "tool", "human"]);
    expect(userTexts(after)).toContain(`Image '${LOGO}':`);

    // The history, and therefore the checkpoint, holds the line and no bytes.
    expect(JSON.stringify(messages)).not.toContain(PNG.toString("base64"));
    expect(messages.some((m) => JSON.stringify((m as { content?: unknown }).content).includes("image_url"))).toBe(false);
    const preview = eventsOf(events, "tool-result").find((e) => e.tool === "read_file")?.output;
    expect(preview).toBe(`Image '${LOGO}' (image/png, 12 B) is shown below.`);
  });

  it("keeps every other binary refused, and a script's read text only", async () => {
    const { agent, model } = await assemble(mediaWorkspace(), {
      turns: [
        read("skills/media/assets/brief.pdf"),
        { tool: "archmax_eval", args: { code: `await tools.readFile({ file_path: "${LOGO}" });` } },
        { reply: "done" },
      ],
      params: { images: true },
    });
    const { messages } = await turn(agent, freshSessionId(), "go");
    const results = toolResults(messages);
    expect(results.find((r) => r.name === "read_file")?.content).toContain("is a binary file (application/pdf");
    expect(results.find((r) => r.name === "archmax_eval")?.content).toContain(`'${LOGO}' is a binary file (image/png`);
    expect(model.calls.flatMap(imagesIn)).toEqual([]);
  });

  it("names an image deleted since it was read, and the call goes ahead", async () => {
    const { agent, model } = await assemble(mediaWorkspace(), {
      turns: [
        { tool: "copy_file", args: { source: LOGO, destination: "scratchpad/photo.png" } },
        read("scratchpad/photo.png"),
        { tool: "remove_file", args: { file_path: "scratchpad/photo.png" } },
        { reply: "it is gone" },
      ],
      params: { images: true },
    });
    const { reply } = await turn(agent, freshSessionId(), "go");
    expect(imagesIn(model.calls[2])).toEqual([{ type: "human", url: PNG_URL }]);
    expect(imagesIn(model.calls[3])).toEqual([]);
    expect(userTexts(model.calls[3])).toContain(
      "Image 'scratchpad/photo.png', read earlier, is no longer available: it does not exist.",
    );
    expect(reply).toBe("it is gone");
  });

  it("keeps only the most recent images attached when bounded", async () => {
    const { agent, model } = await assemble(mediaWorkspace(), {
      turns: [read(LOGO), read("skills/media/assets/other.png"), { reply: "two images" }],
      params: { images: { keep: 1 } },
    });
    await turn(agent, freshSessionId(), "go");
    expect(imagesIn(model.calls[1]).map((i) => i.url)).toEqual([PNG_URL]);
    expect(imagesIn(model.calls[2]).map((i) => i.url)).toEqual([`data:image/png;base64,${OTHER.toString("base64")}`]);
    expect(userTexts(model.calls[2])).toContain(
      `Image '${LOGO}' was shown earlier and is no longer attached; read it again to see it.`,
    );
  });

  it("does not send an image over the size bound", async () => {
    const { agent, model } = await assemble(mediaWorkspace(), {
      turns: [read(LOGO), { reply: "too big" }],
      params: { images: { maxBytes: 4 } },
    });
    const { messages } = await turn(agent, freshSessionId(), "go");
    expect(toolResults(messages).find((r) => r.name === "read_file")?.content).toBe(
      `Image '${LOGO}' (image/png, 12 B) was not shown: images over 4 B are not sent to the model.`,
    );
    expect(model.calls.flatMap(imagesIn)).toEqual([]);
  });

  it("leaves governance first: an image the state may not read is refused, not shown", async () => {
    const { agent, model, events } = await assemble(mediaWorkspace(), {
      turns: [read("skills/secret/hidden.png"), { reply: "no" }],
      params: { images: true },
    });
    await turn(agent, freshSessionId(), "go");
    expect(eventsOf(events, "tool-blocked")).toMatchObject([{ tool: "read_file" }]);
    expect(model.calls.flatMap(imagesIn)).toEqual([]);
  });

  it("tells the model what read_file returns", async () => {
    const { agent, model } = await assemble(mediaWorkspace(), { turns: [{ reply: "ok" }], params: { images: true } });
    await turn(agent, freshSessionId(), "go");
    expect(model.boundTools.get("read_file")?.description).toContain("an image is shown to you right after the tool result");
  });

  it("works in a plain agent too", async () => {
    const store = createMemorySessionStore();
    await store.backend.uploadFiles!([["/s1/scratchpad/shot.png", PNG]]);
    const model = new ScriptedModel([read("scratchpad/shot.png"), { reply: "a screenshot" }]);
    const agent = await createAgent({
      workflow: false,
      model: model as never,
      images: true,
      onEvent: () => {},
      workspace: { rootDir: makeWorkspace({ "AGENTS.md": AGENTS_MD }), sessionStore: store },
    });
    await agent.invoke({ messages: [{ role: "user", content: "look" }] } as never, { configurable: { thread_id: "s1" } });
    expect(imagesIn(model.calls[1])).toEqual([{ type: "human", url: PNG_URL }]);
  });
});

describe("with images off", () => {
  it("refuses an image as before", async () => {
    const { agent, model } = await assemble(mediaWorkspace(), { turns: [read(LOGO), { reply: "no" }] });
    const { messages } = await turn(agent, freshSessionId(), "go");
    expect(toolResults(messages).find((r) => r.name === "read_file")?.content).toContain("is a binary file (image/png");
    expect(model.calls.flatMap(imagesIn)).toEqual([]);
  });
});

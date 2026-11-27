/**
 * Host tools that take a connection (`toolConnections`): a state grants one tool through several
 * connections by listing it once per connection, a call names the one it runs through, and a call
 * that leaves it out runs through the state's one connection — on the model's path, a code state's
 * script and a delegated child alike.
 */
import { afterEach, describe, expect, it } from "vitest";
import { toolsFromMap, ToolConnectionsError, workflowToolName } from "../index.js";
import {
  advanceTo,
  AGENTS_MD,
  assemble,
  cleanupWorkspaces,
  eventsOf,
  freshSessionId,
  makeWorkspace,
  toolResults,
  turn,
  workspaceWith,
} from "./support.js";

afterEach(cleanupWorkspaces);

const RUNTIME = { engine: "archmax-harness", version: "3" };

/** `rest__request`, which records the arguments of every call it serves. */
function restTool() {
  const served: Record<string, unknown>[] = [];
  const tools = toolsFromMap({
    rest__request: {
      description: "Send a request to the connection's API.",
      inputSchema: {
        type: "object",
        properties: { connection: { type: "string" }, path: { type: "string" } },
      },
      handler: async (input) => {
        served.push({ ...input });
        return JSON.stringify({ through: input.connection ?? null });
      },
    },
  });
  return { served, tools, params: { tools, toolConnections: { rest__request: "connection" } } };
}

const TWO_APIS = [
  { tool: "rest__request", connection: "nominatim" },
  { tool: "rest__request", connection: "zaepflefinder" },
];

describe("a code state granted one tool through two connections", () => {
  it("calls each by name, and is refused a call naming neither", async () => {
    const spec = {
      runtime: RUNTIME,
      states: {
        lookup: {
          type: "code",
          script: "scripts/lookup.js",
          triggers: { manual: null },
          tools: { allow: TWO_APIS },
          transitions: [{ to: "done", description: "Looked up." }],
        },
        done: {},
      },
    };
    const root = workspaceWith(spec, {
      "workflows/w/scripts/lookup.js":
        `/** Asks both APIs. */\nexport default async function ({ tools }) {\n` +
        `  const place = JSON.parse(await tools.rest__request({ connection: "nominatim", path: "search" }));\n` +
        `  const shops = JSON.parse(await tools.rest__request({ connection: "zaepflefinder", path: "" }));\n` +
        `  let refused = "";\n` +
        `  try { await tools.rest__request({ path: "" }); } catch (error) { refused = String(error.message ?? error); }\n` +
        `  await tools.archmax_set_variables({ variables: { place: place.through, shops: shops.through, refused } });\n` +
        `  await tools.archmax_advance({ to: "done", reason: "looked up" });\n}\n`,
    });
    const { served, params } = restTool();
    const { agent } = await assemble(root, { params, turns: [{ reply: "done" }] });
    const outcome = await agent.workflow.send(freshSessionId(), { message: "72072" });

    expect(outcome.kind).toBe("completed");
    expect(outcome.variables.place?.value).toBe("nominatim");
    expect(outcome.variables.shops?.value).toBe("zaepflefinder");
    expect(outcome.variables.refused?.value).toContain("name one in its 'connection' argument");
    expect(served.map((args) => args.connection)).toEqual(["nominatim", "zaepflefinder"]);
  });
});

describe("the model's call", () => {
  const spec = (allow: unknown[]) => ({
    runtime: RUNTIME,
    states: {
      lookup: { triggers: { manual: null }, tools: { allow }, transitions: [{ to: "done", description: "Done." }] },
      done: {},
    },
  });

  it("leaving the connection out runs through the state's one connection, which the tool receives", async () => {
    const { served, params } = restTool();
    const { agent } = await assemble(workspaceWith(spec([{ tool: "rest__request", connection: "nominatim" }])), {
      params,
      turns: [{ tool: "rest__request", args: { path: "search" } }, advanceTo("done"), { reply: "found" }],
    });
    const { messages } = await turn(agent, freshSessionId(), "72072");

    expect(served).toEqual([{ path: "search", connection: "nominatim" }]);
    expect(JSON.parse(toolResults(messages).find((r) => r.name === "rest__request")!.content)).toEqual({
      through: "nominatim",
    });
  });

  it("naming a connection the state does not grant is blocked, the reason naming the ones it does", async () => {
    const { served, params } = restTool();
    const { agent, events } = await assemble(workspaceWith(spec(TWO_APIS)), {
      params,
      turns: [{ tool: "rest__request", args: { connection: "other", path: "" } }, { reply: "no" }],
    });
    await turn(agent, freshSessionId(), "go");

    expect(served).toEqual([]);
    const [blocked] = eventsOf(events, "tool-blocked");
    expect(blocked?.reason).toContain("'rest__request' runs through 'nominatim', 'zaepflefinder' in 'lookup', not 'other'.");
  });
});

describe("a delegated child", () => {
  it("governs its calls by the same declarations", async () => {
    const child = {
      runtime: RUNTIME,
      states: { work: { triggers: { manual: null }, tools: { allow: [{ tool: "rest__request", connection: "nominatim" }] } } },
    };
    const parent = {
      runtime: RUNTIME,
      states: {
        start: {
          triggers: { manual: null },
          tools: { allow: [workflowToolName("enrich"), ...TWO_APIS] },
          transitions: [{ to: "done", description: "Delegated." }],
        },
        done: {},
      },
    };
    const root = makeWorkspace({
      "AGENTS.md": AGENTS_MD,
      "workflows/w/workflow.yaml": parent,
      "workflows/enrich/workflow.yaml": child,
    });
    const { served, params } = restTool();
    const { agent, events } = await assemble(root, {
      params,
      turns: [
        { tool: workflowToolName("enrich"), args: {} },
        // — child —
        { tool: "rest__request", args: { connection: "zaepflefinder", path: "" } },
        { tool: "rest__request", args: { path: "search" } },
        { reply: "child done" },
        // — parent —
        advanceTo("done"),
        { reply: "parent done" },
      ],
    });
    await turn(agent, "s1", "go");

    expect(eventsOf(events, "tool-blocked")).toMatchObject([{ state: "work", tool: "rest__request" }]);
    expect(served).toEqual([{ path: "search", connection: "nominatim" }]);
  });
});

describe("assembly refuses", () => {
  it("a connection declaration for one of the runtime's own tools", async () => {
    await expect(
      assemble(workspaceWith({ runtime: RUNTIME, states: { a: { triggers: { manual: null } } } }), {
        params: { toolConnections: { read_file: "connection" } },
      }),
    ).rejects.toThrow(ToolConnectionsError);
  });
});

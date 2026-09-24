import { describe, expect, it } from "vitest";
import { ToolMessage } from "@langchain/core/messages";
import { createToolMockMiddleware, type ToolMockSpec } from "./mock-middleware.js";

type WrapToolCall = (req: unknown, handler: (r: unknown) => unknown) => Promise<unknown>;

function wrapToolCall(): WrapToolCall {
  return (createToolMockMiddleware() as unknown as { wrapToolCall: WrapToolCall }).wrapToolCall;
}

function request(opts: {
  name: string;
  args?: Record<string, unknown>;
  mocks?: ToolMockSpec[];
  configSlot?: "runtime" | "config";
}) {
  const configurable = { __toolMocks: opts.mocks ?? [] };
  return {
    toolCall: { name: opts.name, args: opts.args ?? {}, id: "call-1" },
    ...(opts.configSlot === "config"
      ? { config: { configurable } }
      : { runtime: { configurable } }),
  };
}

async function call(opts: Parameters<typeof request>[0]) {
  let handlerRan = false;
  const result = await wrapToolCall()(request(opts), () => {
    handlerRan = true;
    return "HANDLER_RAN";
  });
  return { result, handlerRan };
}

describe("createToolMockMiddleware", () => {
  it("short-circuits a matching mock into a ToolMessage", async () => {
    const { result, handlerRan } = await call({
      name: "read_file",
      mocks: [{ name: "read_file", result: "mocked body" }],
    });
    expect(handlerRan).toBe(false);
    expect(result).toBeInstanceOf(ToolMessage);
    const message = result as ToolMessage;
    expect(message.content).toBe("mocked body");
    expect(message.tool_call_id).toBe("call-1");
    expect(message.name).toBe("read_file");
  });

  it("uses the first matching mock when several match", async () => {
    const { result } = await call({
      name: "read_file",
      mocks: [
        { name: "read_file", result: "first" },
        { name: "read_file", result: "second" },
      ],
    });
    expect((result as ToolMessage).content).toBe("first");
  });

  it("skips mocks whose name does not match", async () => {
    const { result, handlerRan } = await call({
      name: "read_file",
      mocks: [{ name: "write_file", result: "wrong tool" }],
    });
    expect(handlerRan).toBe(true);
    expect(result).toBe("HANDLER_RAN");
  });

  it("gates on whenInput via partial match over the call args", async () => {
    const mocks: ToolMockSpec[] = [
      { name: "read_file", whenInput: { path: "data/orders.json" }, result: "orders" },
    ];
    const hit = await call({
      name: "read_file",
      args: { path: "data/orders.json", extra: true },
      mocks,
    });
    expect((hit.result as ToolMessage).content).toBe("orders");

    const miss = await call({ name: "read_file", args: { path: "other.json" }, mocks });
    expect(miss.handlerRan).toBe(true);
  });

  it("recurses into nested whenInput objects", async () => {
    const mocks: ToolMockSpec[] = [
      { name: "lookup", whenInput: { query: { customer: "acme" } }, result: "hit" },
    ];
    const hit = await call({
      name: "lookup",
      args: { query: { customer: "acme", region: "eu" }, limit: 5 },
      mocks,
    });
    expect((hit.result as ToolMessage).content).toBe("hit");

    const miss = await call({
      name: "lookup",
      args: { query: { customer: "globex" } },
      mocks,
    });
    expect(miss.handlerRan).toBe(true);
  });

  it("matches whenInput arrays element-wise, not by reference", async () => {
    const equalButDistinct = await call({
      name: "tag",
      args: { tags: ["a", "b"] },
      mocks: [{ name: "tag", whenInput: { tags: ["a", "b"] }, result: "matched" }],
    });
    expect((equalButDistinct.result as ToolMessage).content).toBe("matched");

    const differentLength = await call({
      name: "tag",
      args: { tags: ["a", "b", "c"] },
      mocks: [{ name: "tag", whenInput: { tags: ["a", "b"] }, result: "never" }],
    });
    expect(differentLength.handlerRan).toBe(true);

    const nestedObjects = await call({
      name: "tag",
      args: { items: [{ id: 1, extra: true }, { id: 2 }] },
      mocks: [{ name: "tag", whenInput: { items: [{ id: 1 }, { id: 2 }] }, result: "nested" }],
    });
    expect((nestedObjects.result as ToolMessage).content).toBe("nested");
  });

  it("does not match when a whenInput key is missing from the args", async () => {
    const { handlerRan } = await call({
      name: "read_file",
      args: { other: 1 },
      mocks: [{ name: "read_file", whenInput: { path: "x" }, result: "never" }],
    });
    expect(handlerRan).toBe(true);
  });

  it("passes string results through verbatim and JSON-stringifies the rest", async () => {
    const str = await call({
      name: "t",
      mocks: [{ name: "t", result: '{"already": "json"}' }],
    });
    expect((str.result as ToolMessage).content).toBe('{"already": "json"}');

    const obj = await call({
      name: "t",
      mocks: [{ name: "t", result: { ok: true, n: 2 } }],
    });
    expect((obj.result as ToolMessage).content).toBe('{"ok":true,"n":2}');

    const undef = await call({ name: "t", mocks: [{ name: "t", result: undefined }] });
    expect((undef.result as ToolMessage).content).toBe("null");
  });

  it("falls back to config.configurable when runtime has none", async () => {
    const { result, handlerRan } = await call({
      name: "read_file",
      mocks: [{ name: "read_file", result: "from config" }],
      configSlot: "config",
    });
    expect(handlerRan).toBe(false);
    expect((result as ToolMessage).content).toBe("from config");
  });

  it("falls through to the handler when no mock matches", async () => {
    const noMocks = await call({ name: "read_file", mocks: [] });
    expect(noMocks.handlerRan).toBe(true);
    expect(noMocks.result).toBe("HANDLER_RAN");
  });
});

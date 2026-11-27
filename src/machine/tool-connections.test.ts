import { describe, expect, it } from "vitest";

import { decide } from "../kernel/kernel.js";
import { WorkflowMachine } from "./machine.js";
import { ToolConnectionsError, connectionOf, resolveToolConnections } from "./tool-connections.js";
import type { MachineSpec } from "./types.js";

const DECLARED = resolveToolConnections({ rest__request: "connection", send_email: "connection" });

/** A workflow whose `lookup` state grants `rest__request` and `send_email` as `allow` says. */
function machine(
  allow: NonNullable<NonNullable<MachineSpec["states"][string]["tools"]>["allow"]>,
  root: MachineSpec["tools"] = {},
): WorkflowMachine {
  return WorkflowMachine.fromSpec(
    {
      tools: root,
      states: {
        lookup: { triggers: { manual: null }, tools: { allow }, transitions: [{ to: "done", description: "Found." }] },
        done: {},
      },
    },
    undefined,
    undefined,
    DECLARED,
  );
}

const call = (m: WorkflowMachine, tool: string, args: Record<string, unknown>) =>
  decide(m, { kind: "tool-call", state: "lookup", tool, args });

const TWO_APIS = [
  { tool: "rest__request", connection: "nominatim" },
  { tool: "rest__request", connection: "zaepflefinder" },
];

describe("resolveToolConnections", () => {
  it("takes a host tool and the argument it takes its connection in", () => {
    expect([...resolveToolConnections({ rest__request: "connection" })]).toEqual([["rest__request", "connection"]]);
    expect(resolveToolConnections(undefined).size).toBe(0);
  });

  it("refuses the runtime's own tools and an empty argument", () => {
    expect(() => resolveToolConnections({ read_file: "connection" })).toThrow(ToolConnectionsError);
    expect(() => resolveToolConnections({ copy_file: "connection" })).toThrow(ToolConnectionsError);
    expect(() => resolveToolConnections({ archmax_lookup: "connection" })).toThrow(ToolConnectionsError);
    expect(() => resolveToolConnections({ task: "connection" })).toThrow(ToolConnectionsError);
    expect(() => resolveToolConnections({ rest__request: " " })).toThrow(ToolConnectionsError);
  });

  it("reads a call's connection, an empty one being none", () => {
    expect(connectionOf({ connection: "a" }, "connection")).toBe("a");
    expect(connectionOf({ connection: "" }, "connection")).toBeUndefined();
    expect(connectionOf({}, "connection")).toBeUndefined();
  });
});

describe("a tool granted through several connections", () => {
  it("admits a call through each connection an entry names, and no other", () => {
    const m = machine(TWO_APIS);
    expect(call(m, "rest__request", { connection: "zaepflefinder", path: "" }).decision).toBe("allow");
    expect(call(m, "rest__request", { connection: "nominatim", path: "search" }).decision).toBe("allow");
    const other = call(m, "rest__request", { connection: "other", path: "" });
    expect(other.decision).toBe("block");
    expect(other.ruleId).toBe("tool.not-allowed");
    expect(other.reason).toContain("'rest__request' runs through 'nominatim', 'zaepflefinder' in 'lookup', not 'other'.");
  });

  it("binds each entry's guards to its own connection", () => {
    const m = machine([
      { tool: "send_email", connection: "support", args: { to: ["*@acme.example"] } },
      { tool: "send_email", connection: "sales" },
    ]);
    expect(call(m, "send_email", { connection: "support", to: "someone@other.example" }).decision).toBe("block");
    expect(call(m, "send_email", { connection: "support", to: "ann@acme.example" }).decision).toBe("allow");
    expect(call(m, "send_email", { connection: "sales", to: "someone@other.example" }).decision).toBe("allow");
  });

  it("refuses a call leaving the connection out where the state grants two, naming them", () => {
    const m = machine(TWO_APIS);
    expect(m.withConnection("lookup", "rest__request", { path: "" })).toEqual({ path: "" });
    const verdict = call(m, "rest__request", { path: "" });
    expect(verdict.decision).toBe("block");
    expect(verdict.reason).toContain(
      "'rest__request' runs through 'nominatim', 'zaepflefinder' in 'lookup': name one in its 'connection' argument.",
    );
  });

  it("discloses each connection beside the entry's guards", () => {
    const m = machine([...TWO_APIS, { tool: "send_email", connection: "support", args: { to: ["*@acme.example"] } }]);
    expect(m.describeAllowed("lookup")).toContain(
      "rest__request(connection=nominatim), rest__request(connection=zaepflefinder), send_email(connection=support, to=*@acme.example)",
    );
    expect(m.grantedConnections("lookup", "rest__request")).toEqual(["nominatim", "zaepflefinder"]);
  });
});

describe("a call leaving its connection out", () => {
  it("runs through the state's one connection", () => {
    const m = machine([{ tool: "rest__request", connection: "nominatim" }]);
    const args = m.withConnection("lookup", "rest__request", { path: "search" });
    expect(args).toEqual({ path: "search", connection: "nominatim" });
    expect(call(m, "rest__request", args).decision).toBe("allow");
  });

  it("goes on as it stands where the state's entry names none, which admits only a call naming none", () => {
    const m = machine(["rest__request"]);
    expect(m.withConnection("lookup", "rest__request", { path: "" })).toEqual({ path: "" });
    expect(call(m, "rest__request", { path: "" }).decision).toBe("allow");
    expect(call(m, "rest__request", { connection: "nominatim", path: "" }).decision).toBe("block");
  });

  it("is not set where an entry names none beside one naming a connection", () => {
    const m = machine(["rest__request", { tool: "rest__request", connection: "nominatim" }]);
    expect(m.withConnection("lookup", "rest__request", { path: "" })).toEqual({ path: "" });
  });
});

describe("a denial of one connection", () => {
  it("denies only the calls through it, and leaves the tool disclosed", () => {
    const m = machine(
      [
        { tool: "send_email", connection: "personal" },
        { tool: "send_email", connection: "sales" },
      ],
      { forbid_always: [{ tool: "send_email", connection: "personal" }] },
    );
    const denied = call(m, "send_email", { connection: "personal" });
    expect(denied.decision).toBe("block");
    expect(denied.ruleId).toBe("tool.forbidden");
    expect(denied.reason).toContain("tools.forbid_always: connection=personal");
    expect(call(m, "send_email", { connection: "sales" }).decision).toBe("allow");
    expect(m.disclosedTools("lookup").has("send_email")).toBe(true);
  });

  it("a wildcard naming a connection denies it on every tool that takes one, and nothing else", () => {
    const m = machine([{ tool: "send_email", connection: "personal" }, "lookup_order"], {
      forbid_always: [{ tool: "*", connection: "personal" }],
    });
    expect(call(m, "send_email", { connection: "personal" }).decision).toBe("block");
    expect(call(m, "lookup_order", {}).decision).toBe("allow");
    expect(m.disclosedTools("lookup").has("lookup_order")).toBe(true);
  });

  it("a bare denial still denies the tool through every connection", () => {
    const m = machine(TWO_APIS, { forbid_always: ["rest__request"] });
    expect(call(m, "rest__request", { connection: "nominatim" }).decision).toBe("block");
    expect(m.disclosedTools("lookup").has("rest__request")).toBe(false);
  });
});

describe("an undeclared tool", () => {
  it("ignores an entry's connection, as before", () => {
    const m = WorkflowMachine.fromSpec({
      tools: { forbid_always: [{ tool: "lookup", connection: "crm" }] },
      states: {
        open: { triggers: { manual: null }, tools: { allow: [{ tool: "lookup_order", connection: "crm" }] } },
      },
    });
    expect(m.withConnection("open", "lookup_order", {})).toEqual({});
    expect(decide(m, { kind: "tool-call", state: "open", tool: "lookup_order", args: { connection: "x" } }).decision).toBe("allow");
    expect(m.describeAllowed("open")).toContain("lookup_order");
    expect(m.describeAllowed("open")).not.toContain("connection=");
  });
});

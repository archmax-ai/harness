import { describe, expect, it } from "vitest";
import { WorkflowMachine } from "./machine.js";
import { lintSpec } from "./lint-spec.js";
import { parseMachineSpec } from "./spec-schema.js";
import { parseSessionPath, resolveSessionId, sessionIdForTrigger, stateTriggerIds, triggerBindings } from "./triggers.js";
import type { MachineSpec } from "./types.js";

/** The schema issues one trigger declaration produces, as messages. */
const declarationIssues = (decl: unknown): string[] => {
  const result = parseMachineSpec({ states: { a: { triggers: { t: decl } } } });
  return result.ok ? [] : result.issues.map((issue) => `${issue.path}: ${issue.message}`);
};

const SPEC: MachineSpec = {
  states: {
    // `intake` asks its question and parks itself with `archmax_wait`; a delivered
    // reply resumes it there, so nothing in the spec names a resume trigger.
    intake: {
      triggers: {
        email_received: { session: "triggers.-1.conversationId" },
        email_reply: { session: "triggers.-1.conversationId" },
      },
      transitions: [{ to: "answer", description: "Test edge to answer." }],
    },
    answer: { triggers: { chat_message: { session: "chat.thread_id" } } },
  },
};

/** A firing's variables are a plain `name → value` map — the shape a host supplies. */
const vars = (values: Record<string, unknown>): Record<string, unknown> => values;

describe("parseSessionPath", () => {
  it("parses a bare variable name", () => {
    expect(parseSessionPath("conversation_id").path).toEqual({
      raw: "conversation_id",
      name: "conversation_id",
      path: [],
    });
  });

  it("parses a dotted path with a negative index", () => {
    expect(parseSessionPath("triggers.-1.conversationId").path).toEqual({
      raw: "triggers.-1.conversationId",
      name: "triggers",
      path: ["-1", "conversationId"],
    });
  });

  it("rejects a ${{…}}-wrapped value so there is one spelling", () => {
    expect(parseSessionPath("${{conversation_id}}").error).toContain("write the bare path");
  });

  it("rejects shapes that cannot name a variable", () => {
    expect(parseSessionPath("").error).toContain("empty");
    expect(parseSessionPath("Conversation.id").error).toContain("first segment must be a variable name");
    expect(parseSessionPath("triggers..id").error).toContain("empty segment");
  });
});

describe("resolveSessionId", () => {
  const path = parseSessionPath("triggers.-1.conversationId").path!;

  it("reads the newest arrival through a negative index", () => {
    const store = vars({
      triggers: [{ conversationId: "AAQk1" }, { conversationId: "AAQk2" }],
    });
    expect(resolveSessionId(path, store)).toBe("AAQk2");
  });

  it("stringifies a numeric id", () => {
    expect(resolveSessionId(parseSessionPath("case_id").path!, vars({ case_id: 42 }))).toBe("42");
  });

  it("misses rather than guessing", () => {
    expect(resolveSessionId(path, vars({}))).toBeUndefined();
    expect(resolveSessionId(path, vars({ triggers: [] }))).toBeUndefined();
    // A structured value cannot name a conversation.
    expect(resolveSessionId(parseSessionPath("obj").path!, vars({ obj: { a: 1 } }))).toBeUndefined();
    expect(resolveSessionId(parseSessionPath("blank").path!, vars({ blank: "  " }))).toBeUndefined();
  });

  it("reads own properties only", () => {
    expect(
      resolveSessionId(parseSessionPath("obj.constructor").path!, vars({ obj: {} })),
    ).toBeUndefined();
  });
});

describe("stateTriggerIds", () => {
  it("reads the mapping's keys, in declaration order", () => {
    expect(
      stateTriggerIds({ triggers: { manual: null, "email-received": { session: "conversation_id" } } }),
    ).toEqual(["manual", "email-received"]);
  });

  // The id is authored, not positional: a host keys deployments on it, so
  // deleting a sibling must not move it.
  it("keeps every id when a sibling entry is deleted", () => {
    expect(stateTriggerIds({ triggers: { "outlook-mail": null, "slack-message": null } })).toEqual([
      "outlook-mail",
      "slack-message",
    ]);
    expect(stateTriggerIds({ triggers: { "slack-message": null } })).toEqual(["slack-message"]);
  });

  it("yields nothing for a state that declares no trigger", () => {
    expect(stateTriggerIds({})).toEqual([]);
    expect(stateTriggerIds({ triggers: {} })).toEqual([]);
  });
});

describe("a state's trigger declaration (schema)", () => {
  const issues = (triggers: unknown): string[] => {
    const result = parseMachineSpec({
      states: { intake: { triggers, transitions: [{ to: "done", description: "Test edge to done." }] }, done: {} },
    });
    return result.ok ? [] : result.issues.map((issue) => `${issue.path}: ${issue.message}`);
  };

  it("reports nothing for an id alone, however it is spelled", () => {
    expect(issues({ manual: null })).toEqual([]);
    expect(issues({ manual: {} })).toEqual([]);
  });

  it("reports nothing for several ids on one state", () => {
    expect(issues({ manual: null, "email-received": { session: "conversation_id" } })).toEqual([]);
  });

  it("reports a declaration that is not a mapping", () => {
    expect(issues({ manual: "yes" }).join("\n")).toContain("Invalid input");
    expect(issues([]).join("\n")).toContain("must be a mapping of trigger id to its declaration");
    expect(issues("manual").join("\n")).toContain("must be a mapping of trigger id to its declaration");
  });

  it("reports an empty trigger id", () => {
    expect(issues({ "": null }).join("\n")).toContain("must be a mapping of trigger id");
  });

  // A mapping cannot repeat a key, so the only duplicate left is two states
  // claiming one id — a document-level rule, not a shape one.
  it("reports one id claimed by two states, naming both", () => {
    const result = parseMachineSpec({
      states: { a: { triggers: { manual: null } }, b: { triggers: { manual: null } } },
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.map((i) => i.message).join("\n")).toContain(
      "Multiple states declare trigger 'manual' (a, b)",
    );
  });

  it("reports a workflow with no start state at all", () => {
    const result = parseMachineSpec({ states: { a: {}, b: {} } });
    expect(!result.ok && result.issues.map((i) => i.message).join("\n")).toContain(
      "Workflow has no start state",
    );
  });
});

// The two keys a loose declaration refuses rather than preserves: both would be
// wiring, and swallowing either would start a run somewhere the author did not say.
describe("refused declaration keys", () => {
  it("refuses 'entry', pointing at the state the declaration sits on", () => {
    const [message] = declarationIssues({ entry: "somewhere" });
    expect(message).toContain("states.a.triggers.t.entry");
    expect(message).toContain("IS its entry state");
  });

  it("refuses 'name', pointing at the key the declaration sits under", () => {
    const [message] = declarationIssues({ name: "slack-message" });
    expect(message).toContain("states.a.triggers.t.name");
    expect(message).toContain("IS the trigger id");
  });

  it("refuses either beside otherwise valid keys", () => {
    expect(declarationIssues({ session: "conversation_id", entry: "a" })).toHaveLength(1);
  });

  // `manual` needs no reserved-id rule of its own now: it is declared the way
  // every other trigger is, and one state claiming it twice is impossible.
  it("declares the reserved id like any other", () => {
    expect(declarationIssues({})).toEqual([]);
    expect(parseMachineSpec({ states: { a: { triggers: { manual: null } } } }).ok).toBe(true);
  });
});

describe("triggerBindings", () => {
  it("binds every id to the state that declares it", () => {
    const bindings = triggerBindings({
      states: { intake: { triggers: { manual: null } }, triage: { triggers: { chat_message: null } } },
    });
    expect(bindings.get("manual")?.entry).toBe("intake");
    expect(bindings.get("chat_message")?.entry).toBe("triage");
  });

  it("binds every id one state declares to that state", () => {
    const bindings = triggerBindings({
      states: { intake: { triggers: { manual: null, "email-received": null } }, answer: {} },
    });
    expect(bindings.get("manual")?.entry).toBe("intake");
    expect(bindings.get("email-received")?.entry).toBe("intake");
  });

  it("reads the declaration beside the entry", () => {
    const bindings = triggerBindings({
      states: {
        intake: { triggers: { manual: null, "email-received": { session: "triggers.-1.conversationId" } } },
      },
    });
    expect(bindings.get("email-received")?.entry).toBe("intake");
    expect(bindings.get("email-received")?.session?.name).toBe("triggers");
    expect(bindings.get("manual")?.session).toBeUndefined();
  });

  it("rejects a malformed session path at the schema, naming the trigger", () => {
    expect(declarationIssues({ session: "${{x}}" })).toEqual([
      "states.a.triggers.t.session: write the bare path, not a '${{…}}' reference (e.g. 'conversation_id').",
    ]);
  });
});

describe("declaration shape", () => {
  it("accepts a null declaration and rejects a scalar one", () => {
    expect(parseMachineSpec(SPEC).ok).toBe(true);
    expect(parseMachineSpec({ states: { a: { triggers: { manual: null } } } }).ok).toBe(true);
    expect(parseMachineSpec({ states: { a: { triggers: { manual: 5 } } } }).ok).toBe(false);
  });

  it("warns on a key the schema does not define, and still loads", () => {
    const spec: MachineSpec = {
      states: { a: { triggers: { t: { args: {} } as never, manual: null } } },
    };
    expect(parseMachineSpec(spec).ok).toBe(true);
    const messages = lintSpec(spec)
      .filter((d) => d.field === "states.a.triggers.t")
      .map((d) => d.message);
    expect(messages.join("\n")).toContain("declares unknown key 'args', which the SDK ignores");
  });

  it("does not warn about the host-resolved keys", () => {
    const spec: MachineSpec = {
      states: { a: { triggers: { t: { message: "triggers.-1.text", connection: "acme-oidc" } } } },
    };
    expect(lintSpec(spec).filter((d) => d.field === "states.a.triggers.t")).toEqual([]);
  });

  // Nothing is left to warn about an orphaned declaration: writing one is what
  // makes its state a start state.
  it("does not warn about a declaration that says nothing", () => {
    const spec: MachineSpec = { states: { a: { triggers: { manual: null } } } };
    expect(lintSpec(spec).filter((d) => d.field?.includes("triggers"))).toEqual([]);
  });
});

// The SDK stores and hands back `message`/`connection` without acting on either:
// what is under test is that they parse, survive, and stay distinguishable.
describe("host-resolved declaration keys", () => {
  const bind = (decl: Record<string, unknown>) =>
    triggerBindings({ states: { a: { triggers: { t: decl as never } } } });

  it("parses a message path with the session grammar", () => {
    expect(bind({ message: "triggers.-1.body.content" }).get("t")?.message).toEqual({
      raw: "triggers.-1.body.content",
      name: "triggers",
      path: ["-1", "body", "content"],
    });
  });

  // `false` is a declaration, not a missing one: the host reads it as "firings of
  // this trigger carry no message", which an absent key does not say.
  it("keeps message: false distinct from an undeclared message", () => {
    expect(bind({ message: false }).get("t")?.message).toBe(false);
    expect(bind({ session: "conversation_id" }).get("t")?.message).toBeUndefined();
  });

  it("rejects a malformed message path with the session path's wording", () => {
    expect(declarationIssues({ message: "${{triggers.-1.text}}" }).join("\n")).toContain(
      "states.a.triggers.t.message: write the bare path",
    );
    expect(declarationIssues({ message: "triggers..text" }).join("\n")).toContain("empty segment");
    expect(declarationIssues({ message: "Triggers.text" }).join("\n")).toContain(
      "first segment must be a variable name",
    );
    expect(declarationIssues({ message: 5 }).join("\n")).toContain(
      "states.a.triggers.t.message: must be a dotted path string",
    );
  });

  it("keeps a connection slug verbatim and rejects a non-slug", () => {
    expect(bind({ connection: " acme-oidc " }).get("t")?.connection).toBe("acme-oidc");
    expect(declarationIssues({ connection: "" }).join("\n")).toContain(
      "states.a.triggers.t.connection: must be a non-empty string naming an access connection",
    );
    expect(declarationIssues({ connection: 5 }).join("\n")).toContain("states.a.triggers.t.connection");
  });

  it("exposes both keys on the loaded machine beside the session path", () => {
    const machine = WorkflowMachine.fromSpec({
      states: {
        intake: {
          triggers: {
            chat: {
              session: "triggers.-1.threadId",
              message: "triggers.-1.text",
              connection: "acme-oidc",
            },
            ticket_reopened: { message: false },
          },
          transitions: [{ to: "answer", description: "Test edge to answer." }],
        },
        answer: {},
      },
    });
    expect(machine.sessionPathForTrigger("chat")?.path).toEqual(["-1", "threadId"]);
    expect((machine.messagePathForTrigger("chat") as { raw: string }).raw).toBe(
      "triggers.-1.text",
    );
    expect(machine.connectionForTrigger("chat")).toBe("acme-oidc");
    expect(machine.startStateForTrigger("chat")).toBe("intake");
    expect(machine.messagePathForTrigger("ticket_reopened")).toBe(false);
    expect(machine.connectionForTrigger("ticket_reopened")).toBeUndefined();
    expect(machine.messagePathForTrigger("unknown")).toBeUndefined();
    expect(machine.connectionForTrigger("unknown")).toBeUndefined();
  });
});

describe("WorkflowMachine trigger metadata", () => {
  const machine = WorkflowMachine.fromSpec(SPEC);

  it("enters the state a trigger is declared on", () => {
    expect(machine.startStateForTrigger("email_received")).toBe("intake");
    expect(machine.startStateForTrigger("email_reply")).toBe("intake");
    expect(machine.startStateForTrigger("chat_message")).toBe("answer");
  });

  it("exposes a trigger's session path", () => {
    expect(machine.sessionPathForTrigger("email_received")?.name).toBe("triggers");
    expect(machine.sessionPathForTrigger("chat_message")?.path).toEqual(["thread_id"]);
    expect(machine.sessionPathForTrigger("unknown")).toBeUndefined();
  });

  // A trigger the spec never mentions is still deliverable into a park — the
  // caller names the session it belongs to.
  it("reports no start state for an id no state declares", () => {
    expect(machine.startStateForTrigger("ticket_closed")).toBeUndefined();
  });
});

describe("trigger signature", () => {
  const signed: MachineSpec = {
    states: {
      enrich: {
        triggers: {
          "sub-workflow": { requires: ["order_id"], returns: ["enrichment_file", "delayed"] },
        },
      },
    },
  };

  it("parses both halves and exposes them on the machine", () => {
    const machine = WorkflowMachine.fromSpec(signed);
    expect(machine.requiresForTrigger("sub-workflow")).toEqual(["order_id"]);
    expect(machine.returnsForTrigger("sub-workflow")).toEqual(["enrichment_file", "delayed"]);
    expect(parseMachineSpec(signed).ok).toBe(true);
  });

  it("reports nothing for a trigger declaring no signature", () => {
    const machine = WorkflowMachine.fromSpec(SPEC);
    expect(machine.requiresForTrigger("email_received")).toBeUndefined();
    expect(machine.returnsForTrigger("email_received")).toBeUndefined();
    expect(machine.returnsForTrigger("unknown")).toBeUndefined();
  });

  // The signature is per trigger, not per workflow: a machine reachable from a
  // host trigger and by delegation owes each caller only what it told that one.
  it("binds a signature to its own trigger", () => {
    const machine = WorkflowMachine.fromSpec({
      states: {
        enrich: {
          triggers: { "sub-workflow": { returns: ["enrichment_file"] }, manual: null },
        },
      },
    });
    expect(machine.returnsForTrigger("sub-workflow")).toEqual(["enrichment_file"]);
    expect(machine.returnsForTrigger("manual")).toBeUndefined();
  });

  it("neither key is an unknown key", () => {
    expect(lintSpec(signed).filter((d) => d.field?.includes("triggers"))).toEqual([]);
  });

  it.each([
    ["a non-list requires", { requires: "order_id" }, "states.a.triggers.t.requires: must be a list of run-variable names"],
    ["a non-list returns", { returns: { a: "b" } }, "states.a.triggers.t.returns: must be a list of run-variable names"],
    ["an invalid requires name", { requires: ["Order Id"] }, "states.a.triggers.t.requires.0: 'Order Id' is not a valid run-variable name"],
    ["an invalid returns name", { returns: ["Order Summary"] }, "states.a.triggers.t.returns.0: 'Order Summary' is not a valid run-variable name"],
    ["a non-string entry", { returns: [5] }, "states.a.triggers.t.returns.0: '5' is not a valid run-variable name"],
    ["a duplicate requires entry", { requires: ["a", "a"] }, "states.a.triggers.t.requires.1: 'a' is listed more than once"],
    ["a duplicate returns entry", { returns: ["risk", "risk"] }, "states.a.triggers.t.returns.1: 'risk' is listed more than once"],
    ["the reserved trigger variable", { returns: ["trigger"] }, "states.a.triggers.t.returns.0: 'trigger' is the built-in trigger variable"],
    ["the reserved title variable", { returns: ["title"] }, "states.a.triggers.t.returns.0: 'title' is the built-in title variable"],
  ])("rejects %s", (_label, decl, expected) => {
    const issues = declarationIssues(decl);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain(expected);
  });

  // `trigger` is only refused as a *return*: a firing may well be required to
  // supply it, and the harness always does.
  it("accepts the trigger variable in requires", () => {
    expect(declarationIssues({ requires: ["trigger"] })).toEqual([]);
  });

  // Same shape for `title`, for its own reason: handing a run an opening label is
  // meaningful, returning one would rename the caller's task.
  it("accepts the title variable in requires", () => {
    expect(declarationIssues({ requires: ["title"] })).toEqual([]);
  });

  it("explains a returned title in its own terms, not the trigger's", () => {
    const [message] = declarationIssues({ returns: ["title"] });
    expect(message).toContain("title");
    expect(message).toContain("rename");
    expect(message).not.toContain("locked");
  });
});

describe("sessionIdForTrigger", () => {
  const spec: MachineSpec = {
    states: {
      start: {
        triggers: {
          manual: null,
          email: { session: "triggers.-1.conversationId" },
          bare: { session: "case_id" },
        },
      },
    },
  };

  it("resolves a declared session path against a firing's variables", () => {
    expect(
      sessionIdForTrigger(spec, "email", { triggers: [{ conversationId: "A1" }, { conversationId: "A2" }] }),
    ).toBe("A2");
    expect(sessionIdForTrigger(spec, "bare", { case_id: 42 })).toBe("42");
  });

  it("is undefined when the runtime would mint an id instead", () => {
    // No `session:` on the trigger, an undeclared trigger, a path that misses.
    expect(sessionIdForTrigger(spec, "manual", { case_id: 1 })).toBeUndefined();
    expect(sessionIdForTrigger(spec, "unknown", { case_id: 1 })).toBeUndefined();
    expect(sessionIdForTrigger(spec, "email", { triggers: [] })).toBeUndefined();
  });
});

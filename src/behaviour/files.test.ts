/**
 * The `file` signature type at the session boundary: a `file` value names a
 * path from the workspace root, and wherever it crosses a boundary — the start
 * of a session, the agent's own write of a return, completion — it must name a
 * file the session holds and may read on runtime authority.
 */
import { afterEach, describe, expect, it } from "vitest";
import { InvalidTurnFileError } from "../index.js";
import {
  advanceTo,
  assemble,
  cleanupWorkspaces,
  eventsOf,
  toolResults,
  turn,
  workspaceWith,
} from "./support.js";

afterEach(cleanupWorkspaces);

const RUNTIME = { engine: "archmax-harness", version: "3" };

/** One start state on `manual` with the given declaration, finishing in `done`. */
const fileSpec = (manual: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  runtime: RUNTIME,
  ...extra,
  states: {
    start: { triggers: { manual }, transitions: [{ to: "done", description: "Test edge to done." }] },
    done: {},
  },
});

const INVOICE = { requires: [{ name: "invoice", type: "file" }] };
const REPORT = { returns: [{ name: "report", type: "file" }] };
const setVars = (variables: Record<string, unknown>) => ({ tool: "archmax_set_variables", args: { variables } });
const write = (file_path: string, content: string) => ({ tool: "write_file", args: { file_path, content } });

describe("a file input at the start of a session", () => {
  it("refuses a seed naming no file, before any model call", async () => {
    const { agent, model } = await assemble(workspaceWith(fileSpec(INVOICE)), { turns: [{ reply: "never" }] });
    const outcome = await agent.workflow.send("s1", {
      message: "go",
      variables: { invoice: "scratchpad/attachments/invoice.pdf" },
    });
    expect(model.calls).toHaveLength(0);
    expect(outcome).toMatchObject({ kind: "rejected", status: "rejected" });
    expect(outcome.rejected).toContain(
      "'invoice' must name a file, but nothing is at 'scratchpad/attachments/invoice.pdf'",
    );
  });

  it("starts once the file is in the session", async () => {
    const { agent, store, model } = await assemble(workspaceWith(fileSpec(INVOICE)), {
      turns: [advanceTo("done"), { reply: "ok" }],
    });
    await store.backend.write("/s1/scratchpad/attachments/invoice.txt", "Invoice 42");
    const outcome = await agent.workflow.send("s1", {
      message: "go",
      variables: { invoice: "/scratchpad/attachments/invoice.txt" },
    });
    expect(model.calls.length).toBeGreaterThan(0);
    expect(outcome.kind).toBe("completed");
  });

  it("takes an authored file the workspace mounts", async () => {
    const { agent } = await assemble(
      workspaceWith(fileSpec({ requires: [{ name: "template", type: "file" }] }), {
        "skills/billing/SKILL.md": "---\nname: billing\ndescription: Billing.\n---\n\nBilling.\n",
        "skills/billing/assets/template.txt": "Dear customer,",
      }),
      { turns: [advanceTo("done"), { reply: "ok" }] },
    );
    const outcome = await agent.workflow.send("s1", {
      message: "go",
      variables: { template: "skills/billing/assets/template.txt" },
    });
    expect(outcome.kind).toBe("completed");
  });

  it("refuses a file under a mount the workflow forbids, and a runtime-internal path", async () => {
    const spec = fileSpec({ requires: [{ name: "template", type: "file" }] }, { skills: { forbid_always: ["billing"] } });
    const files = {
      "skills/billing/SKILL.md": "---\nname: billing\ndescription: Billing.\n---\n\nBilling.\n",
      "skills/billing/assets/template.txt": "Dear customer,",
    };
    const forbidden = await assemble(workspaceWith(spec, files), { turns: [{ reply: "never" }] });
    const refused = await forbidden.agent.workflow.send("s1", {
      message: "go",
      variables: { template: "skills/billing/assets/template.txt" },
    });
    expect(refused.kind).toBe("rejected");
    expect(refused.rejected).toContain("'template' names 'skills/billing/assets/template.txt', which this session may not read");

    const internal = await assemble(workspaceWith(fileSpec({ requires: [{ name: "template", type: "file" }] })), {
      turns: [{ reply: "never" }],
    });
    const outcome = await internal.agent.workflow.send("s2", { message: "go", variables: { template: "checkpoints/x.json" } });
    expect(outcome.kind).toBe("rejected");
    expect(outcome.rejected).toContain("which this session may not read");
  });
});

describe("a file return", () => {
  it("refuses the agent's write naming no file, then takes it once the file is written", async () => {
    const { agent, events } = await assemble(workspaceWith(fileSpec(REPORT)), {
      turns: [
        setVars({ report: "scratchpad/report.md" }),
        write("scratchpad/report.md", "# Report"),
        setVars({ report: "scratchpad/report.md" }),
        advanceTo("done"),
        { reply: "ok" },
      ],
    });
    const { messages } = await turn(agent, "s1", "go");
    const [refusal, accepted] = toolResults(messages).filter((r) => r.name === "archmax_set_variables");
    expect(refusal?.status).toBe("error");
    expect(refusal?.content).toContain("trigger 'manual' declares this return as a file");
    expect(refusal?.content).toContain("nothing is at 'scratchpad/report.md'");
    expect(refusal?.content).toContain("Nothing was written.");
    expect(accepted?.status).not.toBe("error");
    expect(eventsOf(events, "variables-set")).toMatchObject([{ names: ["report"] }]);
    expect((await agent.sessions.get("s1"))?.status).toBe("completed");
  });

  it("rejects a completion whose file return names a file that is gone", async () => {
    const { agent } = await assemble(workspaceWith(fileSpec(REPORT)), {
      turns: [
        write("scratchpad/report.md", "# Report"),
        setVars({ report: "scratchpad/report.md" }),
        { tool: "remove_file", args: { file_path: "scratchpad/report.md" } },
        advanceTo("done"),
        { reply: "ok" },
      ],
    });
    const outcome = await agent.workflow.send("s1", { message: "go" });
    expect(outcome.kind).toBe("rejected");
    expect(outcome.rejected).toContain("state 'done'");
    expect(outcome.rejected).toContain("'report' must name a file, but nothing is at 'scratchpad/report.md'");
  });
});

describe("files a host hands a turn", () => {
  const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0xff, 0xfe, 0x00, 0x80, 0x0a]);
  async function bytesAt(store: import("../index.js").SessionStore, path: string) {
    const [res] = await store.backend.downloadFiles!([path]);
    return res?.content ?? undefined;
  }

  it("places each file and seeds its variable with the path, satisfying a file input", async () => {
    const { agent, store } = await assemble(workspaceWith(fileSpec(INVOICE)), {
      turns: [advanceTo("done"), { reply: "ok" }],
    });
    const outcome = await agent.workflow.send("s1", {
      message: "reconcile",
      files: { invoice: { name: "invoice.pdf", content: PDF } },
    });
    expect(outcome.kind).toBe("completed");
    expect(await bytesAt(store, "/s1/scratchpad/attachments/invoice.pdf")).toEqual(PDF);
    expect((await agent.sessions.get("s1"))?.variables?.invoice).toEqual({
      value: "scratchpad/attachments/invoice.pdf",
      locked: true,
    });
  });

  it("never overwrites: a later turn's file of the same name takes the next suffix", async () => {
    const { agent, model, store } = await assemble(workspaceWith(fileSpec(INVOICE)), {
      turns: [advanceTo("done"), { reply: "first" }],
    });
    await agent.workflow.send("s1", { message: "one", files: { invoice: { name: "invoice.pdf", content: PDF } } });
    model.enqueue(advanceTo("done"), { reply: "second" });
    const second = new TextEncoder().encode("second invoice");
    await agent.workflow.send("s1", { message: "two", files: { invoice: { name: "invoice.pdf", content: second } } });
    expect(await bytesAt(store, "/s1/scratchpad/attachments/invoice.pdf")).toEqual(PDF);
    expect(await bytesAt(store, "/s1/scratchpad/attachments/invoice-1.pdf")).toEqual(second);
    expect((await agent.sessions.get("s1"))?.variables?.invoice?.value).toBe("scratchpad/attachments/invoice-1.pdf");
  });

  it("refuses a name that is not one plain file name, and a variable given twice, writing nothing", async () => {
    const { agent, model } = await assemble(workspaceWith(fileSpec(INVOICE)), { turns: [{ reply: "never" }] });
    for (const name of ["../invoice.pdf", "a/b.pdf", "..", ""]) {
      await expect(
        agent.workflow.send("s1", { message: "go", files: { invoice: { name, content: PDF } } }),
      ).rejects.toThrow(InvalidTurnFileError);
    }
    await expect(
      agent.workflow.send("s1", {
        message: "go",
        variables: { invoice: "scratchpad/x.pdf" },
        files: { invoice: { name: "invoice.pdf", content: PDF } },
      }),
    ).rejects.toThrow(/both 'files' and 'variables'/);
    expect(model.calls).toHaveLength(0);
    expect(await agent.sessions.get("s1")).toBeNull();
  });
});

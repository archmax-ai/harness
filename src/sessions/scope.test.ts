import { describe, expect, it } from "vitest";
import {
  childSessionId,
  dispatchIdOf,
  isChildSessionOf,
  parentSessionIdOf,
  childRunConfig,
  releaseScopes,
  rootSessionIdOf,
  sessionScopeFrom,
  subWorkflowChain,
  SUB_WORKFLOW_CHAIN_KEY,
  SUB_WORKFLOW_DISPATCH_KEY,
} from "./scope.js";

const sessionIdOf = (config: Parameters<typeof sessionScopeFrom>[0], fallback: string) =>
  sessionScopeFrom(config, fallback).sessionId;

describe("run scope at the top level", () => {
  it("is the bare session id", () => {
    const config = { configurable: { thread_id: "session-7" } };
    expect(sessionIdOf(config, "__default__")).toBe("session-7");
  });

  it("falls back to the caller's own default when no thread_id is present", () => {
    expect(sessionIdOf(undefined, "__default__")).toBe("__default__");
    expect(sessionIdOf({ configurable: {} }, "default")).toBe("default");
  });

  it("ignores the per-node checkpoint namespace LangGraph rewrites each super-step", () => {
    // LangGraph sets `checkpoint_ns` to `<node>:<task-uuid>` inside every node and
    // changes it between super-steps. Keying on it would shatter a run's REPL.
    const a = { configurable: { thread_id: "s", checkpoint_ns: "nodeA:0d1c" } };
    const b = { configurable: { thread_id: "s", checkpoint_ns: "nodeB:9f22" } };
    expect(sessionIdOf(a, "d")).toBe("s");
    expect(sessionIdOf(b, "d")).toBe("s");
  });

  it("reports no depth and an empty chain", () => {
    const scope = sessionScopeFrom({ configurable: { thread_id: "s" } }, "d");
    expect(scope.depth).toBe(0);
    expect(scope.chain).toEqual([]);
    expect(scope.dispatchId).toBeUndefined();
  });
});

describe("run scope inside a sub-run", () => {
  const parent = { configurable: { thread_id: "session-7", checkpoint_ns: "enrich:ab12" } };

  it("gives the child its own session, recording the parent's", () => {
    const child = childRunConfig(parent, {
      identity: "1",
      workflow: "enrich-account",
      dispatchId: "1",
    });
    // A child is a session in its own right — its own checkpoints, artifacts and
    // run zone — not a namespace nested under the caller's thread.
    expect(child.configurable?.thread_id).toBe("session-7~1");
    // No parent recorded beside the id: the id carries it, so there is one source.
    expect(parentSessionIdOf(child.configurable?.thread_id as string)).toBe("session-7");
    // The caller's namespace pins where inside *its* thread the caller is
    // running, so it must not travel to a thread that has never written it.
    expect(child.configurable?.checkpoint_ns).toBeUndefined();
    // The scope *is* the session now — no second name for it in `configurable`.
    expect(child.configurable?.archmax_run_scope).toBeUndefined();
    expect(child.configurable?.[SUB_WORKFLOW_CHAIN_KEY]).toEqual(["enrich-account"]);
    expect(child.configurable?.[SUB_WORKFLOW_DISPATCH_KEY]).toBe("1");
  });

  it("clears a pinned parent checkpoint id", () => {
    const pinned = { configurable: { ...parent.configurable, checkpoint_id: "cp-9" } };
    const child = childRunConfig(pinned, {
      identity: "1",
      workflow: "w",
      dispatchId: "1",
    });
    expect(child.configurable?.checkpoint_id).toBeUndefined();
  });

  it("is stable across the sub-run's nodes and super-steps", () => {
    const child = childRunConfig(parent, {
      identity: "1",
      workflow: "enrich-account",
      dispatchId: "1",
    });
    // Simulate LangGraph rewriting `checkpoint_ns` per node inside the child.
    const inNodeA = { configurable: { ...child.configurable, checkpoint_ns: "x|planNode:1" } };
    const inNodeB = { configurable: { ...child.configurable, checkpoint_ns: "x|doNode:2" } };
    expect(sessionIdOf(inNodeA, "d")).toBe(sessionIdOf(child, "d"));
    expect(sessionIdOf(inNodeB, "d")).toBe(sessionIdOf(child, "d"));
  });

  it("gives concurrently dispatched sub-runs distinct scopes", () => {
    const first = childRunConfig(parent, {
      identity: "1",
      workflow: "enrich-account",
      dispatchId: "1",
    });
    const second = childRunConfig(parent, {
      identity: "2",
      workflow: "enrich-account",
      dispatchId: "2",
    });
    expect(sessionIdOf(first, "d")).not.toBe(sessionIdOf(second, "d"));
    // Distinct sessions, so their checkpoints, artifacts and run zones are too.
    expect(first.configurable?.thread_id).not.toBe(second.configurable?.thread_id);
  });

  it("accumulates the dispatch chain and depth across nesting", () => {
    const child = childRunConfig(parent, {
      identity: "1",
      workflow: "b",
      dispatchId: "1",
    });
    const grandchild = childRunConfig(child, {
      identity: "1",
      workflow: "d",
      dispatchId: "1~1",
    });
    expect(subWorkflowChain(grandchild.configurable)).toEqual(["b", "d"]);
    expect(sessionScopeFrom(grandchild, "x").depth).toBe(2);
    expect(sessionScopeFrom(grandchild, "x").sessionId).toBe("session-7~1~1");
  });
});

describe("child session identity", () => {
  // Derived rather than minted at random, so a node replayed from its
  // checkpoint resolves each call to the same child — which is what lets a
  // resumed parent find the child it parked on.
  it("derives a stable id from the parent and the dispatch's number", () => {
    expect(childSessionId("session-7", 1)).toBe("session-7~1");
    expect(childSessionId("session-7", "2")).toBe("session-7~2");
    expect(childSessionId("session-7~1", 1)).toBe("session-7~1~1");
  });

  it("reads the parent back out of a child id", () => {
    expect(parentSessionIdOf("session-7~3")).toBe("session-7");
    expect(parentSessionIdOf("session-7~3~1")).toBe("session-7~3");
    expect(parentSessionIdOf("session-7")).toBeUndefined();
  });

  /**
   * The dispatch id is the child's path below the root: unique across one
   * turn's whole tree, where a bare number would name the root's first child
   * and that child's own first child alike.
   */
  it("names a dispatch by its path below the root session", () => {
    expect(rootSessionIdOf("session-7~3~1")).toBe("session-7");
    expect(rootSessionIdOf("session-7")).toBe("session-7");
    expect(dispatchIdOf("session-7~1")).toBe("1");
    expect(dispatchIdOf("session-7~1~1")).toBe("1~1");
    expect(dispatchIdOf("session-7~2")).not.toBe(dispatchIdOf("session-7~1~2"));
  });

  // The parent index is the id itself: enumerating a run's children is a prefix
  // scan, which cannot drift from what it indexes.
  it("recognizes a run's children, and only its own", () => {
    expect(isChildSessionOf("session-7~1", "session-7")).toBe(true);
    expect(isChildSessionOf("session-7~1~2", "session-7")).toBe(true);
    expect(isChildSessionOf("session-70~1", "session-7")).toBe(false);
    expect(isChildSessionOf("session-7", "session-7")).toBe(false);
  });

  /**
   * Only a dispatch number reads as a child: a number from 1, nothing else. A
   * host's own id holding `~` is refused at ingress (see `sessionIdRejection`),
   * and nothing else after a `~` is taken for a dispatch.
   */
  it("does not mistake a host's own separator for a dispatch", () => {
    expect(parentSessionIdOf("tenant~conversation")).toBeUndefined();
    expect(isChildSessionOf("tenant~conversation", "tenant")).toBe(false);
    expect(parentSessionIdOf("s~0")).toBeUndefined();
    expect(parentSessionIdOf("s~01")).toBeUndefined();
    expect(parentSessionIdOf("s~-1")).toBeUndefined();
  });

  /**
   * 0.5 minted `<parent>~<state>:<workflow>:<ordinal>`. Nothing mints it any
   * more, but a session parked on such a child resumes it under the identity
   * its park recorded, so the shape still reads as a child.
   */
  it("still reads a child id minted before dispatch numbers", () => {
    expect(parentSessionIdOf("s~node:workflow:0")).toBe("s");
    expect(isChildSessionOf("s~node:workflow:0~1", "s")).toBe(true);
    expect(parentSessionIdOf("s~node:workflow")).toBeUndefined();
    expect(parentSessionIdOf("s~node:workflow:first")).toBeUndefined();
  });
});

describe("session release", () => {
  it("sweeps a session and its child sessions, leaving other sessions alone", () => {
    const map = new Map<string, number>([
      ["s", 1],
      ["s~1", 2],
      ["s~2", 3],
      ["s~2~1", 7],
      ["s2", 6],
      ["other", 4],
      ["other~1", 5],
    ]);
    const released = releaseScopes(map, "s");
    expect(released.sort()).toEqual(["s", "s~1", "s~2", "s~2~1"]);
    expect([...map.keys()].sort()).toEqual(["other", "other~1", "s2"]);
  });

  it("is a no-op for a session with nothing held", () => {
    const map = new Map<string, number>([["other", 1]]);
    expect(releaseScopes(map, "s")).toEqual([]);
    expect(map.size).toBe(1);
  });
});

// A fixed clock: the point of the module is that the *result* is absolute, so a
// test that used the real clock would be asserting arithmetic it also performed.

/**
 * A child is a session, not storage of its caller.
 *
 * The parent index is the id itself — enumerating a run's children is a prefix
 * scan — so "which runs did this one dispatch" is answerable without a store read
 * and cannot drift from what it indexes.
 */
describe("a child run is enumerable from its parent", () => {
  const parent = { configurable: { thread_id: "session-7", checkpoint_ns: "enrich:ab12" } };

  function dispatch(workflow: string, n: number) {
    return childRunConfig(parent, { identity: String(n), workflow, dispatchId: String(n) });
  }

  it("enumerates both children of a run that dispatched twice", () => {
    const sessions = [dispatch("enrich-account", 1), dispatch("enrich-account", 2)].map(
      (c) => c.configurable?.thread_id as string,
    );
    expect(new Set(sessions).size).toBe(2);
    for (const id of sessions) {
      expect(isChildSessionOf(id, "session-7")).toBe(true);
      expect(parentSessionIdOf(id)).toBe("session-7");
    }
    // And an unrelated session is not swept up by the prefix.
    expect(isChildSessionOf("session-70~1", "session-7")).toBe(false);
  });

  // The caller's namespace pins where inside *its* thread the caller is running.
  // Carried into a thread that has never written it, the saver would be asked to
  // resume from a record that does not exist.
  it("creates no namespace under the caller's thread", () => {
    const child = dispatch("enrich-account", 1);
    expect(child.configurable?.checkpoint_ns).toBeUndefined();
    expect(child.configurable?.checkpoint_id).toBeUndefined();
    expect(child.configurable?.thread_id).not.toBe("session-7");
  });

  it("nests a grandchild under its own parent, not the root", () => {
    const child = dispatch("enrich-account", 1);
    const grandchild = childRunConfig(child, { identity: "1", workflow: "fetch-order", dispatchId: "1~1" });
    const id = grandchild.configurable?.thread_id as string;
    expect(parentSessionIdOf(id)).toBe("session-7~1");
    // Still a descendant of the root, which is what makes disposal by prefix reach it.
    expect(isChildSessionOf(id, "session-7")).toBe(true);
  });
});

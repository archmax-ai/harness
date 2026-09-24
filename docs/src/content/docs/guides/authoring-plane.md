---
title: The authoring plane
description: Why the agent cannot read the workflow that governs it or the rubric that grades it, where hook scripts and runtime scripts each live, and how the split is enforced.
---

An archmax harness workspace has two planes. Which one a file belongs to is decided by a
single question: **who reads it?**

| | Authoring plane | Agent workspace |
| --- | --- | --- |
| **Holds** | `workflows/<slug>/`: `workflow.yaml` (grading rubrics included), `WORKFLOW.md`, `hooks/`, `tests/` | `AGENTS.md`, `skills/`, and the session's `scratchpad/` |
| **Read by** | the runtime | the agent |
| **Served by** | the `authoring` backend | the workspace composite (mounts + session store) |
| **Agent access** | none (no route exists) | read-only mounts, plus its own session zone |

The plane is a **set of reserved root prefixes**, today just `workflows/`. Three
components have to answer "is this path on the plane?": mount resolution, the
decision kernel, and `archmax validate`. All three read the same set, so they
agree by construction.

## The agent cannot read `workflows/**`

The block covers its own spec, a sibling workflow's spec, the source of a hook
that vetoes its transitions, and the cases grading it.

The isolation is **structural**. The agent's workspace composite routes the
declared mounts and the session zone, and the plane is served beside it by a
backend of its own:

```ts
const { workspace, authoring } = createWorkspaceContext({ rootDir });

await authoring.readText("workflows/order-lookup/workflow.yaml"); // "states: …"
await workspace.readText("workflows/order-lookup/workflow.yaml"); // null
await workspace.listDir("/");                                     // no `workflows` entry
```

A `read_file` on a `workflows/**` path resolves inside the session's own zone
and comes back empty. The agent meets an *absence* where a refusal would be.
Declaring `workflows/**` in a state's `tools.allow` reaches that same empty
zone, and so does a custom governance rule. A grant widens access along a route,
and the composite carries none to the plane.

Why it matters: an agent that can read the hook vetoing it can reason about how
to get past it. Prompt injection turns "the model can see its own policy" from a
curiosity into an attack surface. What the agent knows about the machine is what
the runtime renders into the system prompt, which already carries everything it
legitimately needs.

Two rules follow when you author:

- **Never point the agent at a `workflows/**` path** from state `instructions`, a
  human state's `evidence` list, or a test case's `workspace:` block. Each one
  resolves inside the session zone and comes back empty. `archmax validate`
  reports a `tools.allow` entry that names the plane.
- **`workflows/` cannot be mounted.** Declaring it in a mount table throws
  `MountCollisionError` at assembly, naming the `authoring` option instead.

## One prefix, and a grader is inside it

A **grading rubric** lives in `workflow.yaml` itself, inline on the hook that
applies it, and the runtime alone dispatches it. So the criteria sit behind the
prefix that already covers the spec, and one prefix is enough:

```ts
await authoring.readText("workflows/order-lookup/workflow.yaml"); // "…after:\n  - rubric: …"
await workspace.readText("workflows/order-lookup/workflow.yaml"); // null
await workspace.listDir("/");                                     // no `workflows` entry
```

A session that could read there would find two things: the criteria of the rubric
that vetoes its transitions, and the `max_iterations` budget saying how many
attempts it gets before the veto is final. Those are the two facts most worth
playing against.

The prompt keeps both back. The active state's block discloses one thing, that a
phase of *that state* carries a hook of kind `rubric`. A rubric is identified by
its position, so a prompt has no name to print, and `task` is the runtime's own
dispatch, refused to every state that asks for it.

Sometimes the agent legitimately needs some of a grader's content, such as a
style guide it should follow while drafting. Put that content in a skill bundle
(`skills/<capability>/…`), which is agent-visible by design. What stays on the
plane is the standard it will be *measured* against.

## Two kinds of script, two homes

The plane split draws a clear line between two kinds of script. A **hook
script** and a **runtime script** have different executors, so they live in
different places.

| | Hook script | Runtime script |
| --- | --- | --- |
| **Run by** | the runtime, at a lifecycle point | the agent, via `archmax_run` |
| **Lives in** | `workflows/<slug>/hooks/<check>.js` | `skills/<capability>/scripts/<script>.js` |
| **Wired as** | `before: { script: hooks/<check>.js }` | `{ tool: archmax_run, paths: ["skills/<capability>/scripts/**"] }` |
| **Agent can read it** | no | yes (through the `skills/` mount) |

A hook's `script:` path is **workflow-relative**, confined to that workflow's
`hooks/` directory. So `hooks/check-requester.js` resolves to
`workflows/order-lookup/hooks/check-requester.js`. An absolute path, a `..` climb,
or anything outside `hooks/` is a load error and a `validate` error.

A hook's *source* stays on the plane too. Prompts, event payloads and session
artifacts all leave it out, so what a veto hands back is the verdict and the
reason.

### `archmax_run` executes only skill-bundled scripts

The decision kernel enforces the agent-facing half of the same rule. It is a
non-overridable safety rule (`script.skill-only`), evaluated ahead of workflow
`policy`, consumer rules, and the per-state `allow` list:

```
archmax_run("skills/order-enrichment/scripts/fan-out.js")  → allowed
archmax_run("scratchpad/generated.js")                     → blocked: script.skill-only
archmax_run("workflows/order-lookup/hooks/check.js")       → blocked: script.skill-only
```

So `archmax_run` reaches exactly the scripts a skill bundle ships. A file the
agent just wrote and its own hook both fall outside that set. The rule sits
above every declaration, so `{ tool: archmax_run, paths: ["**"] }` grants nothing
extra and `validate` reports it as inert. A state's own entry can still *narrow*
execution within the bundles, which is the useful thing to write:

```yaml
tools:
  allow:
    - { tool: archmax_run, paths: ["skills/order-enrichment/scripts/**"] }
```

Classification goes through the **resolved skill registry**. So a workspace that
serves its bundles from a mount of another name is confined just as tightly, and
an empty registry blocks every `archmax_run`.

## Configuring the authoring backend

`authoring` defaults to the authored `backend` when you supply one, and to a
filesystem backend over the workspace root otherwise. The isolation is in place
either way, with no wiring of your own:

```ts
// Zero-config: governance read from <rootDir>/workflows/, unreachable by the agent.
const agent = await createAgent({ workflow: "order-lookup", workspace: { rootDir } });
```

Declare it when governance genuinely lives somewhere else, such as a store, a
service, or a signed bundle:

```ts
const agent = await createAgent({
  workflow: "order-lookup",
  authoring: myGovernanceBackend,
  // specs (rubrics included), hooks, tests
  backend: myContentBackend,
  // what the agent may read
  mounts: { "/skills/": mountSubtree(myContentBackend, "skills") },
  workspace: { sessionStore: createBackendSessionStore({ backend: myRunStore }) },
});
```

Handing the authoring backend to a **writable** mount fails assembly with
`AuthoringBackendExposedError`. A writable route onto that backend would let a session
edit the machine that governs it, which no downstream rule could undo. A
*read-only* mount may share the backend safely, because a mount key that starts
with a plane prefix is refused at assembly anyway.

## What a script author sees

An agent-initiated read of the plane is silent, because the composite sends it
into the session zone and it comes back empty. A **script** naming the plane is
told why, so you are spared debugging that empty read:

```js
await tools.readFile("workflows/other/workflow.yaml");
// blocked: zone.governance-plane — 'workflows/' holds machine specs, grading
// rubrics, hook scripts, and test cases. The runtime reads it through the
// authoring backend; nothing running inside a run can.
```

The diagnostic names the prefix it matched and what that prefix holds, so you
see *which* plane content you reached for. Your own workflow's rubrics are in
there too. The runtime dispatches those under a positional id, which leaves a
script a verdict to receive and no file to open.

Ordinary reads from a script are unaffected:

```js
await tools.readFile("skills/order-data/assets/orders.json"); // fine
```

## Related

- [The workflow machine](/guides/workflow-machine/): hooks in the spec
- [Code interpreter](/guides/code-interpreter/): `archmax_eval` and `archmax_run`
- [Skills](/guides/skills/): capability bundles and skill governance

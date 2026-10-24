---
title: The authoring plane
description: Why the agent cannot read the workflow that governs it or the criteria a grader holds it to, where code-state scripts and runtime scripts each live, and how the split is enforced.
---

An archmax harness workspace has two planes. Which one a file belongs to is decided by a
single question: **who reads it?**

| | Authoring plane | Agent workspace |
| --- | --- | --- |
| **Holds** | `workflows/<slug>/`: `workflow.yaml` (grader states' criteria included), `WORKFLOW.md`, `scripts/`, `tests/` | `AGENTS.md`, `skills/`, and the session's `scratchpad/` |
| **Read by** | the runtime | the agent |
| **Served by** | the `authoring` backend | the workspace composite (mounts + session store) |
| **Agent access** | none (no route exists) | read-only mounts, plus its own session zone |

The plane is a **set of reserved root prefixes**, today just `workflows/`. Three
components have to answer "is this path on the plane?": mount resolution, the
decision kernel, and `archmax validate`. All three read the same set, so they
agree by construction.

## The agent cannot read `workflows/**`

The block covers its own spec, a sibling workflow's spec, the script of a code
state that checks its work, and the cases testing it.

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

Why it matters: an agent that can read the check its work must pass can reason
about how to get past it. Prompt injection turns "the model can see its own policy" from a
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

A **grader state's** criteria are its `instructions`, in `workflow.yaml` itself,
and the runtime alone runs the grader. So the criteria sit behind the prefix that
already covers the spec, and one prefix is enough:

```ts
await authoring.readText("workflows/order-lookup/workflow.yaml"); // "…type: grader\n    instructions: …"
await workspace.readText("workflows/order-lookup/workflow.yaml"); // null
await workspace.listDir("/");                                     // no `workflows` entry
```

A session that could read there would find the standard its work is measured
against, and how many send-backs the grader allows before it raises. Those are
the two facts most worth playing against.

The prompt keeps both back. From the state before a grader, the agent sees one
line: the transition into it, marked `(grader)`, with its `description`. No part
of the grader's `instructions`, `model` or `budget` reaches any prompt of the
session's agent. The grader runs in a context of its own, and the agent reads what
it decided only as a runtime note. The Deep Agents `task` tool is refused to every
state that asks for it.

Sometimes the agent legitimately needs some of a grader's content, such as a
style guide it should follow while drafting. Put that content in a skill bundle
(`skills/<capability>/…`), which is agent-visible by design. What stays on the
plane is the standard it will be *measured* against.

## Two kinds of script, two homes

The plane split draws a clear line between two kinds of script. A **code-state
script** and a **runtime script** have different executors, so they live in
different places.

| | Code-state script | Runtime script |
| --- | --- | --- |
| **Run by** | the runtime, when the session enters the code state | the agent, via `archmax_run` |
| **Lives in** | `workflows/<slug>/scripts/<check>.js` | `skills/<capability>/scripts/<script>.js` |
| **Wired as** | `type: code` with `script: scripts/<check>.js` | `{ tool: archmax_run, paths: ["skills/<capability>/scripts/**"] }` |
| **Agent can read it** | no | yes (through the `skills/` mount) |

A code state's `script:` path is **workflow-relative**, confined to that
workflow's `scripts/` directory. So `scripts/screen-request.js` resolves to
`workflows/order-lookup/scripts/screen-request.js`. An absolute path, a `..` climb,
or anything outside `scripts/` is a load error and a `validate` error. So is a
path that does not end in `.js` or `.mjs`.

A code state's *source* stays on the plane too. Prompts, event payloads and
session artifacts all leave it out, so what the next state reads is the reason
the script passed to `archmax_advance`.

Being run by the runtime does not widen what a code-state script may do. Its
`tools.*` calls are governed against its own code state, exactly as an
`archmax_run` script's are against the active state. A code state that reads a
bundle's data enables that bundle in its own `skills.allow`.

### `archmax_run` executes only skill-bundled scripts

The decision kernel enforces the agent-facing half of the same rule. It is a
non-overridable safety rule (`script.skill-only`), evaluated ahead of workflow
`policy`, consumer rules, and the per-state `allow` list:

```
archmax_run("skills/order-enrichment/scripts/fan-out.js")  → allowed
archmax_run("scratchpad/generated.js")                     → blocked: script.skill-only
archmax_run("workflows/order-lookup/scripts/check.js")     → blocked: script.skill-only
```

So `archmax_run` reaches exactly the scripts a skill bundle ships. A file the
agent just wrote and a code state's script both fall outside that set. The rule sits
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
  // specs (graders' criteria included), code-state scripts, tests
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
await tools.readFile({ file_path: "workflows/other/workflow.yaml" });
// blocked: zone.governance-plane — 'workflows/' holds machine specs, code-state
// scripts, and test cases. The harness reads it through the authoring backend;
// nothing running inside a run can.
```

The diagnostic names the prefix it matched and what that prefix holds, so you
see *which* plane content you reached for. A code state's script gets the same
refusal: it runs from the plane, and still cannot read it.

Ordinary reads from a script are unaffected:

```js
await tools.readFile({ file_path: "skills/order-data/assets/orders.json" }); // fine
```

## Related

- [The workflow machine](/guides/workflow-machine/): states, transitions and governance
- [Grader and code states](/guides/automated-states/): the states the runtime runs itself
- [Code interpreter](/guides/code-interpreter/): `archmax_eval` and `archmax_run`
- [Skills](/guides/skills/): capability bundles and skill governance

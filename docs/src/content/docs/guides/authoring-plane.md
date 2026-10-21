---
title: The authoring plane
description: Why the agent cannot read the workflow that governs it or the rubric that grades it, where hook scripts and the scripts the agent runs each live, and how the split is enforced.
---

An archmax harness workspace has two planes. Which one a file belongs to is decided by a
single question: **who reads it?**

| | Authoring plane | Agent workspace |
| --- | --- | --- |
| **Holds** | `workflows/<slug>/`: `workflow.yaml` (grading rubrics included), `WORKFLOW.md`, `hooks/`, `tests/`, and any scripts of the workflow's own | `AGENTS.md`, `skills/`, and the session's `scratchpad/` |
| **Read by** | the runtime | the agent |
| **Served by** | the `authoring` backend | the workspace composite (mounts + session store) |
| **Agent access** | none (no route exists); `archmax_run` may execute an authored script there | read-only mounts, plus its own session zone |

The plane is a **set of reserved root prefixes**, today just `workflows/`. Four
components have to answer "is this path on the plane?": mount resolution, the
decision kernel, the script executor (which reads a workflow's own script from
the plane), and `archmax validate`. All four read the same set, so they agree by
construction.

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

- **Never point the agent at a `workflows/**` path to read** from state
  `instructions`, a human state's `evidence` list, or a test case's `workspace:`
  block. Each one resolves inside the session zone and comes back empty.
  `archmax validate` reports a `tools.allow` entry that names the plane. The one
  exception is a script the agent should **run**: `archmax_run` executes a
  workflow's authored script from the authoring backend (see below), so
  instructions may name `workflows/<slug>/scripts/<script>.js` for it.
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

## Two kinds of script

The plane split draws a clear line between two kinds of script. A **hook
script** and an **authored script** have different executors, and the agent
can only ever run the second.

| | Hook script | Authored script |
| --- | --- | --- |
| **Run by** | the runtime, at a lifecycle point | the agent, via `archmax_run` |
| **Lives in** | `workflows/<slug>/hooks/<check>.js` | a skill bundle (`skills/<capability>/scripts/<script>.js`), or beside its workflow (`workflows/<slug>/scripts/<script>.js`) |
| **Wired as** | `before: { script: hooks/<check>.js }` | named in a state's instructions; narrowed with `{ tool: archmax_run, paths: [...] }` |
| **Agent can read it** | no | a skill bundle's, yes (through the `skills/` mount); a workflow's, no |

A hook's `script:` path is **workflow-relative**, confined to that workflow's
`hooks/` directory. So `hooks/check-requester.js` resolves to
`workflows/order-lookup/hooks/check-requester.js`. An absolute path, a `..` climb,
or anything outside `hooks/` is a load error and a `validate` error.

A hook's *source* stays on the plane too. Prompts, event payloads and session
artifacts all leave it out, so what a veto hands back is the verdict and the
reason.

Put a script in a skill bundle when it belongs to a capability several
workflows share, or when the agent should be able to read it. Put it beside the
workflow when only that workflow runs it. `workflows/<slug>/scripts/` is the
convention; nothing enforces the name.

### `archmax_run` executes only authored scripts

The decision kernel enforces the agent-facing half of the rule. It is a
non-overridable safety rule (`script.authored-only`), evaluated ahead of workflow
`policy`, consumer rules, and the per-state `allow` list. An **authored script**
is a file in a skill bundle, or a file under `workflows/` that is not one of a
workflow's own files: not in any workflow's `hooks/`, and not a `workflow.yaml`,
a `WORKFLOW.md` or anything in a `tests/`.

```
archmax_run("skills/order-enrichment/scripts/fan-out.js")  → allowed
archmax_run("workflows/order-lookup/scripts/tally.js")     → allowed
archmax_run("workflows/order-lookup/hooks/check.js")       → blocked: script.authored-only
archmax_run("workflows/order-lookup/workflow.yaml")        → blocked: script.authored-only
archmax_run("scratchpad/generated.js")                     → blocked: script.authored-only
archmax_run("reference/run.js")   # a mount                → blocked: script.authored-only
```

What stays refused, and why:

- **Every hook**, the agent's own workflow's and every other workflow's. A hook
  vets the agent's moves; an agent that could run its own guard could probe it
  for a bypass. Every hook lives under a `hooks/`, so refusing that location
  refuses them all, in any spelling a filesystem resolves to it (`HOOKS/`,
  `hooks./`). A path holding a `\` is never run at all.
- **A workflow's spec, prose addendum and cases.** They are not scripts, and the
  error a YAML file raises when executed as JavaScript can quote it, rubrics
  included.
- **The session's files and the mounts**: `scratchpad/`, every other session
  path, and every mount but a skill bundle's (data, remote and host mounts
  alike). The agent can write some of these during the session, so running one
  would run code it wrote itself.

A workflow's script is **read from the authoring backend**, by its canonical
path, never from the session. The agent's workspace has no route to
`workflows/`, so a `write_file` to `workflows/order-lookup/scripts/own.js`
lands in the session, and `archmax_run` on that path still reads the authoring
backend, which has no such file. Running a script does not open the plane
either: the agent still cannot read, list or search it, and the script's own
`tools.*` calls are refused a `workflows/` path like any script's (see below).
Keep the data a workflow's script reads in a skill bundle, a mount or the
session.

The rule sits above every declaration, so no grant reaches a hook or a session
file. A state's own entry can still *narrow* which authored scripts run, which
is the useful thing to write. `{ tool: archmax_run, paths: ["**"] }` reaches every
authored script, so narrow instead:

```yaml
tools:
  allow:
    - { tool: archmax_run, paths: ["workflows/order-lookup/scripts/**"] }
```

Skill bundles are classified through the **resolved skill registry**. So a
workspace that serves its bundles from a mount of another name is governed just
as tightly. A host tool that declares an `execute` path argument is held to the
same rule, except that a `workflows/` path is authored for `archmax_run` alone:
any other tool would resolve it in the session.

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

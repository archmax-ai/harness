---
title: Glossary
description: One term per concept, covering the vocabulary used in code, workflow.yaml, the prompt, the CLI, and these docs.
sidebar:
  order: 4
---

The archmax harness uses one name for each concept, everywhere it appears. That means
identifiers, `workflow.yaml` keys, the text the model reads, CLI output, and
these pages. A page or an error message that uses a different word for one of
the concepts below is a defect. Please report it.

## The software

| Term | Meaning | Not called |
| --- | --- | --- |
| **archmax harness** (the SDK) | This package: `createAgent`, the CLI, the testing engine. "The harness" is its short form once the full name has appeared. | framework, platform, engine |
| **runtime** | What executes a session: the governed Deep Agent, its middleware, the kernel, the sandbox. Also the `runtime:` block in `workflow.yaml`, which names the contract version the workspace was written against. | harness |
| **kernel** | The pure, synchronous function that turns a proposed action (a tool call, a transition, a hook outcome) into a verdict. Shared by the runtime and by `archmax validate`. | policy engine |
| **Deep Agents** | The LangChain library the archmax harness is built on. The archmax harness reaches for its mechanisms wherever they exist. | the framework |

## Authoring

| Term | Meaning | Not called |
| --- | --- | --- |
| **workspace** | The directory (or backend) a workflow is authored in: `AGENTS.md`, `workflows/`, `skills/`. | project, root |
| **workflow** | One authored unit under `workflows/<slug>/`: a `workflow.yaml` and an optional `WORKFLOW.md`. The slug is its identity. | process, flow |
| **spec** | The parsed `workflow.yaml` document, as the schema defines it. | machine spec, definition |
| **machine** | The compiled object built from a spec that the runtime consults for transitions, tool surfaces and enabled skills. It is internal to the runtime and appears in the SDK as `WorkflowMachine`. | graph |
| **state** | A key under `states`. The unit the model moves between. A state with `type: human` is a **human state**; a state with no transitions is **terminal**. | node, step, phase |
| **slug** | The kebab-case identity of a workflow or a state, and the token every route resolves against. | id, key, name |
| **title** | A human label beside a slug, for display; routing goes by the slug. Also the reserved variable `title`, which names a session's task for a listing. | name, label |
| **transition** | A declared edge from one state to another, taken by `archmax_advance`. On a human state each transition has a `type` (approve, reject, refine, none). | edge, route |
| **trigger** | How a session starts or resumes: `manual` (a prompt), or a host-declared id. Declared under the `triggers:` of the state it enters, keyed by id. That state is its entry, and the declaration carries its session path and signature. | event, firing |
| **hook** | A `before` or `after` slot on a state. A **script hook** runs a JavaScript file in the sandbox; a **rubric hook** asks a grading rubric for a verdict. | gate, guard, judge |
| **verdict** | What a hook returns: `ok`, `correct` (the model gets another attempt), or `veto` (the move is blocked). A hook that errors vetoes. | decision, result |
| **always-on tools** | Tools permitted in every state: the file tools, `write_todos`, the sandbox tools, and whatever the workflow lists under `tools.allow_always`. Every other tool is granted per state under `tools.allow`. | essential tools |
| **skill bundle** | A capability under `skills/<slug>/`: a `SKILL.md`, optional `assets/`, optional `scripts/`. A list names its slug to enable it: `skills.allow_always` at the workflow root (every state), or a state's own `skills.allow` (that state). The two lists add. | skill (alone), capability |
| **authoring skill** | The Agent Skill shipped with the SDK that teaches a coding agent how to author a workspace. It shares the file format of a skill bundle; its reader is the coding agent doing the authoring. | the harness skill |
| **grading rubric** | The standard a state's exit is measured against, declared inline on the `before`/`after` hook that applies it. The runtime dispatches it, out of reach of the agent it grades. | subagent, judge, grader |
| **iteration budget** | `max_iterations`: how many times a `correct` verdict may send the agent back before the rejection is a hard veto. Declared on a rubric, overridable per hook. | corrections, retries |
| **sub-workflow** | Another workflow in the same workspace, called as a tool named `archmax_workflow_<slug>`. It runs as a **child session**. | delegation node, nested workflow |
| **case** | One declarative test document under `workflows/<slug>/tests/*.test.yaml`, run by `archmax test`. | offline test, eval, scenario |
| **grade** | A case assertion that asks a model to score a reply against a threshold. | judge |

## Running

| Term | Meaning | Not called |
| --- | --- | --- |
| **session** | The durable conversation a workflow runs in, and the folder that holds it under `sessions/<id>/`. | run, thread, conversation |
| **turn** | One invocation on a session: a prompt, a decision, a reply, or a delivery. | segment, step |
| **session store** | Where sessions physically live: the filesystem by default, any Deep Agents backend, or memory. | run store |
| **mount** | A route in the agent's workspace composite: a key at the root served by a backend, read-only by default. Where the host declares it `governed`, each state reaches it through `mounts.allow` / `mounts.forbid`, read or read/write per the grant's `access`. | zone (for a mount), plane |
| **zone** | The kernel's classification of a path: a mount, the working area, an offload area, a runtime-internal area, or the authoring backend. | area |
| **authoring backend** | The backend the runtime reads specs (rubrics included), hooks and cases from. The runtime alone reads it; assembly fails if a workspace exposes it. | authoring plane, governance plane |
| **scratchpad** | `scratchpad/`, the one working area a session can always write to. | output, work |
| **control tools** | `archmax_advance`, `archmax_wait`, `archmax_reset`, `archmax_get_variables`, `archmax_set_variables`. | workflow tools |
| **sandbox tools** | `archmax_eval` (inline code) and `archmax_run` (an authored script), both executing in the QuickJS sandbox. | interpreter tools |
| **delegation tools** | `archmax_workflow_<slug>`, one per sub-workflow a state allows. | task tools |
| **file tools** | Deep Agents' `ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`. | filesystem middleware |
| **variables** | The session's flat key-value store, readable by the model, hooks and guards as `${{name}}`. A **locked** variable was seeded by the host, and `archmax_set_variables` refuses to change it. | session variables, context |
| **park** | A session suspended and waiting: for a **decision** at a human state, or for **input** after `archmax_wait`. | interrupt, suspension, wait state |
| **decide · reply · deliver** | The three ways a parked session resumes: a person picks a transition; a person sends a message the model answers on a reply-only turn; the host delivers a trigger with variables. | respond, resume, send |
| **runtime note** | A transcript message the runtime itself wrote: an arrival, a decision, an error route, a completion check. | narration, system message |
| **trail** | The checkpointed audit trail of a session: every transition, decision, reset and delegation. | history, trajectory |
| **state flow** | The CLI's rendering of the event stream while a session runs. | trail (for the rendering) |
| **artifacts** | Files the runtime writes about a session on request: `graph.json`, `trail.json`, `variables.json`, `metadata.json`. | outputs |
| **events** | The typed stream (`onEvent`) every diagnostic flows through. | logs |

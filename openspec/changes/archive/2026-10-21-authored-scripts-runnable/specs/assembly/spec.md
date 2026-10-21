## MODIFIED Requirements

### Requirement: The authoring backend is never served to the agent

`authoring` SHALL name the backend the runtime reads `workflows/<slug>/` from — `workflow.yaml` (its inline grading rubrics included), `WORKFLOW.md`, hook scripts, cases. It SHALL default to `backend` when one is supplied, else to a filesystem backend over the resolved root. It SHALL appear in no mount table, no root listing and no path an agent tool or sandbox `tools.*` call can address; hook scripts SHALL be read from it by a separate executor, and `archmax_run` SHALL read a workflow's authored script from it too, never from the session, while every other source it runs comes from the agent workspace; both executors share one sandbox runtime. Reading a source to execute it is not addressing it: the agent still has no tool that lists or reads the authoring backend.

There SHALL be no second authoring prefix. A grader's prompt is part of the spec, so it is protected by the one route that does not exist rather than by a directory reserved for it.

#### Scenario: Default authoring backend

- **WHEN** `createAgent({ workflow: "order-lookup" })` is called with no `authoring`
- **THEN** the spec, its prose, its rubrics and its hook scripts are read from the root's `workflows/` directory, which no agent tool can reach

#### Scenario: Rubrics need no agent-visible route

- **WHEN** a workflow's states declare rubric hooks and the workspace serves no authored mount at all
- **THEN** the rubric registry is populated by walking the spec read through the authoring backend

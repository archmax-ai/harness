# archmax harness

**A thin, governed layer over [LangChain Deep
Agents](https://docs.langchain.com/oss/javascript/deepagents/overview). Every session runs
under a declarative workflow state machine you author in one YAML file.**

The archmax harness is Node/TypeScript and ESM. It assembles one Deep Agent per workflow, serves that agent's
workspace through a Deep Agents backend, and enforces `workflows/<slug>/workflow.yaml` with
middleware and a pure decision kernel.

The runtime holds no use-case logic. Everything specific to your agent lives as files in your
workspace: persona, states, tool permissions, hooks, skill bundles, data.

- **One file is the source of truth.** `workflow.yaml` is the enforced machine: states,
  transitions, per-state tool governance, lifecycle hooks, budgets, error routing, triggers.
  What the model reads is rendered from the spec, so prose cannot drift from enforcement.
- **Closed by default, including the graph.** The agent sees the active state's tool surface and
  its outgoing edges. Another state's slug, instructions, transitions and even the state count
  stay out of the prompt. So the cached prefix does not grow with the graph, and a prompt
  injection has no map to steer with.
- **Enforced by the kernel.** The agent moves only by calling `archmax_advance`. The workflow's
  and the state's `allow`/`forbid` lists cover tools, skills and mounts alike, with deny beating
  allow. The kernel applies them to every call, including the calls a sandboxed script makes.
  Hooks return `ok`, `correct` or `veto`, and they fail closed.
- **Human-in-the-loop, natively.** A `type: human` state parks the session on a durable
  checkpoint. A person picks the outgoing transition, and the session resumes where it stopped.
- **Backend-driven and durable.** Specs, prompts, skills and sessions all flow through Deep
  Agents backends: filesystem, store, or remote. Every session is a resumable, inspectable
  folder in a session store you choose.

## Why archmax harness

Reliable automation with AI agents should follow the process, and the people who own that
process should be able to author it. Today that is out of reach for most domain experts.
Current automation tools fall short in three ways.

- **The agent is a step, not the process.** The agent sits inside a fixed graph, so its
  flexibility ends at the edge of one node. The process stays as rigid as the diagram someone
  drew.
- **The process and its implementation drift apart.** Every business process is restated as a
  technical graph. That makes two artifacts with two owners, and keeping them in step never
  stops costing effort.
- **Complex data still ends up in code.** Nested payloads, loops and arithmetic land in a code
  node. The person who owns the process cannot read it, let alone change it.

The archmax harness turns this around. The agent runs the whole process, and one `workflow.yaml` both
describes it and enforces it. Data work happens in a sandbox the same rules govern.

**Full documentation: <https://harness.archmax.ai/>**

## Install

```bash
npm install @archmax-ai/harness
```

Node 22 or later. The model is configured through the environment, against any OpenAI-compatible
endpoint. The archmax harness reads those keys from a `.env` in the workspace root:

```bash
ARCHMAX_API_BASE_URL=https://api.example.com/v1
ARCHMAX_API_KEY=...
ARCHMAX_MODEL=...
```

`ARCHMAX_MODEL` is the default. A workflow names the id its states run on with `settings.model`,
and a single state overrides that with its own `model:`. Either way it is an id, resolved over
the same endpoint and credentials. So a mechanical state can run on a small model while the state
whose output a person reads runs on a capable one.

See [configuration](https://harness.archmax.ai/reference/configuration/) for
every variable.

## Quickstart

### A workspace

```
my-workspace/
├── AGENTS.md                      # persona
├── workflows/order-lookup/
│   ├── workflow.yaml              # the enforced state machine, and its grading rubrics
│   ├── WORKFLOW.md                # optional prose addendum
│   ├── hooks/check-requester.js   # lifecycle hook scripts
│   └── tests/*.test.yaml          # cases for `archmax test`
├── skills/<slug>/                 # skill bundles: SKILL.md, assets/, scripts/
└── sessions/                      # default session store (gitignored)
```

```yaml
# workflows/order-lookup/workflow.yaml (excerpt)
title: Order lookup
instructions: Only ever disclose the requester's own company's orders.
tools:  { forbid_always: [archmax_reset] }  # denied in every state; deny beats allow
skills: { allow_always: [order-data] }    # enabled in every state; a state's own
                                          # `skills.allow` adds, `skills.forbid` subtracts
mounts: { allow_always: [reference] }     # which STATES reach a host-governed mount;
                                          # a grant may say `access: read` or `read_write`

states:
  identify-case:
    triggers:
      manual:
    instructions: Classify the request and archmax_advance to the matching path.
    before: { script: hooks/check-requester.js }
    transitions:                    # a description is REQUIRED on every edge: the
                                    # agent is shown this state's edges and nothing
                                    # else of the graph, so it is all it routes on
      - to: orders-question
        description: The user is asking about orders, status, shipping, or tracking.
  orders-question:                  # no transitions: terminal
    instructions: Answer from skills/order-data/assets/orders.json.
                                    # no skills block: the workflow's grant reaches
                                    # here, and enabling a bundle is the whole grant
    # The standard this state's exit is graded against, declared where it applies.
    # On the authoring plane, so the agent being graded can neither read it nor
    # call it.
    after:
      - rubric:
          max_iterations: 2         # how many times a `correct` may send the agent back
          instructions: Judge the tone of the reply. Return ok, correct or veto with a reason.
```

`examples/customer-support/` in this repository is a complete reference workspace.

### The CLI

```bash
npx archmax run order-lookup "Which orders are delayed for Acme?" --root ./my-workspace
npx archmax test order-lookup --root ./my-workspace       # run the workflow's cases
npx archmax validate order-lookup --root ./my-workspace   # static checks, no model calls
npx archmax sessions --root ./my-workspace                # list durable sessions
npx archmax decide <session> --to approved                # resume a session parked at a human state
npx archmax reply <session> "Any update?"                 # answer a parked session; it stays parked
npx archmax deliver <session> --trigger email_reply       # resume a session parked with archmax_wait
```

Results go to stdout and the state flow to stderr. Exit 0 means done or parked, 1 a failure, 2 a
usage error. See the [CLI reference](https://harness.archmax.ai/reference/cli/).

### The library

```ts
import { createAgent } from "@archmax-ai/harness";

const agent = await createAgent({
  workflow: "order-lookup",
  workspace: { rootDir: "./my-workspace" },
});

// A turn, a decision, a reply or a delivery: one call, one Outcome.
const outcome = await agent.workflow!.send("session-42", {
  message: "Which orders are delayed for Acme?",
});
console.log(outcome.kind, outcome.state, outcome.reply); // "parked" "refund-review" "..."

if (outcome.kind === "parked" && outcome.parkedChannel === "decision") {
  await agent.workflow!.decide("session-42", { target: "approved", comment: "Within policy." });
}
```

Omit `workflow` for a plain Deep Agent with the same parameters, or pass `workflow: false` to
declare an agent ungoverned. `onEvent` receives the typed event stream and
`workspace.sessionStore` puts sessions elsewhere. `workspace.mounts` composes what the agent can
see, and marking a mount `governed: true` hands the spec's `mounts` block the decision of which
states reach it. Marking one `searchable: false` keeps root-wide searches away from a backend
that must refuse them.

Five subpaths keep production imports small:

- `@archmax-ai/harness/sandbox`: hook authoring types
- `@archmax-ai/harness/testing`: the case engine
- `@archmax-ai/harness/cli`: the state-flow renderer
- `@archmax-ai/harness/spec`: the `workflow.yaml` schema, the pure validator and the grammars
- `@archmax-ai/harness/messages`: transcript readers

The last two are browser-safe, with no runtime behind them. See the
[public API reference](https://harness.archmax.ai/reference/public-api/).

### Authoring with a coding agent

The package ships an authoring skill at `dist/authoring-skill/archmax-harness/`. It teaches a coding agent
the schema, the hook contract, governance, human states, cases and the CLI. The
`BUNDLED_AUTHORING_SKILL_DIR` export resolves to its parent directory, and the source is
`skills/archmax-harness/`.

## Documentation

- [Quickstart](https://harness.archmax.ai/getting-started/quickstart/) and
  [installation](https://harness.archmax.ai/getting-started/installation/)
- Guides: [the workflow machine](https://harness.archmax.ai/guides/workflow-machine/),
  [sessions](https://harness.archmax.ai/guides/sessions/),
  [triggers](https://harness.archmax.ai/guides/triggers/),
  [skills](https://harness.archmax.ai/guides/skills/),
  [sub-workflows](https://harness.archmax.ai/guides/sub-workflows/),
  [testing](https://harness.archmax.ai/guides/testing/),
  [token efficiency](https://harness.archmax.ai/guides/token-efficiency/)
- Reference: [machine spec](https://harness.archmax.ai/reference/machine-spec/),
  [CLI](https://harness.archmax.ai/reference/cli/),
  [public API](https://harness.archmax.ai/reference/public-api/),
  [glossary](https://harness.archmax.ai/reference/glossary/),
  [changelog](https://harness.archmax.ai/reference/changelog/)

## Development

```bash
npm run dev -- run order-lookup "..." --root examples/customer-support
npm run typecheck && npm test
npm run docs:dev
```

Substantive changes flow through [OpenSpec](https://github.com/Fission-AI/OpenSpec) under
`openspec/`. Documentation, `README.md` and the authoring skill ship in the same change as the
behaviour they describe. See [CONTRIBUTING.md](CONTRIBUTING.md) and the
[development setup](https://harness.archmax.ai/contributing/development/).

## License

MIT. See [LICENSE](LICENSE).

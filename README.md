# archmax harness

**A thin, governed layer over [LangChain Deep
Agents](https://docs.langchain.com/oss/javascript/deepagents/overview). Every session runs
under a declarative workflow state machine you author in one YAML file.**

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

To have a coding agent (Claude Code, Cursor, Codex, …) author workflows for you, install the
authoring skill:

```bash
npx skills add archmax-ai/harness
```

## Quickstart

A refund desk in four states. The agent decides the refund and drafts the email, a script checks
the decision against the policy, a grader checks the email, and the agent sends it. The complete
example is in [`examples/refund/`](examples/refund/).

```
refund/
├── index.js                          # your program: the host tools and the agent
├── tools.js
└── workflows/refund/
    ├── workflow.yaml                 # the process, enforced
    └── scripts/check-decision.js     # the deterministic check
```

### The workflow

```yaml
# workflows/refund/workflow.yaml
title: Refund request
instructions: Decide only from what lookup_customer returns; never guess an order.

states:
  decide:
    triggers:
      manual:
        requires: [email]
    tools:
      allow: [lookup_customer]
    instructions: >-
      Look the customer up with lookup_customer, using the `email` variable. A
      refund is approved only when their order is delivered; otherwise it is
      denied. Record the decision with archmax_set_variables as `decision`
      (approved or denied), write the email to the customer in
      scratchpad/email.md, then advance to check-decision. If you are sent
      back, fix what the note says and advance again.
    transitions:
      - to: check-decision
        description: The decision is recorded and the email is drafted.

  check-decision:
    type: code
    script: scripts/check-decision.js
    tools:
      allow: [lookup_customer]
    transitions:
      - to: review-email
        description: The decision matches the refund policy.
      - to: decide
        description: The decision contradicts the refund policy.

  review-email:
    type: grader
    instructions: >-
      Read scratchpad/email.md and the `decision` variable. Approve the email
      when it is polite, states the decision plainly and names the order.
      Otherwise send it back, saying exactly what to change.
    transitions:
      - to: send
        description: The email is ready to send.
      - to: decide
        description: The email needs changes.

  send:
    tools:
      allow: [send_email]
    instructions: >-
      Send scratchpad/email.md to the customer at `email` with send_email, then
      say in one sentence that it was sent.
```

Each state is one step of the process, and the agent only ever sees the step it is in: that
state's instructions, its tools and the transitions out of it, each with a description to choose
by. It moves on by calling `archmax_advance`, and the runtime refuses any edge the state does not
declare. A state with no transitions, like `send`, is where the session ends.

Two of the states run without the agent. **`check-decision` is a code state**: the runtime runs
its script on entry, with no model call. **`review-email` is a grader state**: an isolated
subagent judges the email against the state's instructions. Both reach only their own state's
tools, and both decide the same way the agent does, with `archmax_advance`. A send-back reaches the
agent as a note it reads before trying again.

### The check

```js
// workflows/refund/scripts/check-decision.js
export default async function ({ variables, tools }) {
  const customer = JSON.parse(await tools.lookup_customer({ email: variables.email }));
  const order = customer?.order;
  const due = order?.status === "delivered" ? "approved" : "denied";

  if (variables.decision === due) {
    await tools.archmax_advance({
      to: "review-email",
      reason: `The refund is ${due}, as the policy requires.`,
    });
  } else {
    await tools.archmax_advance({
      to: "decide",
      reason: `Order ${order?.id ?? "(none)"} is ${order?.status ?? "unknown"}, so the refund must be ${due}.`,
    });
  }
}
```

The policy lives in code, so it holds whatever the model says. When the agent records the wrong
decision, the script sends it back with the reason, before anyone grades the email.

### Running it

```bash
npm install @archmax-ai/harness langchain zod
```

`lookup_customer` and `send_email` are your systems, passed in as ordinary LangChain tools:

```js
// tools.js
import { tool } from "langchain";
import { z } from "zod";

const customers = {
  "ann@example.com": { name: "Ann", order: { id: "ORD-1001", status: "delivered" } },
  "bob@example.com": { name: "Bob", order: { id: "ORD-1002", status: "shipped" } },
};

export const lookupCustomer = tool(async ({ email }) => JSON.stringify(customers[email] ?? null), {
  name: "lookup_customer",
  description: "Look up a customer and their latest order by email address.",
  schema: z.object({ email: z.string() }),
});

export const sendEmail = tool(
  async ({ to, body }) => {
    console.log(`To ${to}:\n${body}`);
    return "sent";
  },
  {
    name: "send_email",
    description: "Send an email to the customer.",
    schema: z.object({ to: z.string(), body: z.string() }),
  },
);
```

```js
// index.js
import { createAgent } from "@archmax-ai/harness";
import { lookupCustomer, sendEmail } from "./tools.js";

const agent = await createAgent({
  workflow: "refund",
  tools: [lookupCustomer, sendEmail],
  workspace: { rootDir: import.meta.dirname },
});

const outcome = await agent.workflow.send("ticket-1001", {
  message: "Hi, I'd like a refund for my last order.",
  variables: { email: "ann@example.com" },
});

console.log(outcome.kind); // "completed"
console.log(outcome.auditTrail.map((step) => `${step.kind} → ${step.to}`).join("\n"));
```

```text
completed
trigger → decide
agent → check-decision
code → review-email
grader → send
```

One call is one turn, and `outcome` says how it ended: `completed`, `parked` (waiting on a person
or an event), or `failed` (the agent called `archmax_raise` because the work cannot be done). The
trail records every move and who made it. Sessions are durable, under `sessions/` by default, so
`send` with the same id continues the conversation.

### The CLI

A workflow that needs only the harness's own tools runs from the command line too. The reference
workspace [`examples/customer-support/`](examples/customer-support/) is one, and it is the suite
the end-to-end tests run against a real model:

```bash
npx archmax run order-lookup "Which orders are delayed for Acme?" --root examples/customer-support
npx archmax test order-lookup --root examples/customer-support       # run the workflow's cases
npx archmax validate order-lookup --root examples/customer-support   # static checks, no model calls
```

The refund example needs your two tools, so it runs from your code. See the
[CLI reference](https://harness.archmax.ai/reference/cli/) for `sessions`, `decide`, `reply` and
`deliver`.

### Next

- [Grader and code states](https://harness.archmax.ai/guides/automated-states/): checks on the graph
- [Human states](https://harness.archmax.ai/guides/workflow-machine/#human-in-the-loop-states): a person picks the edge
- [Triggers](https://harness.archmax.ai/guides/triggers/): typed inputs and returns, files
- [Testing](https://harness.archmax.ai/guides/testing/): cases for `archmax test`
- [Public API](https://harness.archmax.ai/reference/public-api/): `createAgent`, outcomes, events

### Authoring with a coding agent

The authoring skill teaches a coding agent the schema, grader and code states, governance, human
states, cases and the CLI. Install it with the [skills CLI](https://skills.sh):

```bash
npx skills add archmax-ai/harness
```

That installs the latest version from GitHub. To pin the skill to the SDK version your project
depends on, install the copy shipped inside the package instead, after `npm install`:

```bash
npx skills add ./node_modules/@archmax-ai/harness
```

For skills middleware in your own agent, the `BUNDLED_AUTHORING_SKILL_DIR` export resolves to
the packaged copy. The source is `skills/archmax-harness/`.

## Documentation

- [Quickstart](https://harness.archmax.ai/getting-started/quickstart/) and
  [installation](https://harness.archmax.ai/getting-started/installation/)
- Guides: [the workflow machine](https://harness.archmax.ai/guides/workflow-machine/),
  [grader and code states](https://harness.archmax.ai/guides/automated-states/),
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

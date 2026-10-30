---
title: Sessions and parked sessions
description: Park a session until an external event arrives, and let the event find the session it belongs to.
sidebar:
  order: 3
---

A session can stop and wait for the outside world. **`archmax_wait`** parks the session where it
stands, and the **session id** lets the event that eventually arrives find it.

The two are separable: a session can park with no session path declared, and a session id serves a
conversation that never parks. Together they make an email conversation, a chat conversation or a
webhook round-trip a single governed session.

## Parking a session: `archmax_wait`

The agent discovers a wait *inside* a state, so waiting is a tool rather than a state type. The
state that cannot finish without an answer asks for it in the call that waits,
`archmax_wait({ reason, message })`, with the question in `message`:

```yaml
states:
  clarify:
    instructions: >-
      Ask exactly one clarifying question - the smallest thing you need to
      identify the order - by calling archmax_wait with the question in its
      `message` and a reason naming what you are waiting for. The call is
      what waits: without it the customer's answer never reaches you.
      When the reply arrives you continue here: read it, and if it identifies
      the order, advance to answer.
    transitions:
      - to: answer
        description: The reply identifies the order.
      - to: closed-unanswered
        description: The conversation closed before a usable reply arrived.
```

The call **parks the session deterministically**, with no transition. The runtime commits a park
record (`PendingInput`) naming the state, the agent's reason and when it parked. The session's
status becomes `awaiting_input`, and the process can exit. The checkpoint *is* the record:
`archmax sessions` and `agent.sessions.list()` surface it on demand.

Parking is the event-driven sibling of a
[human state](/guides/workflow-machine/#human-in-the-loop-states): one suspension mechanism, two
ways back in. The difference is where the session continues:

| Park | Where the session continues |
| --- | --- |
| a human state | a person picks one of the state's declared edges, and the session advances along it |
| `archmax_wait` | a delivered event **resumes the state that stopped**, which chooses its own transition from what arrived |

A park owes the person a **handoff message** that says what happened and what the session now
waits for. Where the move that parks already said it, the session suspends straight away: an
agent's `archmax_advance` into a human state that carries a `message` has made the handoff, and an
`archmax_wait` park needs none once the agent has said anything since the person's last message,
the call's own `message` included. Otherwise the park spends one model call with no tools to write
it: an advance into a human state with no `message`, a grader's or code state's move into one, a
decision that routes straight into another human state, a wait the agent made in silence.

The handoff is the model's own text, so it surfaces as an ordinary `agent-text` event and lands in
the checkpointed transcript. A control call's `message` surfaces the same way, unless the call was
refused, whose message is never said. So `agent-text` can arrive twice for one `messageId`, first
with the assistant message's own text and then with the call's `message` appended, and a
subscriber replaces by id. A message a person sends *to* a parked session, and the answer it gets,
are `park-message` events (`inbound` and `outbound`), and they move the session nowhere.

`archmax_wait` is available in every agent and human state, terminal ones included. A session that
has answered and now awaits a reply parks where it answered, and stays open.
`tools: { forbid_always: [archmax_wait] }` removes it workflow-wide.

## Delivering the event

Delivery is a host call. Whoever observed the event hands it to the session:

```ts
await agent.workflow.deliver(sessionId, {
  trigger: { id: "email_reply" },
  variables: { reply_body: "It's ORD-1001." },
});
```

or, from the CLI:

```bash
archmax deliver th_01HZ… --trigger email_reply --variables '{"reply_body":"It'"'"'s ORD-1001."}'
```

A delivery carries the same two things a session *starts* with: a trigger id, and variables
carrying what the event brought. The id becomes the session's current trigger, read by a code
state's script as `trigger` and by guards as `${{trigger}}`. The delivered values are seeded as
**locked** session variables, exactly like a host's `variables`, so a downstream `tools.allow`
guard can bind to them. `title` and any of the delivered trigger's `returns` land unlocked.

A park selects no edge, so **any** trigger id resumes it: what a host delivers into a conversation
is the host's decision, and the resumed state reads what arrived. The id is still required, because
it is recorded as the session's current trigger. `agent.workflow.send(sessionId, { message,
trigger, variables })` applies the same rule: a session parked with `archmax_wait` has the trigger
and variables delivered into it.

Everything is validated before the session is touched, and a refused delivery leaves the session
parked exactly as it was:

| Delivery | Result |
| --- | --- |
| to a session that is not parked awaiting input | `SessionNotAwaitingInputError` |
| carrying no trigger id | `MissingDeliveryTriggerError` |
| naming an unaddressable variable | refused the way a host seed is |

### Runtime notes

The arrival is written into the transcript as an `[event]` **runtime note**, so the resumed turn
sees what happened. A runtime note is how the runtime tells a session something in a channel the
model reads as machine output, never as a person's message. The kinds are `[decision]`, `[event]`,
`[error]`, `[grader]`, `[code]` and `[sub-workflow: <slug>]`. A reply to a session parked at a human
state is the one message a person actually sends, and it stays an ordinary human message.

A note is carried as a call of the reserved `archmax_note` tool and its result, a shape every
provider accepts wherever a note lands. The model cannot call that tool, and derived views (a
case's `calledTool`, the CLI's state flow) skip the pair. Hosts read the marker rather than infer
authorship from a role or a `[bracket]` prefix:

```ts
import { isRuntimeNote, runtimeNoteKind } from "@archmax-ai/harness";

for (const message of session.messages) {
  if (isRuntimeNote(message)) {
    render.runtimeNote(runtimeNoteKind(message), message); // "decision" | "event" | …
  } else {
    render.message(message);
  }
}
```

## Waiting for a time, not a reply

A reply-wait works because the world eventually pushes the event. A "check the bank tomorrow" wait
has nobody to push it, so the session says for itself when it wants to be woken. `archmax_wait`
takes an optional `until`:

```ts
archmax_wait({ reason: "the transaction posts overnight", until: "1d" })
```

`until` is a relative duration (`30m`, `2h`, `1d`) or an ISO-8601 instant. The runtime normalizes
it to an **absolute** `resumeAt` on the park record, because a relative duration means little to
the process that reads the checkpoint tomorrow. An `until` the runtime cannot parse is a tool
error, and the park is refused, rather than leaving a session waiting on a wake-up that never
comes.

`resumeAt` rides `SessionSummary` and the park event, and that is the whole feature. **The SDK
schedules nothing**: no timer, no cron, no background work. Waking the session is the host's job,
and it is a query:

```ts
for (const t of await agent.sessions.list()) {
  if (t.status === "awaiting_input" && t.resumeAt && t.resumeAt <= new Date().toISOString()) {
    await agent.workflow.deliver(t.sessionId, { trigger: { id: "timer" }, variables: { now } });
  }
}
```

The query needs a listing. `agent.sessions.list()` answers `[]` under a custom checkpointer, or
over a session store built with `list: false`, so a host with either keeps the parked ids itself.

Two things follow from the design:

- **A double-fired timer is safe.** `deliver` refuses a session that is not parked, so the second
  firing throws `SessionNotAwaitingInputError`, and the session runs once.
- **`resumeAt` is advice to the scheduler.** An email reply arriving an hour after the park resumes
  it at once, exactly as it would without an `until`.

The polling loop is then park → resume → **park again with a new `until`**. The resumed turn
checks again with its own tools, then either advances or waits again.

### Bounding the loop

"Check daily, up to five days, then escalate" is the real shape of that loop. The bound belongs in
the workflow:

```yaml
check-bank:
  summary: Look for the transaction; wait a day and retry if it has not posted.
  budget:
    maxParks: 5          # beside timeoutMs
  on_error: escalate     # where the sixth attempt lands
  transitions:
    - { to: reconcile, description: The transaction was found. }
```

The runtime counts parks per state, checkpointed, so the count survives restarts. It counts within
one turn: a delivery resumes the turn that parked, so the loop's parks add up, and a new turn
starts every count at zero. It refuses the park that would exceed `maxParks` as a **turn
failure**, routed by `on_error`. So the sixth failed check lands in `escalate` deterministically,
whether or not the agent notices its own loop. A state that declares no `maxParks` may park any
number of times.

## Which session an event belongs to

A **session id** is an opaque string naming the conversation: a mail conversation id, a chat
session id, a case number. The host chooses it, and it is the only id there is: the runtime
addresses the conversation by it directly, with no second identity underneath to keep in sync.

Where a firing's id comes from is declared on the trigger, under the `triggers:` of the state that
trigger enters:

```yaml
states:
  intake:
    triggers:
      email_received:
        session: conversation_id  # ← where this firing's session id lives
      email_reply:
        session: conversation_id  # unknown/finished conversation → start fresh here
```

`session:` is a **dotted path over the session's variables**, the same syntax guards use inside
`${{…}}`, array indices and negative indices included:

| Declaration | Reads |
| --- | --- |
| `session: conversation_id` | the `conversation_id` variable |
| `session: triggers.-1.conversationId` | `conversationId` of the **last** entry of a `triggers` array |
| `session: mail.thread.id` | a nested field |

The identity is already in the payload the host maps into variables, so naming it is a one-line
authoring act, with no script or callback in between. Related triggers that must land in the same
conversation declare the *same* path: `email_received` starts the conversation, and `email_reply`
resumes it.

**Every turn belongs to a session.** A fresh session id is minted when a trigger declares no path,
or when the path does not resolve for a firing (a plain `archmax run` with no variables).

### Supplying the path from outside the workflow

The same path can come from the host instead, for a deployment that knows its own payload shape and
would rather configure it than encode it in the workflow:

```bash
archmax run support-inbox --trigger email_reply \
  --session-path triggers.-1.conversationId \
  --variables '{"triggers":[{"conversationId":"AAQk1"}]}'
```

```ts
// per firing…
await agent.workflow.resolveSession({ trigger, variables, sessionPath: "triggers.-1.conversationId" });

// …or once, for every firing this assembly resolves
await createAgent({ workflow, sessionPath: "triggers.-1.conversationId", workspace: { rootDir } });
```

Precedence, most specific first:

1. an explicit **id**: `--session <id>` / `sessionId` (no path involved);
2. a per-firing **path**: `--session-path` / `sessionPath`;
3. the assembly's `sessionPath`;
4. the invoking trigger's `session:` declaration;
5. a minted id.

A malformed path is rejected wherever it is written. One parser reads all four sources, so a path
means one thing everywhere.

## Starting versus resuming

One rule decides what a firing does:

> A session whose turn has **finished** takes its next turn on the same session, continuing from
> the state it is in. A session whose turn is still **open** resumes from the state where it parked.

A session is **extended, never copied**. Both land on the same id, the same checkpoints and the
same folder: the transcript, the position, the variables and the files are all there.

`agent.workflow.send` applies the rule for you, in one call whatever the session's state, and
returns one `Outcome`:

```ts
const outcome = await agent.workflow.send(sessionId, { message: text, trigger, variables });
// outcome.kind: "completed" | "parked" | "failed" | "rejected"
// outcome.disposition: "turn" | "decide" | "reply" | "deliver" — what the session's state made of it
// outcome.exit: { success: true } | { success: false, code, reason } — on a finished turn
```

| Session's state | What `send` does |
| --- | --- |
| none yet | a `turn`: opens at the trigger's entry state |
| finished | a `turn`: continues in the state it is in, on the same id |
| parked awaiting an event | a `deliver`: the trigger and variables are delivered into it, whatever the trigger id |
| parked at a human state | a `reply`: the session answers the message and stays parked; only a decision routes |
| still `running` | `SessionNotResumableError`: one writer per session. A concurrent turn holds it, or a worker died mid-turn and left it `running` |

A `send` that names no trigger takes the one the agent was assembled with,
`createAgent({ trigger })`, which is `manual` by default; so does `resolveSession`.

`resolveSession` is the same rule without the invoke, for a host that wants to look before it acts.
It answers `turn`, `resume` or `reply` for the session the firing resolves to:

```ts
const resolved = await agent.workflow.resolveSession({ trigger, variables });

if (resolved.disposition === "resume") {
  await agent.workflow.deliver(resolved.sessionId, { trigger, variables });
} else if (resolved.disposition === "reply") {
  // A person holds this session at a human state: the firing is a message,
  // answered where the session stands. It parks again, unchanged.
  await agent.workflow.reply(resolved.sessionId, text);
} else {
  await agent.invoke(
    { messages: [{ role: "user", content: text }], trigger, variables,
      session: resolved.sessionId },
    { configurable: { thread_id: resolved.sessionId } },
  );
}
```

`decide`, `reply` and `deliver` are conveniences. Each returns a smaller record of its own, with no
`kind`, and takes no invoke config. `send(sessionId, { decision }, config)` and
`send(sessionId, { delivery }, config)` resume the same way and return a full `Outcome`.

`archmax run` composes both steps. Give it `--session <id>`, or a trigger that declares a session
path, and one command starts *or* continues the right conversation.

## One id, one folder

The session id *is* the address, so a firing is one direct lookup of the session's own checkpoint:

```text
<session store>/
  _specs/<specHash>.json             # the spec a turn ran under
  chat-42/checkpoints/…              # the conversation's durable state
  chat-42/artifacts/…                # per-session observability: graph, trajectory,
                                     # trail, variables (name → { value, locked }),
                                     # metadata; written only when the host calls
                                     # emitRunArtifacts (the CLI never does)
  chat-42/scratchpad/…               # what its turns wrote
```

- **The folder is stable across turns.** A file a turn writes to `scratchpad/` is there for the
  next turn at the same path, because the next turn is the same session.
- **A session that has not run yet has no checkpoint**, and opens at its trigger's entry state.

## Files handed to a session

Every file the runtime hands a session lands in that session's `scratchpad/attachments/`:

- **A host's files.** `agent.workflow.send(sessionId, { message, files })` takes `files` as
  variable → `{ name, content }`. Each file is placed before the turn starts, and its variable is
  seeded, locked, with the placed path. The CLI does the same with
  `archmax run … --file invoice=./invoice.pdf`.
- **A sub-workflow's `file` arguments.** They are copied into the *child's* attachments before it
  starts (see [passing files](/guides/sub-workflows/#passing-files)).
- **A sub-workflow's `file` returns.** They are copied into the *caller's* attachments when the
  child finishes.

A placement keeps the file's own name unless that name is taken. Then it inserts `-1`, `-2`, …
before the last extension, using the lowest free number:

| Already in `scratchpad/attachments/` | A new `report.pdf` lands at |
| --- | --- |
| nothing | `report.pdf` |
| `report.pdf` | `report-1.pdf` |
| `report.pdf`, `report-1.pdf` | `report-2.pdf` |

A name with no extension takes the suffix at its end (`notes-1`, `.env-1`), and only the last
extension moves (`archive.tar-1.gz`). Placements into one session run one at a time, so concurrent
sub-workflows returning files of the same name each take their own. A placement never overwrites a
file.

The bytes arrive exactly. A file that is not text needs a session store that takes raw bytes
(`uploadFiles`). The filesystem and memory stores do, and so does a `createBackendSessionStore` over
a backend that has `uploadFiles`. Through a store without it, such a file is refused with an error
naming the path, and nothing is written. A text file is placed either way.

`agent.sessions.seed(sessionId, files)` is the other way in. It writes files at paths you choose and
seeds no variable, so it suits fixtures. `files` on a turn is the way to satisfy a trigger's
[`file` input](/guides/triggers/#typing-a-signature).

## How a session ended

A finished turn ends one of three ways, and the outcome says which:

| `kind` | Who ended it | What the outcome carries |
| --- | --- | --- |
| `completed` | the session finished its work | `exit: { success: true }` |
| `failed` | the agent, a grader or a code state called `archmax_raise({ code, reason })` | `exit: { success: false, code, reason }` |
| `rejected` | governance or the runtime: a refused start, a missing return, or a failed state with no `on_error` | `rejected`, the reason; no `exit` |

A session is a success unless something declares otherwise. `archmax_raise` is the way to declare
that the work **could not be done**, and it is only for failure. The `code` is a short token
(`orders-unavailable`, `customer-unknown`), so a host can branch on it without parsing text:

```ts
const outcome = await agent.workflow.send(sessionId, { message: text });
if (outcome.kind === "failed" && !outcome.exit?.success) {
  alertOps(outcome.exit?.code, outcome.exit?.reason);
}
```

A raise ends the session at once, in the state it was made in, with no further model call. It does
not route through `on_error`, runs no further state and is not held to the trigger's `returns`.
The session's summary (`agent.sessions.get`) carries the same `exit` while the session is `failed`.
A parked outcome has no `exit`: the session has not ended.

A turn that throws rejects the `send` with the original error, and no `Outcome` comes back. The
session still ends `failed`, with a code of its own: `recursion-limit` when it hit the recursion
limit, `turn-cancelled` when it was aborted, `turn-error` otherwise. So its next message starts a
fresh turn (see [a turn that throws](/reference/public-api/#a-turn-that-throws)).

## Waiting is not finishing

Session statuses partition explicitly:

- **finished**: `completed`, `failed`, `rejected`. The turn is over, and the next event for that
  session is its next turn.
- **open**: `running`, `awaiting_decision`, `awaiting_input`. A parked session is suspended
  mid-graph with its state retained.

`SessionSummary` carries the classification, and `isFinished(status)` is exported, so hosts and the
CLI share one definition of it. The `parked` event says which channel a session awaits and, for an
`archmax_wait` park, the reason it gave, so an `onEvent` subscriber can tell "turn ended" from
"session waiting" straight from the stream. `archmax run` prints a waiting outcome line and exits
zero, because waiting is a successful outcome.

A firing that arrives after a turn finished is the **next turn** of the same session. It continues
in the state the previous turn ended in, so the transcript the model reads and the state it
occupies always agree. That state may be one with no outgoing transitions (an `answer` state, say);
the turn still runs there, under that state's tool governance.

When the current state can serve the new message, the agent answers there. When the message needs
a path the current state cannot reach, the agent calls **`archmax_reset`** to return to the state
the conversation began in, keeping the transcript, the variables and the files. `archmax_reset` is
available in every agent and human state. A workflow that expects follow-ups can also declare the
re-entry transitions it wants.

The prompt says so outright. A model in a terminal state would otherwise answer the follow-up in
place and skip every state the answer depends on, so the platform prompt tells it to reset *before*
answering, and the per-turn state block repeats that on exactly the turns where it applies. A reset
only ever returns to the state the conversation began in, so the prompt also tells the agent never
to call it while it is still there. A terminal state that is the one the conversation began in, as
in a one-state chat workflow, answers its follow-ups in place.

A turn boundary resets the turn's own mechanics: a pending rejection, the failure a previous turn
raised, and the per-state park counts. So `budget.maxParks` bounds parks *within* a turn, and a long
conversation starts each turn with a fresh count. Everything belonging to the conversation carries
forward: position, variables (the agent's as well as the host's seeds), transcript, trail, metrics
and the session's files.

A carried-forward variable does not satisfy the trigger's `requires`, though. They are checked on
every turn against that turn's own seeds, so a follow-up `send` or `archmax run --session` passes
the same variables again; seeds given to `createAgent({ variables })` are applied on every turn. A
seed of one of the trigger's `returns` lands unlocked.

Parking remains the way to continue **mid-state**. A parked session resumes *inside* the state that
stopped, with the arrival in its transcript, where a fresh turn would begin at the top of that
state.

## Testing a park-and-resume flow

Cases drive both halves. `deliver` is a step action beside `send` and `decide`, and
`parked: { channel: input }` pins the channel, so only a session parked for input satisfies it:

```yaml
variables:
  conversation_id: "AAQk-test-1"
steps:
  - send: "About the thing we discussed on the phone — can you sort it out?"
  - parked: { channel: input, state: clarify }
  - deliver:
      trigger: email_reply
      variables: { reply_body: "It's ORD-1001." }
  - succeeded: true
  - reachedState: answer
  - reply:
      includes: ["ORD-1001"]
```

See [testing workflows](/guides/testing/#driving-a-park-and-resume-flow) for the rest of the case
format.

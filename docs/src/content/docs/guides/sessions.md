---
title: Sessions and parked sessions
description: Park a session until an external event arrives, and let the event find the session it belongs to.
sidebar:
  order: 3
---

A session can stop and wait for the outside world. **`archmax_wait`** parks the
session where it stands. The session id is what lets the event that eventually
arrives find it.

The two are separable. A session can park with no session path declared, and a
session id serves a conversation that never parks. Together they make an email
conversation, a chat conversation, or a webhook round-trip a single governed
session.

## Parking a session: `archmax_wait`

The agent discovers a wait *inside* a state, so waiting is a tool rather than a
state type. Whichever state cannot finish without an answer asks for it, then
calls `archmax_wait({ reason })`:

```yaml
states:
  clarify:
    instructions: >-
      Ask exactly one clarifying question - the smallest thing you need to
      identify the order - then call archmax_wait with a reason naming what you
      are waiting for. When the reply arrives you continue here: read it, and if
      it identifies the order, advance to answer.
    transitions:
      - to: answer
        description: The reply identifies the order.
      - to: closed-unanswered
        description: The conversation closed before a usable reply arrived.
```

The call **parks the session deterministically**: no transition, and no model call
spent on the parking itself. The runtime commits a `pendingInput` record naming
the state, the agent's reason, and when it parked. The session's status becomes
`awaiting_input`, and the process can exit.

The checkpoint *is* the record. `archmax sessions` and `sessions.list()` surface it
on demand.

Parking is the event-driven sibling of a [human
state](/guides/workflow-machine/#human-in-the-loop-states): one suspension
mechanism, two resolution channels. The difference is where the session continues.

| Channel | Where the session continues |
| --- | --- |
| a human state | a person picks one of the state's declared edges, and the session advances along it |
| `archmax_wait` | a delivered event **resumes the state that stopped**, which chooses its own transition from what arrived |

A park at a human state spends one tool-less model call: the **handoff message**.
It tells the person what happened and what the session is now waiting for. A
decision that routes straight into another human state spends one too.

An `archmax_wait` park spends that call when the agent has said nothing since the
person's last message. Where the agent's question already is the message, the
session suspends straight away.

That message is the model's own text, so it surfaces as an ordinary `agent-text`
event and lands in the checkpointed transcript. A message a person sends *to* a
parked session, and the answer it gets, are the `park-message` events (`inbound`
and `outbound`). Those move the session nowhere.

`archmax_wait` is available in every state, terminal ones included. A session that
has answered and now awaits a reply parks where it answered, and stays open.
`policy.forbid_tools: ["archmax_wait"]` removes it workflow-wide.

## Delivering the event

Delivery is a host call. Whoever observed the event hands it to the session:

```ts
await agent.workflow.deliver(sessionId, {
  trigger: { id: "email_reply" },
  variables: { reply_body: "It's ORD-1001." },
});
```

or from the CLI:

```bash
archmax deliver th_01HZ… --trigger email_reply --variables '{"reply_body":"It'"'"'s ORD-1001."}'
```

A delivery carries the same two channels a session *starts* with: a trigger id,
and variables carrying what the event brought. The id becomes the session's
current trigger, read by hooks as `args.trigger` and by guards as `${{trigger}}`.

The delivered values are seeded as **locked** session variables, `title` excepted,
exactly like a host's `variables`. A downstream `tools.allow` guard can then bind
to them. The arrival is also written into the transcript as an `[event]` **runtime
note**, so the resumed turn sees what happened.

A runtime note is how the runtime says something to a session in a channel the
model reads as machine output. It is carried as a synthetic `archmax_note` tool
call and its result, which is how every provider represents machine output
injected into a conversation. Every position a note lands in accepts a tool
result. A mid-thread system message is accepted in fewer.

`archmax_note` is reserved and unregistered, so the model has no way to call it.
The call is answered the instant it appears. Derived views (a case's `calledTool`,
the CLI's flow) skip the pair: the session made no such call. The notes are
`[decision]`, `[event]`, `[error]`, `[after]` and `[sub-workflow: <slug>]`.

A reply to a session parked at a human state is the one message a person actually
sends, and it stays an ordinary human message.

Hosts should read the marker rather than infer authorship from a role or a
`[bracket]` prefix:

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

A park selects no edge, so **any** trigger id resumes it. What a host delivers
into a conversation is the host's decision, and the resumed state reads what
arrived. The id is required, because it is recorded as the session's current
trigger; matching it against the workflow is the step a park skips.

`agent.workflow.send(sessionId, { message, trigger, variables })` applies the same
rule from a host. A session parked with `archmax_wait` has the trigger and
variables delivered into it.

Everything is validated before the session is touched, and a refused delivery
leaves the session parked exactly as it was:

| Delivery | Result |
| --- | --- |
| to a session that is not parked awaiting input | `SessionNotAwaitingInputError` |
| carrying no trigger id | `MissingDeliveryTriggerError` |
| naming an unaddressable variable | refused the way a host seed is |

## Waiting for a time, not a reply

A reply-wait works because the world eventually pushes the event. A "check the
bank tomorrow" wait has nobody to push it, so the session says for itself when it
wants to be woken. `archmax_wait` takes an optional `until`:

```ts
archmax_wait({ reason: "the transaction posts overnight", until: "1d" })
```

`until` is a relative duration (`30m`, `2h`, `1d`) or an ISO-8601 instant. The
runtime normalizes it to an **absolute** `resumeAt` on the park record, because a
relative duration means little to the process that reads the checkpoint tomorrow.

An `until` the runtime cannot parse is a tool error, and the park is refused.
Parking without the schedule the agent asked for would leave a session waiting on
a wake-up that never comes.

`resumeAt` then rides `SessionSummary` and the park event, and that is the whole
feature. **The SDK schedules nothing**: no timer, no cron, no background work.
Waking the session is the host's job, and it is a query:

```ts
for (const t of await agent.sessions.list()) {
  if (t.status === "awaiting_input" && t.resumeAt && t.resumeAt <= new Date().toISOString()) {
    await agent.workflow.deliver(t.sessionId, { trigger: { id: "timer" }, variables: { now } });
  }
}
```

Two things fall out of the design:

- **A double-fired timer is safe.** `deliver` refuses a session that is not parked,
  so the second firing throws `SessionNotAwaitingInputError` and the session runs
  once.
- **`resumeAt` is advice to the scheduler.** An email reply arriving an hour after
  the park resumes it immediately, exactly as it would without an `until`.

The polling loop is then park → resume → **re-park with a new `until`**. The
resumed turn re-checks with its own tools, then either advances or waits again.

### Bounding the loop

"Check daily, up to five days, then escalate" is the real shape of that loop. The
bound belongs in the workflow:

```yaml
check-bank:
  summary: Look for the transaction; wait a day and retry if it has not posted.
  budget:
    maxParks: 5          # beside maxTurns / timeoutMs
  on_error: escalate     # where the sixth attempt lands
  transitions:
    - { to: reconcile, description: The transaction was found. }
```

The runtime counts parks per state, checkpointed, so the count survives restarts.
It refuses the park that would exceed `maxParks` as a **turn failure**, routed by
`on_error` like an exhausted `maxTurns`.

So the sixth failed check lands in `escalate` deterministically, whether or not
the agent notices its own loop. A state that declares no `maxParks` may park any
number of times.

## Sessions: which session does this event belong to?

A **session id** is an opaque string naming the conversation: a mail conversation
id, a chat session id, a case number. The host chooses it, and it is the only id
there is. The runtime addresses the conversation by it directly, with no second
identity underneath to keep in sync.

Where it comes from is declared on the trigger, under the `triggers:` of the
state that trigger enters:

```yaml
states:
  intake:
    triggers:
      email_received:
        session: conversation_id  # ← where this firing's session id lives
      email_reply:
        session: conversation_id  # unknown/finished conversation → start fresh here
```

`session:` is a **dotted path over the session's variables**, the same syntax
guards use inside `${{…}}`, including array indices and negative indices:

| Declaration | Reads |
| --- | --- |
| `session: conversation_id` | the `conversation_id` variable |
| `session: triggers.-1.conversationId` | `conversationId` of the **last** entry of a `triggers` array |
| `session: mail.thread.id` | a nested field |

The identity is already in the payload the host maps into variables, so naming it
is a one-line authoring act, with no script or callback in between. Different
channels derive differently: an email trigger reads the mail conversation id, a
chat trigger the chat session id.

Related triggers that must land in the same conversation declare the *same* path.
`email_received` starts the conversation, and `email_reply` resumes it.

**Every turn belongs to a session.** A fresh session id is minted when a trigger
declares no path, or when the path does not resolve for a firing (a plain
`archmax run` with no variables). Downstream handling is the same either way.

### Supplying the path from outside the workflow

The same path can come from the host instead. That suits a deployment that knows
its own payload shape and would rather configure it than encode it in the workflow:

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

A malformed path is rejected wherever it is written. The same parser reads all
four sources, so a path means one thing everywhere.

## Starting versus resuming

One rule decides what a firing does:

> A session whose turn has **finished** takes its next turn on the same session,
> continuing from the state it is in. A session whose turn is still **open**
> resumes from the state where it parked.

A session is **extended, never copied**. Both dispositions land on the same id, the
same checkpoints, the same folder. The transcript, the position, the variables and
the files are simply there, with no replay into the firing.

`agent.workflow.send` applies the rule for you: one call, whatever the session's
state. It returns one `Outcome`:

```ts
const outcome = await agent.workflow.send(sessionId, { message: text, trigger, variables });
// outcome.kind: "completed" | "parked" | "rejected"
// outcome.disposition: "turn" | "reply" | "deliver" — what the session's state made of it
```

`resolveSession` is the same rule without the invoke, for a host that wants to
look before it acts:

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

Anything the rule does not cover fails closed with a typed error:

| Session's state | Result |
| --- | --- |
| none yet | `turn`: opens at the trigger's entry state |
| finished | `turn`: continues in the state it is in, on the same id |
| parked awaiting an event | `resume`: deliver into it, whatever the trigger id |
| parked at a human state | `reply`: the session answers it and stays parked; only a decision routes |
| mid-turn | `SessionNotResumableError`: one writer per session; retry after it parks |

`archmax run` composes both steps for you. Give it `--session <id>`, or a trigger
that declares a session path, and one command starts *or* continues the right
conversation.

## One id, one folder

This works out of the box. The session id *is* the address, so a firing is one
direct lookup of the session's own checkpoint:

```
<session store>/
  _specs/<specHash>.json             # the spec a turn ran under
  chat-42/checkpoints/…              # the conversation's durable state
  chat-42/artifacts/…                # per-session observability: graph, trajectory,
                                     # trail, variables (name → { value, locked }),
                                     # metadata
  chat-42/scratchpad/…               # what its turns wrote
```

Two consequences worth knowing:

- **The folder is stable across turns.** A file a turn writes to `scratchpad/`
  is there for the next turn at the same path. The next turn is the same session,
  so the file carries forward untouched.
- **A session that has not run yet simply has no checkpoint**, and opens at its
  trigger's entry state.

## Waiting is not finishing

Session statuses partition explicitly:

- **finished**: `completed`, `rejected`. The turn is over. The next event for
  that session is its next turn.
- **open**: `running`, `awaiting_decision`, `awaiting_input`. A parked session is
  suspended mid-graph with its state retained.

`SessionSummary` carries the classification, and `isFinished(status)` is exported,
so hosts and the CLI share one definition of it.

The park lifecycle event says which channel a session awaits, and for an agent
park, the reason it gave. An `onEvent` subscriber can therefore tell "turn ended"
from "session waiting" straight from the stream. `archmax run` prints a waiting
verdict and exits zero, because waiting is a successful outcome.

A firing that arrives after a turn finished is simply the **next turn** of the same
session. It continues in the state the previous turn ended in, so the transcript
the model reads and the state it occupies always agree.

That state may be one with no outgoing transitions (an `answer` state, say). The
turn still runs there, under that state's tool governance.

When what was asked needs a path the current state cannot reach, the agent calls
**`archmax_reset`** to return to the state the conversation began in. `archmax_reset`
is available in every state, and it keeps the transcript, the variables and the
files. A workflow that expects follow-ups can also declare the re-entry
transitions it wants.

The prompt says so outright. A model sitting in a terminal state would otherwise
answer the follow-up in place and skip every state the answer depends on, so the
graph-state prompt tells it to reset *before* answering. While a terminal state is
current, the per-turn state block repeats that instruction, on exactly the turns
where it applies.

A turn boundary resets the turn's own mechanics:

- the pending rejection;
- hook-correction counters;
- `before`-hook marks;
- per-state park counts.

Everything belonging to the conversation carries forward: position, variables,
transcript, audit trail, metrics, and the session's files. That includes the
variables the agent set with `archmax_set_variables`, alongside the host's seeds.
So `budget.maxParks` bounds parks *within* a turn, and a long conversation starts
each turn with a fresh count.

Parking remains the way to continue **mid-state**. A parked session resumes
*inside* the state that stopped, with the arrival in its transcript. A fresh turn
would begin at the top of that state instead.

## Testing a park-and-resume flow

Cases drive both halves. `deliver` is a step action beside `send` and `decide`.
`parked: input` pins the channel, so a session parked for input is the one thing
that satisfies it:

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

See the [testing guide](/guides/testing/) for the rest of the case
format.

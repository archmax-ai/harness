# Order lookup workflow

Prose addendum for the `order-lookup` workflow. The **enforced** graph — states,
allowed tools, transitions, triggers, and lifecycle hooks — lives in
`workflow.yaml`, and the harness renders the agent's graph description directly
from that spec. This file carries only what the spec cannot say, and nothing it
already says: prose that restates the graph is re-sent to the model on every
model call of every run for no benefit.

## Domain constraints

- Refunds are valid only for `delivered` or `delayed` orders; never approve a
  refund for a `shipped`, `processing`, or unknown order.
- In your final answer, give the user a clear, concise response and state which
  path you took.

<!--
Everything below is for **readers**: the lean prompt profile strips HTML
comments from this addendum, so the diagram and walkthrough cost nothing per
model call. The model gets the same topology from the rendered graph section.

## Workflow graph

```
                       ┌─────────────────┐
        user request ─▶│  identify-case  │  (trigger `manual`)
                       └────────┬────────┘
                                │
    order    refund      │    other      too vague
    question request     │    question    to answer      (agent chooses one)
  ┌──────────┬───────────┴──────────┬──────────────┐
  ▼          ▼                      ▼              ▼
 ┌────────────────┐ ┌────────────────┐  ┌──────────────────┐  ┌────────────────────┐
 │ orders-question│ │ refund-request │  │ general-question │  │      clarify       │
 │  (terminal)    │ └──────┬─────────┘  │   (terminal)     │  │ asks, then parks   │
 └────────▲───────┘        │ decision + └──────────────────┘  │ itself: archmax_wait│
          │                │                                  └─────┬──────────┬───┘
          │                │           reply identifies the order    │          │
          └────────────────┼─────────────────────────────────────────┘          │
                           │                            conversation closed     ▼
                           │                                    ┌──────────────────────┐
                           │                                    │  closed-unanswered   │
                           │                                    │      (terminal)      │
                           │                                    └──────────────────────┘
   answer +                │ refund.json      answer +
   judge (after)           ▼                  answer.json
                   ┌────────────────┐
                   │  refund-review │  (human state)
                   └──────┬─────────┘
                 approve  │  ▲ send back (refine)
                          ▼  │
                   ┌────────────────┐
                   │  refund-closed │  (terminal)
                   └────────────────┘
```

`clarify` parks **itself**. Once it has asked its question there is nothing more
to do until the customer answers, so it calls `archmax_wait({ reason })`: the run
suspends right there — no transition, no model call to park — and the checkpoint
records the state and the reason. A person picks a human state's edge; here an
*event* simply resumes the state that stopped. The host delivers one (`archmax
deliver <session> --trigger email_reply --variables '{"reply_body":"…"}'`, or
`runtime.deliver(...)`), the delivered values arrive as locked run variables plus
an `[event]` line in the transcript, and `clarify` continues from where it left
off — reading what arrived and choosing its own outgoing edge (answer the
question, or close it unanswered). Which conversation a firing belongs to is
declared on the state the trigger enters: every trigger a conversation can begin
with reads `session: conversation_id`, so a reply resolves to the run that asked
the question. An event that must never start a run — a closed ticket, say — is
not declared here at all; the host names the session it belongs to when it
delivers it.

Every run enters through `identify-case` — the declared entry point for the
`manual` trigger. `orders-question` and `general-question` are directly
terminal. `refund-request` transitions into `refund-review`, a **human state**
where a person reviews the recorded decision and picks an outgoing edge: the
`approve` transition routes to the terminal `refund-closed`, while the `refine`
transition routes back to `refund-request` with the reviewer's comment
delivered as correction.

Handing the run to that reviewer does not end the conversation with the
customer. If `refund-request` advances without saying anything, the harness
spends one **reply-only turn** — one model call, no tools at all — so the park
carries a message ("I've recorded the refund and it's with a reviewer"), and
while the session sits at `refund-review` the customer can keep writing
(`archmax reply <session> "any news?"`, or `agent.workflow.reply(...)`). Each message
is answered on its own turn, with the same no-tools rule: the run may say what
has happened, and nothing it says selects an edge. The decision is still the
reviewer's, and the pending record it will decide on is untouched by the whole
exchange.

`refund-request` also demonstrates the segment safety net: its `budget` bounds
the agent loop (`maxTurns`), and its `on_error` routes an outright segment
failure — a hook execution error, an exhausted correction budget, or an
exhausted execution budget — to the terminal `escalation` state instead of
ending the run rejected.
-->

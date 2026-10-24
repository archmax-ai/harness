# Order lookup workflow

Prose addendum for the `order-lookup` workflow. The **enforced** graph — states,
allowed tools, transitions, triggers, and the code and grader states — lives in
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
user request
  │
  ▼
screen-request (code) ──┬──▶ decline (terminal)
                        │
                        ▼
                  identify-case ──┬──▶ orders-question ──▶ review-reply (grader) ──▶ answered (code, terminal)
                                  │          ▲                    │
                                  │          └──── send back ─────┘
                                  │
                                  ├──▶ refund-request ──▶ check-refund (code) ──▶ refund-review (human) ──▶ refund-closed
                                  │          ▲                    │                        │
                                  │          └──── send back ─────┴──────── refine ────────┘
                                  │                (check-refund escalates after two send-backs)
                                  │
                                  ├──▶ general-question (terminal)
                                  │
                                  └──▶ clarify (parks itself) ──┬──▶ orders-question
                                                                └──▶ closed-unanswered (terminal)
```

Every conversation enters through `screen-request`, a **code state**: before any
model call, its script checks that the requester is known and reaches only their
own company's orders, then moves the session itself — on to `identify-case`, or
to `decline` with the reason the agent there explains. Two more automated states
hold the agent to the work: `check-refund` re-derives the refund policy before a
person sees the decision and sends a contradicting one back with the fix, and
`review-reply`, a **grader state**, reads the session's history and approves the
answer's tone or sends it back — giving up with `archmax_raise` once it has sent
it back twice. An approved answer ends in `answered`, a terminal code state that
records it, so approving costs no further model call.

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

`identify-case` routes the screened request. `general-question` is directly
terminal. `refund-request` transitions through `check-refund` into
`refund-review`, a **human state** where a person reviews the recorded decision
and picks an outgoing edge: the `approve` transition routes to the terminal
`refund-closed`, while the `refine` transition routes back to `refund-request`
with the reviewer's comment delivered as correction.

Handing the run to that reviewer does not end the conversation with the
customer. If the run reaches `refund-review` without saying anything, the harness
spends one **reply-only turn** — one model call, no tools at all — so the park
carries a message ("I've recorded the refund and it's with a reviewer"), and
while the session sits at `refund-review` the customer can keep writing
(`archmax reply <session> "any news?"`, or `agent.workflow.reply(...)`). Each message
is answered on its own turn, with the same no-tools rule: the run may say what
has happened, and nothing it says selects an edge. The decision is still the
reviewer's, and the pending record it will decide on is untouched by the whole
exchange.

`refund-request` also demonstrates the safety net: its `budget` bounds the agent
loop (`maxTurns`), and its `on_error` routes an outright failure — an exhausted
execution budget, a failed tool the agent cannot recover from — to the terminal
`escalation` state instead of ending the run rejected. The automated states route
there too: `screen-request` and `check-refund` when the order database cannot be
read, `review-reply` when the grader itself fails.
-->

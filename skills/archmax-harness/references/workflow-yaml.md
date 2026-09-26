# `workflow.yaml` — keys, machine rules, governance

Load this when writing or editing a `workflow.yaml`. Field-level detail and
precedence edge cases: [`workflow-schema.md`](workflow-schema.md).

## Every key

The schema is strict: an unknown key anywhere is a load error naming it. This
skeleton is the complete vocabulary; omit what you do not need.

```yaml
title: Triage example            # label only; identity is the directory slug
instructions: |-                 # standing direction for the whole run (warning if absent)
  Records live in skills/order-data/assets/orders.json; write artifacts under scratchpad/.

  Answer only from records you have read; never fabricate.
runtime: { engine: archmax-harness, version: "2" }
disabled: false                  # true = out of service: no new turns; parked runs still drain
settings:                        # sandbox limits: timeoutMs, memoryLimitBytes, maxPtcCalls,
  timeoutMs: 15000               #   maxResultChars, prompt_cache: { enabled, ttl }
  model: gpt-5-mini              # MODEL ID ONLY — every state runs on it; overrides ARCHMAX_MODEL
tests:                           # case suite config (no tests.config.js exists)
  maxConcurrency: 1              # only 1 accepted
  caseTimeoutMs: 120000          # per-case wall clock, distinct from settings.timeoutMs
  judge: {}                      # required for grade:; {} = env default model, or { model, modelOptions }
metadata: { canvas: {} }         # host data, never read; accepted at root, state, rubric — leave as found
extensions: { hooks: [] }        # host-registered hook kinds; rarely authored

tools:                           # tool governance, workflow level
  allow_always: []               #   granted in EVERY state; a state's allow adds to it
  forbid_always: [archmax_reset]  #   denied in EVERY state; beats every grant; "*" = every tool
skills:                          # skill governance, workflow level — SLUGS, never paths
  allow_always: [order-data]     #   enabled in every state; [] = every capability is state-specific
  forbid_always: []              #   out of reach everywhere

states:
  triage:                        # key = slug = identity (^[a-z0-9]+(-[a-z0-9]+)*$)
    type: agent                  # agent (default) | human
    title: Triage request        # label for people/hosts; reaches no model call
    summary: Record the refund decision for review.   # ditto: an authoring/host label, NOT in the prompt
    triggers:                    # a trigger is declared on the state it ENTERS; key = id
      manual:                    #   CLI / caller / host entry; the prompt is its input
      email_reply:               #   any other id = host event; the payload arrives as locked variables
        session: conversation_id #   dotted path over variables: which conversation a firing joins
        message: false           #   or a dotted path to the message text; false = firings carry none
        connection: mail         #   host access connection; other keys preserved with a warning
        description: Record one refund decision.  # for CALLERS (delegating model, MCP client); never the agent
        requires:                #   variables a firing must supply (a caller's required params):
          - order_id             #     a bare name is untyped (any value, null included)
          - { name: due, type: date, description: The day it is due. }  # typed: held at the boundary
        returns: [result_file]   #   variables the run guarantees on completion (a caller's result)
                                 #   entry types: string integer number boolean date date-time object array
    instructions: >-
      Record the decision in scratchpad/refund.json, then archmax_advance to
      review; never close the case yourself.
    before:                      # gates entry: ok/veto only; a veto here rejects the run
      - script: hooks/check-requester.js
    after:                       # gates the archmax_advance out (or completion, when terminal)
      - script: hooks/check-policy.js
        max_iterations: 2        #   how many `correct`s before a hard veto (per hook; default 0)
      - rubric:                  #   LLM grader, inline; the agent never sees it
          instructions: |-       #   the only required key: criteria + verdict (ok/correct/veto + reason)
            Judge the tone of the last assistant message …
          max_iterations: 1
          model: gpt-4.1-mini    #   optional override
    tools:
      allow:                     # adds to allow_always; entry = name | { tool, args: {<arg>: [globs]} } | { tool, paths }
        - lookup_customer
        - { tool: archmax_run, paths: ["skills/refund-policy/scripts/**"] }   # narrows an always-on tool, within an enabled skill
        - { tool: write_file, args: { file_path: ["reports/${{case_id}}/*.json"] } }  # variable-bound guard
        - archmax_workflow_enrich-order                                     # runs a sibling workflow
      forbid: [archmax_wait]      # denies here; beats every grant incl. the always-on surface
    skills:
      allow: [refund-policy]     # adds to allow_always (bundle readable + scripts runnable, no path entries)
      forbid: [order-data]       # subtracts, even from allow_always ([] never denies)
    requires: [case_id]          # variables that must be set before this state may be left
    model: claude-opus-5         # MODEL ID ONLY — this state's turns; beats settings.model
    budget: { maxTurns: 12, timeoutMs: 60000, maxParks: 5 }   # bounds the state's segment
    on_error: closed             # where a terminal failure of this segment routes
    metadata: { x: 40, y: 180 }
    transitions:                 # none => terminal state
      - to: review               # slug; must exist
        description: The decision is recorded and needs a person's approval.   # REQUIRED, non-empty:
                                 #   the ONLY thing the agent knows about this edge (on a human
                                 #   state, also the button label). Say WHEN, never where.
        type: none               # approve | reject | refine | none — semantic on human states

  review:                        # human state: parks with a decision record; a PERSON picks the edge
    type: human
    title: Review refund
    summary: A person approves the recorded decision or sends it back.   # label only
    instructions: >-             # required on human states: the decision to present
      Confirm scratchpad/refund.json matches policy.
    approvers: [finance@acme.com]
    evidence: [scratchpad/refund.json]   # plus whatever archmax_advance attached via `evidence:`
    transitions:                 # required; no self-edge; one target per labeled type
      - { to: closed, type: approve, description: Approve and close. }
      - { to: triage, type: refine, description: Send back with a comment. }

  closed:                        # bare key = terminal state with no declarations
```

## Machine rules

- **Movement.** The agent moves only by `archmax_advance({ to, reason, evidence? })`
  — one per message, edge validated, then the leaving state's `after` hooks,
  the target's `before` hooks, then the target's tools unlock. A state with no
  transitions is terminal; the run ends when the agent finishes there. Human
  decisions and `on_error` are the other two movers. `archmax_reset({ reason })`
  returns to the entry state (forbid it via `forbid_always` when a run must
  never restart). No fan-out: sequence states; concurrency lives in
  sub-workflow calls.
- **Entry.** At least one state declares `triggers`; one state per trigger id;
  `manual` is the entry the CLI, a host firing and a caller all use. A
  re-invoked finished session is a **new turn in the state it ended in**, not
  at the entry — give a state re-entry transitions if a conversation must move
  on, or park instead of finishing.
- **Variables.** One flat checkpointed `name → value` store, never declared.
  Host seeds (`--variables`, `createAgent({ variables })`, a delivery) are
  **locked**; the agent uses `archmax_get_variables`/`archmax_set_variables`
  (`lock: true` to freeze). Reserved: `trigger` (current trigger id, always
  locked) and `title` (the run's one-line task label, agent-owned). A
  `${{name}}` / `${{a.b.-1.c}}` reference works in `tools.allow` globs
  (guard) and inside any text tool argument the model writes (exact
  substitution, no retyping) — but not in scripts, which read
  `args.variables`. Name a guarded variable in an earlier state's `requires`
  or seed it; an unresolvable guard reference fails the run, an unresolvable
  argument reference is refused and retried. An `archmax_set_variables` typo
  creates a new variable; `requires` is what surfaces it.
- **Models.** `settings.model` names the id every state runs on and a state's
  `model` names its own — an **id only**, over the endpoint the assembly is
  already configured with (a block with `temperature` is a load error;
  sampling is env/host configuration). Precedence: state → workflow →
  `ARCHMAX_MODEL`. Author it where the work differs in kind: small models for
  classification, extraction and other mechanical states; leave drafting,
  judgement and any state with a big tool surface or several transitions on
  the default, since a small model that routes badly costs more in retries
  than it saves. Repeating the workflow's id on a state is a validate warning.
  A rubric keeps its own `model`, a sub-workflow uses its own spec's, and a
  host that passes an explicit `model` instance to `createAgent` outranks
  every declared id (it must pass `modelFactory` to honour them).
- **Parking.** A state that needs an event or a time calls
  `archmax_wait({ reason, until? })` (`until`: `30m`/`2h`/`1d` or ISO instant →
  `resumeAt` for the host's scheduler; the runtime holds no timer). Any
  delivered trigger resumes **that same state** with the payload as locked
  variables and an `[event]` runtime note; the state then picks its own edge.
  Bound a polling loop with `budget.maxParks` + `on_error`. `archmax_wait` is
  in every state, terminal ones included. Use a **human state** when a person
  picks the edge, `archmax_wait` when an event or time resumes the work.
- **Human states** park with a record built from `instructions`, `evidence`
  and transition `type`s. The handoff spends one reply-only model call so the
  park carries a message — do **not** instruct the agent to announce the
  handoff (two messages). While parked, `archmax reply` is answered on a
  tool-free turn and re-parks unchanged; only `decide` moves the run. A
  `refine` edge delivers the reviewer's comment as correction.
- **Hooks.** `before`: ok/veto (veto rejects entry; on a start state, the
  run; routed through `on_error` if declared). `after`: ok/correct/veto on
  the outgoing advance or on completion of a terminal state; `correct` sends
  the agent back with the reason, bounded per hook by `max_iterations`
  (default 0 → a correct is a hard veto). A list runs in order and stops at
  the first non-ok. Errors and missing files veto (fail-closed). Hooks run
  on runtime authority: the state's `allow`/`forbid`/`skills` do not bind
  them; `forbid_always` and safety rules do. Human states may not declare
  hooks.
- **Budgets and `on_error`.** `budget.maxTurns`/`timeoutMs`/`maxParks` bound
  a state's segment. A terminal failure (hook execution error, exhausted
  corrections, exhausted budget, exhausted parks) routes to `on_error`
  instead of failing the run; recoverable rejections (invalid edge, veto,
  in-budget correct) keep the agent in place. Declare `on_error` on states
  with strict `after` hooks or bounded loops. A **tool that throws** is
  neither: the call is answered with an error-status tool message carrying
  the error, the agent stays in the state and can retry or switch tools, and
  `on_error` never sees it (a park or a cancelled run still propagates).
- **Sub-workflows are tools.** Allow `archmax_workflow_<slug>` (slug verbatim)
  and the sibling `workflows/<slug>/` is callable: its `manual` trigger's
  `requires` are the parameters (typed where the entries are typed; a
  mistyped argument is refused `invalid-param`, and `"${{count}}"` alone
  passes the value with its own type), its `returns` the result
  (`{ message, returns }`; a mistyped typed return fails `invalid-return`).
  The trigger's `description` leads the tool description. Nothing captures the result — the caller records
  what it needs with `archmax_set_variables`, made mandatory by `requires`.
  The child is a separate session with a fresh transcript, sees only its
  arguments (as locked variables), and shares no prose. One call = one
  sub-run; fan out with parallel tool calls or `Promise.all` in a script
  (bounds: depth 3, 4 concurrent). A child's human state parks the child;
  a script's delegation cannot park and fails closed.
- **Choosing a mechanism.** Deterministic work with no model → an `archmax_run`
  script. Delegated work that is itself a process or reused across workflows
  → a sub-workflow. Judging work already done → a rubric hook (never
  callable by the agent; `task` is disclosed nowhere and not grantable).
- **Prompt economy.** The static prompt + tool schemas are re-sent every
  model call. The static part carries the workflow's `title` + `instructions`
  and **no state of the graph**; a state's `instructions` and its **own**
  outgoing edges are sent only while it is active. So: workflow-wide
  conventions go in the root `instructions` (paid once, cached); everything
  else goes in the state that needs it, and splitting a broad state into
  several narrow ones costs nothing in the prefix. `title` and `summary` are
  free — neither reaches a model call. `WORKFLOW.md` carries only what the spec
  cannot say; reader diagrams go inside an HTML comment (stripped from the
  prompt).

## What the agent sees of the graph

Only the state it is in. Every model call is handed that state's outgoing edges
and nothing else of the machine — no other state's slug, `title`, `summary`,
hooks or transitions, and no count of the states:

```
Transitions — choose one with `archmax_advance` when this state's work is done:
- to `review` (human decision node) — The decision is recorded and needs a person's approval.
- to `closed` (terminal) — Nothing to refund; the case is answered.
```

Two rules follow, and they are the ones authors get wrong:

1. **Write the `description` for the source state, not the target.** The agent
   reading it knows nothing about where it is going. Say *when* the edge applies:
   `The refund is over $50, or the customer has asked twice.` Not `Go to
   refund-review.` — that tells a reader who already knows the graph something
   they cannot use, and tells this reader nothing.
2. **Routing conditions cannot live downstream.** A target's `summary` or
   `instructions` is never disclosed to the state routing into it. If the
   condition is "when the order is over 30 days old", it belongs on the edge.

A missing or blank `description` is a **load error**. There is no fallback, and
no way to see more of the graph.

## Governance

Closed by default; **deny beats allow, and no narrower level widens a denial.**

- **Always on, never declared**: `ls`, `read_file`, `write_file`,
  `edit_file`, `glob`, `grep`, `write_todos`, `archmax_eval`, `archmax_run`,
  and the controls `archmax_advance`, `archmax_reset`, `archmax_wait`,
  `archmax_get_variables`, `archmax_set_variables`. Any other tool needs an
  `allow`/`allow_always` entry. An entry naming an always-on tool **narrows**
  it. `task` is ungrantable (error).
- **Entries**: bare name; `{ tool, args: { <arg>: ["glob", …] } }` (matches
  if any glob matches; `${{var}}` allowed); `{ tool, paths: [...] }`
  (shorthand for `args.file_path`). `"*"` as the tool is legal only in a
  forbid list. Globs match dot-segments (`secrets/**` covers `secrets/.env`).
- **Skills** are governed by **slug**, never path. Enabling a bundle makes
  `skills/<slug>/**` readable and its scripts runnable with no `tools.allow`
  entry; a disabled bundle is unreachable **and invisible** (not listed, not
  in the prompt). `allow` adds, `forbid` subtracts, `allow: []` denies
  nothing. A `tools.allow` entry may still narrow *within* an enabled bundle.
  A state enabling no skill can run no script at all.
- **Scripts' `tools.*` calls** are governed per call: an `archmax_run` script
  is bound like the model (grant every tool it calls); a hook is exempt from
  the state's lists. Neither may read `workflows/**` or write a mount. A
  refused call throws inside the script.

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
runtime: { engine: archmax-harness, version: "3" }   # 3 is the only contract; omitted = 3
disabled: false                  # true = out of service: no new turns; parked runs still drain
settings:                        # sandbox limits: timeoutMs, memoryLimitBytes, maxPtcCalls,
  timeoutMs: 15000               #   maxResultChars, prompt_cache: { enabled, ttl }
  model: gpt-5-mini              # MODEL ID ONLY — every state runs on it; overrides ARCHMAX_MODEL
tests:                           # case suite config (no tests.config.js exists)
  maxConcurrency: 1              # only 1 accepted
  caseTimeoutMs: 120000          # per-case wall clock, distinct from settings.timeoutMs
  judge: {}                      # required for grade:; {} = env default model, or { model, modelOptions }
budget: { maxModelCalls: 50 }    # the AGENT's model calls one turn may make across ALL states
                                 #   (default 50; an automated state's run is none). Raise for long turns
metadata: { canvas: {} }         # host data, never read; accepted at root and on a state — leave as found

tools:                           # tool governance, workflow level
  allow_always:                  #   granted in EVERY state; a state's allow adds to or narrows it.
    - ls                         #   The DEFAULT TOOLS: declared, this list REPLACES them (absent,
    - read_file                  #   all twelve are granted), so a new workflow lists all twelve and
    - write_file                 #   removes only what it must not have. Workflow-wide host tools
    - edit_file                  #   go below them; state-specific ones under a state's tools.allow.
    - glob
    - grep
    - copy_file
    - move_file
    - remove_file
    - write_todos
    - archmax_eval
    - archmax_run
  forbid_always: [archmax_reset]  #   denied in EVERY state; beats every grant; "*" = every tool
skills:                          # skill governance, workflow level — SLUGS, never paths
  allow_always: [order-data]     #   enabled in every state; [] = every capability is state-specific
  forbid_always: []              #   out of reach everywhere

states:
  triage:                        # key = slug = identity (^[a-z0-9]+(-[a-z0-9]+)*$)
    type: agent                  # agent (default) | human | grader | code (grader/code = automated)
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
        returns: [result_file]   #   variables the run guarantees on completion (a caller's result);
                                 #   short of them: a child returns what it set + a `note`; a top-level run is rejected
                                 #   entry types: string integer number boolean date date-time object array file
    instructions: >-
      Record the decision in scratchpad/refund.json, then archmax_advance to
      check-policy; never close the case yourself. If a note sends the case
      back, fix what it names and advance again.
    tools:
      allow:                     # adds to allow_always; entry = name | { tool, args: {<arg>: [globs]} } | { tool, paths }
        - lookup_customer
        - { tool: archmax_run, paths: ["skills/refund-policy/scripts/**"] }   # narrows the workflow-wide grant, within an enabled skill
        - { tool: write_file, args: { file_path: ["reports/${{case_id}}/*.json"] } }  # variable-bound guard
        - archmax_workflow_enrich-order                                     # runs a sibling workflow
      forbid: [archmax_wait]      # denies here; beats every grant incl. allow_always
    skills:
      allow: [refund-policy]     # adds to allow_always (bundle readable + scripts runnable, no path entries)
      forbid: [order-data]       # subtracts, even from allow_always ([] never denies)
    requires: [case_id]          # variables that must be set before this state may be left
    locks: [case_id]             # variables only this state may write (change = come back here)
    model: claude-opus-5         # MODEL ID ONLY — this state's turns; beats settings.model
    budget: { maxTurns: 12, timeoutMs: 60000, maxParks: 5 }   # bounds the state's segment
    on_error: closed             # where a terminal failure of this segment routes
    metadata: { x: 40, y: 180 }
    transitions:                 # none => terminal state
      - to: check-policy         # slug; must exist
        description: The decision is recorded in scratchpad/refund.json.   # what the agent routes
                                 #   on. Say WHEN, never where. Omit it to route on the target's
                                 #   instructions instead (target must have some); REQUIRED on a
                                 #   human state's transitions (the button label) and on every edge
                                 #   INTO a grader or code state, like this one.
        type: none               # approve | reject | refine | none — semantic on human states

  check-policy:                  # CODE state: the runtime runs its script on entry, NO model call
    type: code
    script: scripts/check-policy.js   # REQUIRED on a code state, refused on any other type; resolves
                                 #   to workflows/<slug>/scripts/check-policy.js (.js|.mjs, no `..`)
    summary: Re-derive the decision from the refund policy.   # instructions/model/budget/evidence/
                                 #   approvers here are validate ERRORS: nothing reads them
    skills: { allow: [order-data] }   # the script's tools are THIS state's surface: grant here
                                 #   what it reads or calls (another state's grant never reaches it)
    on_error: closed             # a throw, a timeout, or finishing undecided routes here
    transitions:                 # the script takes one: tools.archmax_advance({ to, reason })
      - { to: review, description: The recorded decision matches the policy. }
      - { to: triage, description: The decision contradicts the policy; send it back with the fix. }

  review:                        # human state: parks with a decision record; a PERSON picks the edge
    type: human
    title: Review refund
    summary: A person approves the recorded decision or sends it back.   # label only
    instructions: >-             # required on human states: the decision to present
      Confirm scratchpad/refund.json matches policy.
    approvers: [finance@acme.com]
    evidence: [scratchpad/refund.json]   # plus whatever archmax_advance attached via `evidence:`
    transitions:                 # required; no self-edge; one target per labeled type
      - { to: reply, type: approve, description: Approve; tell the customer. }
      - { to: triage, type: refine, description: Send back with a comment. }

  reply:                         # agent state (type omitted)
    instructions: >-
      Tell the customer the decision in a message that also calls archmax_advance
      to grade-reply; if a note sends it back, rewrite the reply as it says.
    transitions:
      - { to: grade-reply, description: The reply has been sent to the customer. }

  grade-reply:                   # GRADER state: an isolated grader judges and decides the edge
    type: grader
    instructions: |-             # REQUIRED: its criteria, appended to a compiled-in grader preamble
      Judge only the tone of the last assistant message with text.
      - Friendly and professional: advance to `answered`.
      - Curt or cold: advance back to `reply`, saying exactly what to change.
      - If the trail already holds two steps with kind "grader" and to "reply",
        raise `reply-tone` instead of sending it back again.
    model: gpt-4.1-mini          # optional; resolved under the `grader` model role
    budget: { maxTurns: 4, timeoutMs: 60000 }   # ITS OWN model calls / run time; no maxParks
    on_error: closed             # fails closed: an undecided grader routes here
    transitions:                 # REQUIRED, at least one; no evidence/approvers on a grader
      - { to: answered, description: The reply is friendly and professional. }
      - { to: reply, description: The tone is off; send it back naming what to change. }

  answered:                      # TERMINAL code state: the session completes when the script
    type: code                   #   returns — "approve, then end" with no further model call
    script: scripts/record-reply.js

  closed:                        # bare key = terminal (agent) state with no declarations
```

## Machine rules

- **Movement.** The agent moves only by `archmax_advance({ to, reason, evidence? })`
  — one per message, edge and `requires` validated, then the target's tools
  unlock (or, for a grader or code target, the target runs at once). A state
  with no transitions is terminal; the run ends when the agent finishes there.
  Human decisions, `on_error`, and grader and code states' own `archmax_advance`
  are the other movers. `archmax_reset({ reason })`
  returns to the entry state (forbid it via `forbid_always` when a run must
  never restart). No fan-out: sequence states; concurrency lives in
  sub-workflow calls.
- **Entry.** At least one state declares `triggers`; one state per trigger id;
  `manual` is the entry the CLI, a host firing and a caller all use. A
  re-invoked finished session is a **new turn in the state it ended in**, not
  at the entry (one that completed in a terminal code state opens at its
  trigger's entry) — give a state re-entry transitions if a conversation must
  move on, or park instead of finishing.
- **Variables.** One flat checkpointed `name → value` store, never declared.
  Host seeds (`--variables`, `createAgent({ variables })`, a delivery) are
  **locked**; the agent uses `archmax_get_variables`/`archmax_set_variables`
  (`lock: true` to freeze, until `archmax_reset` releases the agent's locks).
  A value that must be decided in one place yet stay correctable belongs to a
  state: `locks: [order_id]` lets only that state write it, so a change routes
  back there. Reserved: `trigger` (current trigger id, always
  locked) and `title` (the run's one-line task label, agent-owned; a
  sub-workflow child is not asked for one). A
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
  A grader state's `model` is resolved under the `grader` model role
  (`modelFactory("grader", env, id)`), a sub-workflow uses its own spec's, and a
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
- **Failing.** When the work cannot be completed, the agent calls
  `archmax_raise({ code, reason })` (alone in its message; any state): the
  session ends at once `failed`, with the agent's free-form `code` and
  `reason` as the outcome's `exit` — no `on_error` route, no `returns`
  check. A session that never raises is a success, so it is for failure
  only. Forbid it (`forbid_always`, or a state's `forbid`) where the
  agent must not end the run itself; a child that raises fails its caller's
  call with kind `raised`.
- **Human states** park with a record built from `instructions`, `evidence`
  and transition `type`s. The handoff spends one reply-only model call so the
  park carries a message — do **not** instruct the agent to announce the
  handoff (two messages). While parked, `archmax reply` is answered on a
  reply-only turn (every tool call refused) and re-parks unchanged; only
  `decide` moves the run. A
  `refine` edge delivers the reviewer's comment as correction.
- **Grader and code states** (automated states). A **code** state runs
  `script: scripts/<x>.js` in the sandbox; a **grader** state runs an isolated
  grader whose criteria are the state's `instructions` and which reads the
  session with `archmax_get_history` (`{ messages, trail, toolCalls }`: the
  whole transcript, trail and tool calls with their results). Both run on
  entry — however the session got there — with **no call of the agent's model**
  (a chain of code states makes none at all), and leave like every state:
  `archmax_advance` along one of their transitions, whose `reason` reaches the
  next state as a `[code]`/`[grader]` runtime note and a `kind: code|grader`
  trail step, or `archmax_raise`. A **terminal** code state completes the
  session when its script returns. Throwing, timing out, a spent grader budget,
  or a non-terminal state that finishes without either call **fails closed** →
  `on_error`. Each is offered exactly its own state's surface (its grants,
  `archmax_advance`, `archmax_raise`, the variable tools; a grader also
  `archmax_get_history`), governed like the agent's calls — never
  `write_todos`, `archmax_eval`, `archmax_run`, `archmax_wait`,
  `archmax_reset`, even when `allow_always` lists one (a state's own
  `tools.allow` naming one is an error): an automated state cannot park.
  There is no iteration budget: a state that gives up after N rounds counts
  them in the trail. Per type, `validate` errors on: a code state's
  `instructions`/`model`/`budget`/`evidence`/`approvers`; a grader without
  `instructions` or without a transition, or with `evidence`/`approvers`/
  `budget.maxParks`. There are **no `before:`/`after:` hooks and no root
  `extensions:`** — a leftover key is a load error naming it. Script contract:
  [`code-states-and-scripts.md`](code-states-and-scripts.md).
- **Automated-state patterns.** A deterministic check **in front of** a state:
  make the trigger's entry (or the edge's target) a code state that advances
  to the work or to a state that declines it. A check **behind** a state: point
  the state's transition at a code state that advances onward, or back with
  the fix as its `reason` — the agent reads it and advances again. **Approve,
  then end**: approve into a terminal code state, which costs no model call.
  Judgment (tone, completeness): a grader behind the graded state with an edge
  back; its `instructions` say when to raise ("after two send-backs" = two
  trail steps `{ kind: grader, to: <graded state> }`).
- **Budgets and `on_error`.** `budget.maxTurns`/`timeoutMs`/`maxParks` bound
  a state's segment (on a grader: its own model calls and run time; a code
  state takes no `budget`, `settings.timeoutMs` bounds its script); the root
  `budget.maxModelCalls` (default 50) bounds the agent's model calls across a
  whole turn, so a cycle between states ends there (an automated state's run
  spends none of it). A terminal failure (exhausted budget, exhausted parks, a
  grader or code state that fails) routes to `on_error` instead of failing the
  run; recoverable rejections (invalid edge, unmet `requires`) keep the agent
  in place. Declare `on_error` on every automated state and on bounded loops.
  A **tool that throws** is neither: the call is answered with an error-status tool message carrying
  the error, the agent stays in the state and can retry or switch tools, and
  `on_error` never sees it (a park or a cancelled run still propagates).
- **Sub-workflows are tools.** Allow `archmax_workflow_<slug>` (slug verbatim)
  and the sibling `workflows/<slug>/` is callable: its `manual` trigger's
  `requires` are the parameters (typed where the entries are typed; a
  mistyped argument is refused `invalid-param`, and `"${{count}}"` alone
  passes the value with its own type), its `returns` the result
  (`{ message, returns }`; a child finishing with some unset completes, and
  `returns` holds every declared one, the unset ones `null`, plus a `note`
  naming them; a mistyped typed return fails `invalid-return`). Returns are
  owed only at the finish: no state needs them to be left, a later write
  replaces an unlocked earlier one, and a seed of one lands unlocked; lock one
  only once it is final. Each failed call is the
  calling state's failure, recorded with its arguments and routed through
  `on_error` when the agent finishes unless a later successful call of the
  same workflow from the same state recovers it first. One success recovers
  one failed call: the one whose arguments it repeats (compared after
  `${{…}}` resolves, key order ignored), else the oldest. A sibling in the
  same batch does not count; another workflow's success recovers nothing;
  the route names every outstanding failure with its arguments.
  The trigger's `description` leads the tool description. Nothing captures the result — the caller records
  what it needs with `archmax_set_variables`, made mandatory by `requires`.
  The child is a separate session with a fresh transcript, sees only its
  arguments (as locked variables), and shares no prose. One call = one
  sub-run; fan out with parallel tool calls or `Promise.all` in a script
  (bounds: depth 3, 4 concurrent). A child's human state parks the child;
  a script's delegation cannot park and fails closed.
- **Choosing a mechanism.** Deterministic work the agent triggers → an
  `archmax_run` script. Deterministic work the graph runs at a fixed point (a
  screen, a policy check, a record) → a code state. Delegated work that is itself
  a process or reused across workflows → a sub-workflow. Judging work already
  done → a grader state. Neither automated kind is callable by the agent (`task`
  is disclosed nowhere and not grantable).
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
script, criteria or transitions, and no count of the states:

```
Transitions — choose one with `archmax_advance` when this state's work is done:
- to `check-policy` (code) — The decision is recorded in scratchpad/refund.json.
- to `review` (human decision node) — The decision is recorded and needs a person's approval.
- to `grade-reply` (grader) — The reply has been sent to the customer.
- to `closed` (terminal) — Nothing to refund; the case is answered.
```

A `(grader)` or `(code)` target runs on its own and may send the run straight
back with a note saying what to change.

Two rules follow, and they are the ones authors get wrong:

1. **Write the `description` for the source state, not the target.** The agent
   reading it knows nothing about where it is going. Say *when* the edge applies:
   `The refund is over $50, or the customer has asked twice.` Not `Go to
   refund-review.` — that tells a reader who already knows the graph something
   they cannot use, and tells this reader nothing.
2. **Routing conditions cannot live downstream.** A target's `summary` is never
   disclosed to the state routing into it, nor its `instructions` across a
   described edge. If the condition is "when the order is over 30 days old", it
   belongs on the edge.

An **undescribed** edge (no `description`, or a blank one) routes on its target's
`instructions` instead, quoted under the edge's line as what the agent will do
once there: leave one undescribed only when those instructions already say when
it applies. It is a **load error** where the target has no instructions, on a
human state's transitions (the description is the button label), and into a
grader or code state (a grader's instructions are criteria the work is never
shown; a code state has none). A code state's own edges may go undescribed: its
script routes. There is no other way to see more of the graph.

## Governance

Closed by default; **deny beats allow, and no narrower level widens a denial.**

- **The workflow-wide grant**: `tools.allow_always`, in every state. Absent,
  it is the **default tools**: `ls`, `read_file`, `write_file`, `edit_file`,
  `copy_file`, `move_file`, `remove_file`, `glob`, `grep`, `write_todos`,
  `archmax_eval`, `archmax_run`. Declared (`[]` included), it is exactly what it
  lists and **replaces** the default tools, so a new workflow lists all twelve
  (as in the skeleton) and removes only what it must not have. Never declared:
  the controls `archmax_advance`, `archmax_reset`, `archmax_wait`,
  `archmax_raise`, `archmax_get_variables`, `archmax_set_variables`, and a host's
  `essentialTools`. Any other tool needs an `allow`/`allow_always` entry. A
  state entry naming a granted tool **narrows** it there, and one naming a
  default tool the list omits grants it there. `task` is ungrantable (error).
- **In a grader or code state** the surface is what the state is granted (the
  workflow-wide grant included), minus `write_todos`, `archmax_eval`,
  `archmax_run`, `archmax_wait` and `archmax_reset` even when `allow_always` lists
  them (naming one in the state's
  own `tools.allow` is an error), plus `archmax_advance`, `archmax_raise`,
  `archmax_get_variables`, `archmax_set_variables`, and `archmax_get_history`
  for a grader — never `archmax_wait` or `archmax_reset`.
- **Entries**: bare name; `{ tool, args: { <arg>: ["glob", …] } }` (matches
  if any glob matches; `${{var}}` allowed). An argument the tool declares as a
  path (else `file_path`) is canonicalized first; any other argument (a URL, an
  address, an email) is matched **as written**, and a denial also catches its
  path form. `""` matches only an empty value. `*` never crosses `/` (`**` does).
  `{ tool, paths: [...] }`
  (guards every path argument the tool declares — all must match to grant,
  any matching denies). `"*"` as the tool is legal only in a
  forbid list. Globs match dot-segments (`secrets/**` covers `secrets/.env`).
- **Path rules read declared path arguments**: `copy_file`/`move_file` take
  `{ source, destination, overwrite? }` (copy reads `source`, move removes it;
  both write `destination`), `remove_file` takes `{ file_path }`. A removal is
  refused wherever a write is; a call naming several paths is refused when any
  one is. An existing destination is refused unless `overwrite: true`.
  `forbid: [{ tool: "*", paths: [secrets/**] }]` blocks a copy in or out.
- **Skills** are governed by **slug**, never path. Enabling a bundle makes
  `skills/<slug>/**` readable and its scripts runnable with no `tools.allow`
  entry; a disabled bundle is unreachable **and invisible** (not listed, not
  in the prompt). `allow` adds, `forbid` subtracts, `allow: []` denies
  nothing. A `tools.allow` entry may still narrow *within* an enabled bundle.
  A state enabling no skill can run no script at all.
- **Scripts' `tools.*` calls** are governed per call against the state they
  run in: an `archmax_run` script is bound like the model (grant every tool it
  calls in the agent's state); a code state's script is bound by **its own**
  state's grants (`tools`, `skills`, `mounts`) — there is no runtime authority.
  `tools` holds exactly that state's surface: anything else is `undefined`.
  Neither may read `workflows/**` or write a read-only mount. A refused call
  rejects inside the script.

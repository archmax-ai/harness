# workflow.yaml — exhaustive schema reference

The complete, field-by-field reference for authoring a `workflow.yaml` (and its
optional `WORKFLOW.md` prose addendum) plus the surrounding workspace. Targets
**runtime contract version `"2"`**.

## Contents

- [File shape](#file-shape)
- [Root fields](#root-fields)
- [States (`MachineState`)](#states-machinestate)
- [Transitions](#transitions)
- [Tool governance](#tool-governance)
- [Skill governance](#skill-governance)
- [Mount governance](#mount-governance)
- [Lifecycle hooks](#lifecycle-hooks)
  — full script contract + worked examples in
  [`hook-and-test-scripts.md`](hook-and-test-scripts.md)
- [Budgets & error routing](#budgets--error-routing)
- [Human states](#human-states)
- [Sub-workflows are tools](#sub-workflows-are-tools)
- [Removed keys you may meet in an older workflow](#removed-keys-you-may-meet-in-an-older-workflow)
- [Workspace layout: skills, scripts](#workspace-layout)
- [Cases](#cases)
- [Code description docblocks](#code-description-docblocks)
- [Read-only zones](#read-only-zones)
- [Annotated example: order-lookup](#annotated-example-order-lookup)

---

## File shape

**Two-file layout** under `workflows/<name>/`:

- **`workflow.yaml`** — the canonical, enforced machine spec: a **pure YAML
  mapping** (no `---` frontmatter fences, no markdown). Parsed with YAML 1.2
  semantics and validated against the schema. Top-level keys: `title`,
  `instructions`, `runtime`, `settings`, `tests`, `tools`, `skills`, `mounts`,
  `extensions`, `editor`, `states`.
- **`WORKFLOW.md`** (optional, beside it) — a plain-markdown prose addendum with
  **no frontmatter**. A frontmatter block in `WORKFLOW.md` when `workflow.yaml`
  exists is a **validation error**. The runtime renders the system prompt's
  workflow header deterministically from the spec (`title` + `instructions`, and
  NO state of the graph) and appends the `WORKFLOW.md` prose after it — prose is
  never load-bearing and cannot disagree with enforcement. The graph is disclosed
  per model call, for the ACTIVE STATE ONLY.
  There is no "frontmatter wins" rule anymore; `workflow.yaml` is the only
  authority.

**Removed**: the single-file `WORKFLOW.md` layout (YAML frontmatter + markdown
body, without a `workflow.yaml`) no longer loads — it is a load error. Migrate by
moving the frontmatter into `workflow.yaml` and stripping the fences from the
prose.

## Root fields

```yaml
title?: string                # the workflow's HUMAN-READABLE name (metadata only).
                              # Identity is the WORKFLOW SLUG — the directory name
                              # (`workflows/<slug>/`, also the CLI argument), authored
                              # in the SAME kebab-case as state slugs
                              # (`order-lookup`); validate ERRORS on a missing or
                              # non-kebab workflow slug, exactly as for a state slug.
                              # A top-level `name:` is REMOVED — it is
                              # a load/validate ERROR; rename it to `title:`.
instructions?: string         # the workflow's STANDING instructions — free-form
                              # markdown, direction that holds for the WHOLE run
                              # (conventions, house rules, what "done" means).
                              # Author it as a LITERAL block (`|-`), not folded
                              # (`>-`): it renders as markdown, and folding
                              # collapses blank lines into one run-on paragraph.
                              # Rendered verbatim as an `## Instructions` block at
                              # the top of the workflow prompt section (unlike a
                              # state's `instructions`, which are per model call) —
                              # so it lands in the static,
                              # cacheable prefix. validate WARNS when absent,
                              # ERRORS when present but not a non-empty string.
                              # A top-level `description:` is REMOVED and now
                              # simply ignored; use `instructions:`, rereading the
                              # text as direction, not narration.
                              # A test case's `description` is UNAFFECTED. A
                              # TRANSITION's `description` is now REQUIRED and
                              # non-empty (see `transitions` below).

disabled?: boolean            # `true` = this machine STARTS NO NEW TURNS. Bounds
                              # STARTING, not finishing.
                              # REFUSES: `archmax run` (one line, non-zero exit, no
                              # session minted); a host `invoke`; a firing on a fresh
                              # session; a FOLLOW-UP message to a settled session
                              # (a new turn is new work) — all rejected AT THE TURN
                              # BOUNDARY with `status: rejected` and
                              # "Refusing to start: workflow '<slug>' is disabled.",
                              # before any state, hook or model call; and a caller's
                              # `archmax_workflow_<slug>` call (blocked call, refusal
                              # kind `disabled`, before a child is composed — it also
                              # beats a declared MOCK, so a case can never assert a
                              # delegation production would refuse).
                              # STILL WORKS: assembly; `decide` / `reply` / `deliver`
                              # (each resumes an unfinished turn, so parked human
                              # decisions are never trapped); `archmax validate` (full,
                              # plus a warning); and a CALLER's assembly — the tool is
                              # still bound, so disabling one leaf never takes its
                              # callers offline (validate WARNS on each state that
                              # allows a disabled target).
                              # `archmax test` SKIPS the suite and exits 0 — not run is
                              # not failed. There is NO flag to force cases to run.
                              # Read FAIL-CLOSED: anything but an absent key, `null` or
                              # boolean `false` disables the workflow, so `disabled:
                              # "no"` STOPS runs; validate ERRORS on a non-boolean.
                              # NOT a kill switch for work in flight, and NOT a
                              # per-state/per-trigger switch (that is a forbid list).

runtime?:
  engine?: string             # "archmax-harness"
  version?: string | number   # target contract — use "2"

settings?:
  model?: string              # MODEL ID ONLY — the id every state of this workflow runs
                              # on, over the endpoint/credentials the assembly already
                              # has. Overrides ARCHMAX_MODEL; a state's `model` overrides
                              # it. NOT a block: `{ id, temperature }` is a load error —
                              # sampling and endpoint are env/host configuration.
                              # Opaque: nothing validates the id against a list.
                              # Does NOT change the case grader (tests.judge.model).
  timeoutMs?: number          # default 15000; per eval/lifecycle script (sandbox budget)
  memoryLimitBytes?: number
  maxPtcCalls?: number | null
  maxResultChars?: number
  prompt_cache?:
    enabled?: boolean         # default true (provider prompt caching)
    ttl?: "5m" | "1h"         # default "5m"

tests?:                       # cases suite config (declarative data;
                              # tests.config.js is REMOVED — see Cases)
  maxConcurrency?: number     # only 1 (or absent) accepted — concurrency is
                              # not implemented; >1 is a validate error and
                              # fails `archmax test` loudly
  caseTimeoutMs?: number      # per-case WALL-CLOCK budget, default 120000 —
                              # deliberately named differently from
                              # settings.timeoutMs (per-script sandbox budget)
  judge?:                     # {} = enable the grader with the
    model?: string            #      env-configured default model
    modelOptions?: { temperature?: number, maxTokens?: number }
                              #      applied over the env model config, via the
                              #      factory's `judge` role; other keys are errors

tools?:
  allow_always?: AllowEntry[] # grants added to every state's allowlist
  forbid_always?: ForbidEntry[]
                              # DENIED in EVERY state, and absolute: nothing reaches
                              #      past it — no state grant, allow_always entry,
                              #      argument guard or consumer rule. Same entry
                              #      grammar as allow, plus the tool "*" meaning
                              #      EVERY tool: { tool: "*", paths: ["logs/**"] }
                              #      denies that path to everything. "*" in an
                              #      ALLOW list is a load error.
                              #      Guards narrow what is denied; globs match
                              #      dotfiles (secrets/** covers secrets/.env).
                              #      Inherited by every sub-workflow, naming the
                              #      workflow that declared it. There is NO
                              #      `policy:` block — writing one is a load error.

skills?:
  allow_always?: string[]     # SKILL SLUGS enabled in EVERY state of this workflow —
                              # the bundle directory names under skills/, kebab-case.
                              # NEVER paths, NEVER globs: the unit you govern is the
                              # capability. This is the skills half of
                              # tools.allow_always: a GRANT, which a state's own
                              # `skills.allow` ADDS to (the enabled set is the UNION),
                              # so no state repeats it and no state can subtract from
                              # it. ABSENT = none granted workflow-wide, exactly like
                              # `allow_always: []` — write the empty list when every
                              # capability here is state-specific.
                              # validate ERRORS on: a slug no source provides (it
                              # lists the known ones), a path/glob/non-string entry,
                              # a bundle whose SKILL.md `name:` ≠ its directory; and
                              # WARNS on a state entry this list already grants
                              # everywhere, and on a state's `allow: []` beside it
                              # (an empty state list subtracts nothing).
  forbid_always?: string[]    # SKILL SLUGS out of reach of EVERY state, whatever any
                              # list grants. Deny beats allow. (The retired root
                              # `allow` ceiling is a load error: one skills model.)

mounts?:
  allow_always?: MountGrant[] # MOUNT NAMES reachable in EVERY state of this workflow —
                              # the keys of the HOST's mount table with their slashes
                              # stripped (`reference`, `catalogs/eu`, `AGENTS.md`).
                              # NEVER globs: scope paths WITHIN a reachable mount with
                              # a tools.allow entry. Only a mount the host declared
                              # `governed: true` needs a grant — an UNGOVERNED mount is
                              # visible in every state already, and a grant naming one
                              # is inert (validate warns). The skills model exactly: a
                              # GRANT a state's `mounts.allow` ADDS to (the reachable
                              # set is the UNION), never a ceiling. ABSENT = this
                              # workflow reaches no governed mount; validate says so
                              # ONCE, naming them — write `allow_always: []` to mean it.
                              # An entry is a NAME, or `{ mount: <name>, access: read |
                              # read_write }` to say what this level gives. The host's
                              # readOnly is a CEILING: `read_write` on a read-only mount
                              # opens nothing (validate warns); `read` NARROWS a
                              # writable one, and no narrower level widens it back.
                              # validate ERRORS on a name the table does not mount.
  forbid_always?: string[]    # MOUNT NAMES out of reach of EVERY state, governed or
                              # not, whatever any list grants. Deny beats allow.
                              # Inherited by every sub-workflow, naming the workflow
                              # that declared it. A NAME only — a denial is total, so
                              # there is no `access` to qualify. (A root `mounts.allow`
                              # is a load error: one mounts model.)

extensions?:
  hooks?: string[]            # custom hook kinds (beyond script/rubric) the
                              # runtime registers executors for; undeclared
                              # unknown hook kinds are validation errors

editor?: Record<string, unknown>   # HOST PRESENTATION METADATA — an authoring
                              # UI's own state (canvas state positions keyed by
                              # slug, edge routing). The one key the runtime
                              # never reads: not shape-checked, not prompted,
                              # not governed, and excluded from the spec hash.
                              # Do NOT author it by hand and do NOT invent a
                              # use for it — but PRESERVE it verbatim when you
                              # rewrite a spec that already carries one, or the
                              # builder that wrote it loses every state position.
                              # The root is otherwise STRICT: any other
                              # unrecognized key is a load error.

states: Record<slug, MachineState>     # REQUIRED; ≥1 state, ≥1 with a trigger
                                       # the KEY is the state's SLUG (see below)
```

## States (`MachineState`)

Each key under `states` is the state's **slug**: its identity, and the only thing
that resolves it — `transitions[].to`, `on_error`, the `to` the agent passes to
`archmax_advance`, emitted events, session artifacts, and cases
`reachedState` assertions are all slugs. Author slugs as **hyphen-separated kebab-case** — lowercase alphanumeric
segments joined by single hyphens (`^[a-z0-9]+(-[a-z0-9]+)*$`, e.g.
`identify-case`, `report-requested`); no underscores, capitals, doubled hyphens,
or leading/trailing hyphens —
`validate` reports a nonconforming slug — or a state declared under an empty key,
which has no identity at all — as an **error**. A slug is a reference target, so
rename one only deliberately, and update every reference to it.

```yaml
states:
  <state-slug>:
    requires?: [string]        # RUN VARIABLES this state must have set before it can
                               # be left: archmax_advance out of it is refused,
                               # recoverably, while any is unset. Variables are not
                               # declared anywhere, so this list — together with a
                               # TRIGGER's `requires` (see below) — is
                               # the only spec-visible statement that a variable will
                               # exist, which is what makes a ${{name}} guard
                               # reference GUARANTEED rather than dependent on agent
                               # behavior. Name here anything a downstream guard
                               # reads.
    title?: string             # HUMAN-READABLE label. Presentational only: carried
                               # in a human state's pending-decision record and shown
                               # in host surfaces. REACHES NO MODEL CALL. Never a
                               # routing target — `to` always takes a slug — so
                               # rewording it changes no behavior. Not unique.
                               # NOT a substitute for `instructions` (behavior
                               # guidance) or a transition `description` (routing).

    type?: "agent" | "human"
                               # default "agent". "human" = a person routes.
                               # (`workflow` was removed: a state CALLS another
                               # workflow by allowing `archmax_workflow_<slug>`.)


    triggers?: Record<triggerId, TriggerDeclaration | null>
                               # marks a start state. The KEY is the trigger id
                               # and THIS state is that trigger's entry state —
                               # the one place a trigger is declared.
                               #   manual:            = CLI/Deep-Agent entry
                               #                        (prompt = input)
                               #   <other id>:        = tool/event trigger
                               #   a null/empty value = the id and nothing more
                               # SEVERAL keys = the state is the entry for EVERY
                               #   id, in declaration order (one state, one
                               #   behavior, several ways in).
                               # The value is the declaration (see below):
                               #   session/message/connection/description/
                               #   requires/returns
                               #   plus any key the HOST adds — preserved,
                               #   lint-warned, never interpreted.
                               # NO `entry:` and NO `name:` inside a declaration:
                               #   the state it sits on IS the entry and the key
                               #   it sits under IS the id. Either one fails load
                               #   naming the key. There is also no root
                               #   `triggers:` block.
                               # An id is AUTHORED, so deleting or reordering a
                               #   sibling never moves it — hosts key deployments
                               #   on that id.
                               # two states declaring the same trigger id is a
                               # validation ERROR (start states must be
                               # unambiguous). A trigger has ONE entry state; a
                               # mapping with several keys is several triggers
                               # entering one state. A repeated id on one state
                               # is impossible — YAML mappings cannot repeat a key.
                               # A shared entry state has ONE behavior: branch on
                               # `${{trigger}}` / `args.trigger` where the paths
                               # differ, or use separate states.

    summary?: string           # ONE-LINE label for AUTHORS AND HOSTS (an editor's
                               # node caption, a generated diagram). RENDERED INTO
                               # NO PART OF THE PROMPT — the model never reads it,
                               # so it is free, and it can NOT carry routing logic.
                               # The routing text the agent reads is the SOURCE
                               # state's transition `description`s; nothing about a
                               # target state is disclosed at all.

    instructions?: string      # behavior guidance.
                               #   agent node: surfaced to the LLM while active.
                               #     Write the state's behavior INLINE here; a
                               #     skill bundle (skills/<slug>/) is a capability
                               #     with data or scripts, enabled by slug — not a
                               #     per-state instruction sheet.
                               #   human state: describes the decision for the packet

    before?: HookSpec          # gate ENTRY to this state (fail-closed)
    after?: HookSpec           # gate the archmax_advance OUT (or run at completion
                               #   for a terminal state)

    tools?:
      allow?: AllowEntry[]     # grants beyond the always-on tools (plus
                               # allow_always grants and the always-allowed
                               # archmax_advance); an entry naming
                               # an always-on tool NARROWS it.
      forbid?: ForbidEntry[]   # what this state DENIES while active — beating the
                               # workflow's allow_always, this state's own allow,
                               # and the always-on surface alike. Deny beats allow.
                               # Not inherited by a sub-workflow; a lifecycle hook
                               # is exempt from it (runtime authority).

    skills?:
      allow?: string[]         # which CAPABILITIES this state ADDS, by SLUG — on top
                               # of the root's `skills.allow_always`, which is enabled
                               # here whatever this says. ABSENT = adds none, the same
                               # as `allow: []`. An empty list is NOT a deny (validate
                               # warns about one that reads like it) — `forbid` is.
      forbid?: string[]        # SLUGS this state does NOT get, subtracting from the
                               # workflow's allow_always and from its own allow.
                               # Refused as `skill.forbidden` (vs `skill.not-allowed`
                               # where nothing granted it).
                               # Enabling a slug is a GRANT: skills/<slug>/** becomes
                               # readable and its scripts runnable with NO tools.allow
                               # path entry. Not enabling one makes the bundle
                               # unreachable (read/ls/glob/grep/archmax_run all
                               # blocked, rule `skill.not-allowed`, above every
                               # declaration) AND undisclosed — its slug and
                               # description never enter this state's prompt, and a
                               # listing of skills/ does not show it.
                               # A tools.allow entry still NARROWS within the enabled
                               # set: the two compose as enabled AND allowed.
                               # Lifecycle HOOKS are exempt — a `before` hook reading
                               # skills/order-data/assets/orders.json still works in a
                               # state that enables nothing, so you can gate the
                               # agent's use of a capability while keeping the hook
                               # that enforces it.

    mounts?:
      allow?: MountGrant[]     # which MOUNTS this state ADDS, by NAME — on top of the
                               # root's `mounts.allow_always`, which is reachable here
                               # whatever this says. ABSENT = adds none, the same as
                               # `allow: []`. An empty list is NOT a deny (validate
                               # warns about one that reads like it) — `forbid` is.
                               # An entry may name its access:
                               #   allow: [{ mount: shared, access: read }]
                               # reads a writable mount without writing it here. The
                               # host's posture is the ceiling — `read_write` cannot
                               # open a read-only mount — and a `read` at either level
                               # holds, so a state never widens what the workflow
                               # narrowed. A write refused by THIS key is
                               # `mount.read-only`; one refused by the WIRING is
                               # `zone.read-only`.
      forbid?: string[]        # MOUNT NAMES this state does NOT get, subtracting from
                               # the workflow's allow_always, from its own allow, and
                               # from an UNGOVERNED mount's standing visibility alike.
                               # Refused as `mount.forbidden` (vs `mount.not-allowed`
                               # where nothing enabled it).
                               # A governed mount this state does not have is
                               # unreachable (read/ls/glob/grep all blocked, above
                               # every declaration) AND undisclosed — absent from the
                               # volatile prompt block, and filtered out of every
                               # ls/glob/grep result, the WORKSPACE ROOT LISTING
                               # included. Lifecycle HOOKS are exempt from this key
                               # (runtime authority), but not from `forbid_always`.

    model?: string             # MODEL ID ONLY — this state's turns run on it (and the
                               # handoff message of a park it holds). Most specific of
                               # state.model > settings.model > the assembly's default
                               # (createAgent `model`/`modelFactory`, else ARCHMAX_MODEL).
                               # Same id as settings.model ⇒ validate WARNS (inert).
                               # A rubric keeps its own `model`; a sub-workflow resolves
                               # its OWN spec's ids — nothing is inherited across it.
                               # A host passing an explicit `model` INSTANCE to
                               # createAgent outranks every declared id (one assembly
                               # warning names them); `modelFactory` is what honours one.

    budget?:                   # per-state execution budget
      maxTurns?: number        # bounds this turn's agent loop
      timeoutMs?: number       # aborts the turn when exceeded
    on_error?: string          # state to route to on a TERMINAL failure
                               # (see Budgets & error routing)

    transitions?: Transition[] # outgoing edges. EMPTY/absent ⇒ terminal state.
                               # `parallel:`/`join:` are REMOVED — a run traverses
                               # one state at a time; sequence what were branches.
                               #
                               # Transition = {
                               #   to: string          # a declared state's SLUG
                               #   description: string # REQUIRED, non-empty
                               #   type?: "approve" | "reject" | "refine" | "none"
                               # }
                               #
                               # THE AGENT SEES THIS STATE'S EDGES AND NOTHING
                               # ELSE OF THE GRAPH — no other state's slug, title,
                               # summary, hooks or transitions, and no count of
                               # the states. So `description` is the whole of what
                               # it knows about where an edge leads, and a missing
                               # or blank one is a LOAD ERROR naming
                               # states.<slug>.transitions.<i>.description.
                               #
                               # Write it for a reader standing in THIS state,
                               # which knows nothing about the target:
                               #   GOOD: "The refund is over $50."   (when)
                               #   BAD:  "Go to refund-review."      (where)
                               # A routing condition CANNOT live in the target's
                               # summary/instructions — those are never disclosed
                               # to the state routing into it.
                               #
                               # The rendered line marks a target that is a human
                               # decision node or terminal (each changes the call
                               # or what follows it); nothing else of the target.

    # human states only (ignored on agent states):
    evidence?: string[]        # workspace-relative paths always shown in the packet —
                               # a baseline the advancing agent adds to (see Human states)
    approvers?: string[]       # informational; not enforced
```

## Parking and sessions

A state parks the run **itself**: once it has asked for what it needs, its agent
calls `archmax_wait({ reason })` and the run suspends right there — no transition,
no model call spent parking. A delivered event resumes that same state, which
reads what arrived and then picks its own outgoing transition:

```yaml
clarify:
  title: Ask a clarifying question
  instructions: >-
    Ask exactly one clarifying question, then call archmax_wait with a reason
    naming what you are waiting for. When the reply arrives you continue here:
    read it, and if it identifies the order, advance to answer.
  transitions:
    - { to: answer, description: The reply identifies the order. }
    - { to: closed, description: The conversation closed before a usable reply. }
```

What to know:

- `archmax_wait` is available in **every** state, terminal ones included — a run
  that has answered and now awaits a reply parks where it answered instead of
  finishing. `tools: { forbid_always: [archmax_wait] }` removes it workflow-wide.
- The park is durable: status `awaiting_input` (classified **open**, never
  finished), a checkpointed record of the state and the reason, and the process
  may exit.
- **Any** delivered trigger id resumes a park — the id is recorded as the run's
  current trigger (`args.trigger`, `${{trigger}}`), never matched against an edge.
  The delivered variables arrive **locked**, and the arrival is written into the
  transcript as an `[event]` **runtime note** — a synthetic `archmax_note` tool
  call and its result, which is how the runtime says something to a run in a
  channel a model cannot read as a person. Nothing may call `archmax_note`, and
  derived views (`calledTool`, `usedNoTools`, the CLI's flow) skip the pair.
- The removed `type: wait` state kind is now an unknown state kind (`validate`
  reports it as one), and a per-transition `on:` key is ignored. Call
  `archmax_wait` instead.
- When what the state waits for is a **time** rather than a reply, the call says so:
  `archmax_wait({ reason, until: "1d" })` — a duration (`30m`, `2h`, `1d`) or an
  ISO-8601 instant, normalized to an absolute `resumeAt` on the park record, the
  session summary, and the park event. The runtime **schedules nothing**: `resumeAt`
  tells the host's cron when to `deliver`, and an earlier event resumes the park
  regardless. An unparseable `until` is a tool error and the run does not park.
- A state that polls ("look for the transaction, else wait a day and retry") bounds
  its own loop with `budget.maxParks` and sends the overrun somewhere with
  `on_error`; the runtime counts parks per state in the checkpoint and refuses the
  park that would exceed the bound as a turn failure:

  ```yaml
  check-bank:
    summary: Look for the transaction; wait a day and retry if it has not posted.
    budget: { maxParks: 5 }
    on_error: escalate
    transitions:
      - { to: reconcile, description: The transaction was found. }
  ```
- A finished session re-invoked is a **new turn** — it continues in the state the
  previous turn ended in, *not* at the trigger's entry state, which applies only to
  a session's first turn. Give a state re-entry transitions if a conversation must
  move on from it; otherwise the agent's way out is `archmax_reset`. To continue
  mid-state instead, park rather than finish.

A trigger's **declaration** sits under the `triggers:` of the state it enters,
keyed by its id. It says which conversation a firing belongs to and what the run
owes its caller:

```yaml
states:
  intake:
    triggers:
      email_received:
        session: conversation_id
      email_reply:
        session: triggers.-1.conversationId  # newest arrival's conversation id
                                             # unknown/finished conversation → fresh run
  enrich:
    triggers:
      manual:                                # the one entry: CLI, host firing, or a caller
        description: Enrich one order and say whether it is late.  # for callers only
        requires:                            # a firing must supply these to start
          - order_id                         # bare name = untyped
          - { name: due, type: date, description: The day the order is due. }
        returns:                             # the run guarantees these when it completes
          - enrichment_file
          - { name: delayed, type: boolean }
```

- There is no `entry:` key and no root block: the state a declaration sits on is
  the trigger's entry state, written once. `entry:` or `name:` inside a
  declaration fails load naming the key — each would be a second spelling of
  wiring the SDK already reads, and a loose declaration that swallowed one would
  start the run somewhere you did not say.
- `requires:` / `returns:` are the run's **signature**, and both are enforced. A
  firing that does not supply every `requires` name does not start; a run that
  reaches a terminal state without every `returns` name set is rejected (a run
  that *parks* is not checked — it has not finished). Each entry is a bare
  run-variable name (**untyped**: any value, `null` included) or a strict object
  `{ name, type?, description? }` naming one; the spellings mix in one list and
  names are distinct across both. What the agent must *do* to produce a
  variable still belongs in the `instructions` that set it. The names — with
  type and description when declared, as `name (type) — description` — are
  rendered into the prompt under the trigger's entry state, so the agent is told
  what to produce before it can be failed for omitting it. A trigger's
  `requires:` also **guarantees** the variable for `${{…}}` guards, so `validate`
  stops warning about a guard bound to it. This is what makes delegation
  checkable — see [Sub-workflows are tools](#sub-workflows-are-tools).
- **`type`** is one of `string`, `integer` (no fractional part), `number`
  (finite), `boolean`, `date` (RFC 3339 `YYYY-MM-DD`, a real calendar day),
  `date-time` (RFC 3339 with a mandatory `Z`/`±hh:mm` offset), `object` (not an
  array) or `array`. Nothing is coerced (`"4"` is not an `integer`) and a typed
  entry never takes `null`. It is held **at the start** (a mistyped seed is
  refused before any model call), **at the write** (`archmax_set_variables` of a
  mistyped typed return of the current trigger is a correctable refusal,
  nothing written) and **at completion** (a mistyped typed return rejects the
  run — in practice a script or hook write). There are no enums, item or
  property schemas, ranges or optional inputs. An unknown `type`, an unknown
  entry key (`default:`) or an empty `description` fails load.
- **When to type.** Type an entry when something outside the session reads the
  contract: a delegating model that must build the argument, a host publishing an
  MCP tool or a start form. Leave it bare when any value will do. Typing a
  `returns` entry also tells the agent the shape to write.
- **`description` on the declaration** says, for a **caller**, what calling this
  entry does. It leads the delegation tool's description and a host's MCP tool
  description; it never reaches the model of the session it starts (that
  session's brief is its `instructions`). An entry's own `description` is
  different: it *is* shown to the agent, beside the name.
- `session:` is a **dotted path over the run's variables** — the same syntax
  `${{…}}` guards use, including array indices and negative indices
  (`-1` = last). No script, no callback: name where the host already puts the
  conversation id. A `${{…}}`-wrapped value is rejected — write the bare path.
- Related triggers that must land in the same conversation declare the **same
  path**. Each declares it itself: there is no shared lookup to change from
  elsewhere in the document, and the duplication is the deliberate cost of a
  state being legible on its own.
- A trigger with no `session:` path — or a firing whose path does not resolve —
  gives that run a session of its own (its session id). Every run has exactly one
  session, so there is no absent case.
- `message:` and `connection:` are **host-resolved** keys: shape-checked,
  preserved and readable back (`messagePathForTrigger`, `connectionForTrigger`),
  but nothing in the runtime acts on them. `message:` takes `session:`'s dotted
  path — where a firing's words are — or the literal `false` for a trigger whose
  firings carry no message; `connection:` is an opaque non-empty slug naming an
  access connection in the host's own configuration. Author them only if the host
  you are targeting reads them.
- A declaration key the SDK does not define is a **warning**, not a load failure:
  it is ignored, and the workflow still runs. Structural problems — a
  non-mapping `triggers:`, a declaration that is neither a mapping nor empty, one
  id declared by two states, a malformed `session`/`message` path, an empty
  `connection`, an `entry:` or `name:` key — still fail load.
- A host's own keys ride **inside the declaration**, keyed by the trigger id:

  ```yaml
  states:
    intake:
      triggers:                                  # one state, two event sources
        outlook-mail: { type: ap, piece: microsoft-outlook, event: newEmail }
        slack-message:
          type: ap
          piece: slack
          event: newMessage
          session: triggers.-1.threadId
          connection: acme-slack
  ```

  One state, one behavior, one governance block; `${{trigger}}` and a hook's
  `args.trigger` still read which one actually fired.
- Every declared trigger **starts** a session. An event that must only ever reach
  a live one — a ticket closing, a payment settling — is declared nowhere: the
  host names the session it delivers into (`archmax deliver <session> --trigger
  <id>`, `agent.workflow.send(sessionId, …)`), or passes a `sessionPath` with the
  firing. A firing naming a trigger no state declares, with no session to reach,
  is refused.

Call `archmax_wait` when an **external event** is what lets the work continue (an
email reply, a webhook, a scheduled reminder the host fires); author a `human`
state when a **person** picks the edge. Both park the session durably; they differ
in the resolution channel and in where the run continues — a decision advances
along the chosen edge, a delivery resumes the parked state.

**Runtime control tools** carry the `archmax_` prefix — `archmax_advance`,
`archmax_reset`, `archmax_wait`, `archmax_run`, `archmax_get_variables`,
`archmax_set_variables` — and are the names to write in `tools.allow`,
`tools.allow_always`, and the `forbid`/`forbid_always` lists. These are the only spellings:
an entry naming an unprefixed variant governs a tool that does not exist,
silently granting nothing. A host tool may never claim the prefix. Deep Agents' built-ins
(`read_file`, `task`, …) keep their own names.

- A state with **no `tools` block** gets the **always-on tools only**
  (`ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `write_todos`,
  `archmax_eval`, `archmax_run`, `task`, plus the always-allowed `archmax_advance` and `allow_always`
  grants — minus
  whatever a `forbid` list denies there, and read-only-zone protection).
  Governance is closed by default; there is no way to declare a fully open state.
- `tools.forbid` on a state **denies** while that state is active, beating every
  grant that would otherwise reach it (see [Tool governance](#tool-governance)).
- A state with **no transitions** is **terminal**: the run ends when the agent
  finishes its turn there; it cannot call `archmax_advance`.

## Transitions

```yaml
transitions:
  - to: string                 # REQUIRED target state SLUG (must exist); never a title
    description?: string        # shown to the agent (or human) to pick the edge
    type?: "approve" | "reject" | "refine" | "none"   # default "none"
```

- On **agent** states the agent chooses one edge via
  `archmax_advance({ to, reason })`; `type` is metadata only.
- On **human** states each transition is a selectable outcome (a UI renders one
  button per edge, labeled by `type`). `refine` conventionally loops back to a
  prior state with the reviewer's comment as correction. Max one transition per
  `type` on a human state.

## Tool governance

`AllowEntry` forms:

```yaml
# 1. bare tool name (any args)
- read_file

# 2. object with glob arg matchers (matches if the arg satisfies ANY glob)
- tool: write_file
  args:
    file_path: ["reports/*.json"]

# 3. `paths` shorthand for args.file_path (string or array)
- tool: write_file
  paths: ["reports/*.json"]
```

An object entry may also carry `connection` (the connection slug a
platform-provided tool resolves through when its collection has several) and
`source` (any string: a host's own label for where the tool came from) — the
runtime matches governance by `tool` name alone and never reads `source`.

**The model is closed by default, and a denial beats every grant.** Every state always has the
**always-on tools** (`ls`, `read_file`, `write_file`, `edit_file`, `glob`,
`grep`, `write_todos`, `archmax_eval`, `archmax_run`). One built-in is **never
disclosed** and grantable by nothing: `task`, the runtime's own dispatch for
grading rubrics — a rubric grades the agent rather than serving it, so naming
`task` in an allow entry is a `validate` error and the kernel refuses the call.
The planning scratchpad `write_todos` and the sandbox
`archmax_eval` are standard equipment — always disclosed, always permitted,
no setting; only a `forbid` list refuses them. The interpreter is safe as a
default because the `tools.*` calls its code makes are decided against the active
state by the same kernel: it adds computation over what the state permits, not
access. `archmax_run` — executing an authored script **file** — is always on on
the same terms (the script is a file the state could already read); declare it
per state to **narrow** which files may run there. Any other tool
must be declared in the state's `tools.allow` or workflow-level
`tools.allow_always`. A `tools.allow` entry naming an always-on tool **narrows**
it for that state.
Denial is declared beside the grant, in the same two positions and with the same
entries: `tools.forbid_always` at the root denies in every state,
`tools.forbid` on a state denies while it is active — subtracting from the
workflow's grant, the state's own `allow` and the always-on surface alike.
**Deny beats allow, and no narrower level widens a denial.** A forbid entry may
name the tool `*` (every tool); `*` in an allow list is a load error. A lifecycle
hook is exempt from the state's `allow` **and** its `forbid` — runtime authority,
outside that surface both ways — but never from `forbid_always`.

Precedence (highest first):

0. **Skill and mount governance** — a path inside a skill bundle the active state
   does not enable is refused before anything below is consulted (rule
   `skill.not-allowed`), and so is a path under a mount the state does not have
   (`mount.not-allowed` / `mount.forbidden`, or `mount.read-only` for a write into
   one a grant narrowed to reads). Nothing widens either: not a wildcard
   `tools.allow` entry, not `allow_always`, not a consumer rule.
1. **Declared denials** — `tools.forbid_always` denies in every state,
   `tools.forbid` denies in the active state, both regardless of any allow list
   (and regardless of always-allowed): deny beats allow, and no narrower level
   widens a denial.
2. **Always allowed**: `archmax_advance` (baked in, every state).
3. **Per-state `tools.allow`** — the listed tools/arg-shapes. An entry for an
   always-on tool (or one also in `allow_always`) takes precedence
   (**narrower wins** — the state's arg globs apply, not the broader grant).
4. **Essential built-ins** — always permitted when no state entry narrows
   them. Listing one in `allow_always` is inert (`archmax validate` warns).
5. **Workflow `tools.allow_always`** — grants tools that are not always on in every
   state.
6. **Default**: everything else is blocked.

**Progressive disclosure.** The model is only shown the active state's tool
surface: always-on tools + `allow_always` + the state's entries + `archmax_advance`
(hidden in terminal states), minus every tool denied there by name. Disclosure is
name-level (arg-constrained tools stay visible; the kernel enforces args at
call time) and never replaces enforcement. **Skills are disclosed the same way**:
each model call names only the skills the active state enables, with their
descriptions — a disabled bundle's slug never reaches the prompt, and `ls skills/`
does not list it.

## Skill governance

Govern a **capability** by its slug, not by path globs. The two levels compose
exactly as tools do: `skills.allow_always` at the spec root is enabled in **every**
state, and a state's `skills.allow` **adds** to it. **A skill is enabled only where
a list names it** — an absent state block adds nothing, exactly as an absent
`tools.allow` grants no tool — and a capability is declared **once**, at the level
where the decision was made:

```yaml
skills:
  allow_always: [order-data]             # enabled in every state, named once

states:
  orders-question: {}                    # no block, and it still has order-data
  refund-review:
    skills:
      allow: [refund-policy]             # this state adds one, and has both
  identify-case:
    skills:
      forbid: [order-data]               # routes only: opts out of the grant
```

A state's `allow: []` is not a deny — a state's `allow` only ever adds
(`validate` warns about an entry that reads like a denial). **`skills.forbid` is
what subtracts**: it removes a slug from that state's enabled set, the workflow's
`allow_always` included, so one state opts out of a capability every other state
keeps; `skills.forbid_always` at the root puts a bundle out of reach everywhere.
There is no root `skills.allow` ceiling — writing one is a load error.

Why by slug, and not with `tools.allow` paths:

- **One declaration covers the whole bundle.** Enabling `order-data` makes
  `skills/order-data/**` readable and its scripts runnable. The path-glob
  alternative needs an entry per tool (`read_file`, `ls`, `glob`, `grep`,
  `archmax_run`) and gets subtly wrong the moment a bundle grows a directory.
- **Path entries do not un-advertise.** A blocked read still leaves the skill's
  name and description in the prompt of every state, so the model keeps reaching
  for a capability it cannot have. A skill that is not enabled is not disclosed.
- **The two still compose** as *enabled AND allowed*: a `tools.allow` entry
  narrows **within** the enabled set. `{ tool: archmax_run, paths:
  ["skills/<slug>/scripts/**"] }` remains worth writing beside the list that
  enables `<slug>` — the skills list puts every other capability out
  of reach, while the entry confines execution to *this* capability's scripts.
  Capability governance and execution governance are different questions.
- **`archmax_run` can only ever be narrowed.** A non-overridable kernel rule
  (`script.skill-only`) confines it to skill bundles, so a script the agent writes
  into `scratchpad/` is unrunnable, a lifecycle hook script is unrunnable, and
  `{ tool: archmax_run, paths: ["**"] }` grants nothing — `validate` reports such
  an entry as inert.

- **No skill enabled means no script at all.** Since `script.skill-only` confines
  `archmax_run` to bundles, a state that enables no skill — nothing on
  `allow_always`, nothing on its own list — can execute nothing: the tool stays on
  the surface and refuses every path.

`archmax validate` warns when a state entry names a slug `allow_always` already
grants everywhere, when a state's `allow: []` beside such a grant subtracts
nothing, and once when a spec declares no root `skills` block at all in a workspace
that serves bundles, naming what the workflow cannot reach. Any root block silences
that last one — write `skills: { allow_always: [] }` when a workflow grants no
capability workflow-wide.

Hooks are **exempt**: a `before`/`after` script reads authored data on runtime
authority, so a state may enable nothing and still be gated by a hook that reads
the very bundle the model cannot. That is the shape to reach for when a capability
should *enforce* something without being *usable*.

**`tools.forbid` on a state denies there**, and `tools.forbid_always` at the
root denies everywhere. Both beat every grant. Migrating a workflow off the
retired `policy` block:

- `policy.forbid_tools: [x]` → `tools.forbid_always: [x]`.
- `policy.forbid_paths: [g]` → `tools.forbid_always: [{ tool: write_file, paths:
  [g] }, { tool: edit_file, paths: [g] }]` for the identical meaning (it only
  ever blocked those two), or `[{ tool: "*", paths: [g] }]` to deny reads too.

## Mount governance

A **mount** is a folder (or a single file) the *host* routes into the agent's
workspace: `skills/`, `AGENTS.md`, and whatever else the wiring composes
(`reference/`, `catalogs/eu/`). The host owns which backend serves a mount, its
write posture, and whether the spec governs it; the spec owns which states reach
it, and what they may do there. **Neither is inferred from the other**, so you
cannot make a folder appear by naming it — ask the host to mount it.

A mount the host declares **governed** (`{ backend, governed: true }` in the
wiring) is closed by default, exactly like a skill bundle: reachable only from the
states a `mounts` list enables. An **ungoverned** mount — every mount of a
zero-config workspace, and every mount of a host that marks nothing — is visible
in every state, and only a `forbid` takes it away. So a spec with no `mounts`
block runs unchanged over any table.

The two levels compose exactly as `skills` does:

```yaml
mounts:
  allow_always: [reference]              # reachable in every state, named once
  forbid_always: [catalogs/uk]           # out of reach everywhere, and in every
                                         # child session this workflow delegates to

states:
  intake: {}                             # no block, and it still has reference/
  triage:
    mounts:
      allow: [catalogs/eu]               # this state adds one, and has both
  route:
    mounts:
      forbid: [reference]                # opts out of the workflow's grant
```

A state's `allow: []` is not a deny — a state's `allow` only ever adds
(`validate` warns about an entry that reads like a denial). **`mounts.forbid` is
what subtracts**, the workflow's `allow_always` and an ungoverned mount's standing
visibility alike. There is no root `mounts.allow` ceiling — writing one is a load
error.

### Read or read/write

A grant entry is either a bare mount name — taking the posture the host wired — or
a mapping naming the access this level gives:

```yaml
mounts:
  allow_always:
    - reference                                  # the host's posture
    - { mount: shared, access: read_write }      # writable where the host allows it

states:
  review:
    mounts:
      allow: [{ mount: shared, access: read }]   # reads it, cannot write it here
```

The host's `readOnly` is a **ceiling**, not a default to argue with:

- `access: read_write` on a mount the workspace serves read-only opens nothing,
  and `validate` warns that the entry is inert. Ask the host to mount it
  `{ readOnly: false }` instead.
- `access: read` is a restriction, so it behaves like every other restriction
  here: whichever level asks for it gets it, and **no narrower level widens it
  back**. A state cannot re-open what the workflow narrowed.
- A `forbid` entry is a name only. A denial is total, so there is no access to
  qualify — `{ mount: x, access: read }` in a `forbid` list is a load error.

Two refusals, because they are two different edits: a write into a mount the
**host** serves read-only is `zone.read-only` (fix the wiring), and a write into
one a **grant** narrowed is `mount.read-only` (fix the spec).

### What the agent sees

A governed mount the state does not have is not merely refused — it is not shown:

- `ls`, `glob` and `grep` results lose every entry under it, the **workspace root
  listing included**, so the agent is never shown a directory it then cannot read.
- The static "Workspace zones" prompt section names ungoverned mounts only, one
  line each with a `read-only` or `read/write` marker. The
  governed mounts of *this* state are listed in the volatile "Current state"
  block, read-only or read/write per the state's own grant — which is why the
  cacheable prompt prefix stays byte-identical across states.
- Every call is still decided by the kernel (`mount.not-allowed`,
  `mount.forbidden`, `mount.read-only`), whether or not a listing showed the path.
  Redaction is the courtesy; the kernel is the enforcement.

### Nested and file mounts

A mount key may be several segments deep (`catalogs/eu`), and a mount name is that
key with its slashes stripped — that is the token a `mounts` list takes, never a
glob (`reference/**` is a load error; scope paths *within* an enabled mount with a
`tools.allow` entry). A path is matched to a mount by **longest prefix**, so
`catalogs/eu` wins over a `catalogs` mounted beside it, and a sibling
`catalogs/uk` matches neither. A file mount (`AGENTS.md`) matches its exact path,
so `AGENTS.md.bak` is not captured.

### Diagnostics

`archmax validate` reports, given the host's mount table:

- **error** — a name the table does not mount at all, naming the mounts it does;
- a grant naming an **ungoverned** mount (it grants nothing: the mount is visible
  everywhere already — use `forbid` to take one away);
- an `access: read_write` on a mount the host serves **read-only**;
- a name in both `allow_always` and a state's `allow` (unless the state entry
  narrows the access, which does real work);
- a state's `allow: []` beside a non-empty `allow_always`;
- a `forbid` naming a governed mount nothing would have enabled there;
- a `forbid_always` name some `allow` list also grants;
- a `tools.allow` path entry that can only match inside a mount the state does not
  enable (the grant reaches nothing);
- **once**, when a spec declares no root `mounts` block at all in a workspace that
  governs mounts, naming what the workflow cannot reach. Any root block silences
  it — write `mounts: { allow_always: [] }` when a workflow reaches none.

Hooks and rubric graders are bound by `mounts.forbid_always` and **not** by a
state's `forbid` or its enabled set: they run on runtime authority, exactly as for
tools, so a `before` hook can read a mount the model in that state cannot.

## Session variables in guards

A `tools.allow` argument glob may reference a **run variable** — `${{name}}` or
`${{name.dotted.path}}` — resolved against the run's variables at call time:

```yaml
tools:
  allow:
    - { tool: gmail__send, args: { to: ["${{from_email}}"] } }
    - { tool: crm__lookup, args: { region: ["${{account.region}}"] } }
    - { tool: write_file, paths: ["reports/${{case_id}}/**"] }
```

There is **no `variables:` block** — a variable exists once something sets it:
the host at assembly (`variables`, every seed locked), the agent mid-run
(`archmax_set_variables`), or one of the two built-ins.

**Two reserved names.** Do not claim either for something else:

| | `trigger` | `title` |
|---|---|---|
| Set by | the runtime, at every arrival | the **agent**, prompted by the platform prompt |
| Locked | always | **never**, by any route |
| Guaranteed set | yes | no — absent until written |
| In a trigger's `requires:` | accepted | accepted (seeded unlocked) |
| In a trigger's `returns:` | refused | refused |

`trigger` holds the current turn's trigger id. `title` holds a short one-line label
naming the task the run is doing; the platform system prompt asks the agent to set
one as its first activity and update it when the task changes significantly, so a
host can name a run instead of showing a session id. A write must be a non-empty
single-line string of at most 200 characters (stored trimmed) and must not pass
`lock: true` — both are refused, atomically, like every other `set_variables`
rejection. A host may seed a `title`; it lands **unlocked** (the one exception to
"every seed is locked") as an opening label, and it will not overwrite one an
earlier turn established.

Do not confuse it with the spec-root and per-state `title:` keys, which are static
human labels for the *workflow* and the *state*. The run variable names the **run**.

Because nothing guarantees `title` is set, a guard on `${{title}}` still draws the
assembly-time warning — correctly.

Two declarations *guarantee* one: a state's `requires:` (checked when leaving that
state) and a **trigger's** `requires:` (checked before the run starts, so a firing
that omits it never runs). A trigger's `returns:` is the mirror — the variables a
run guarantees it has set by the time it completes. See a trigger's declaration.

A value belongs to the **session**: what one state records is readable by every
state after it and by every later turn, so a downstream guard can bind to an
upstream fact. Design for that — `requires` in an early state plus `lock: true` is
how a later `${{name}}` becomes guaranteed rather than hopeful.

**Paths.** Segments descend one level; a numeric segment indexes an array and a
negative one counts from the end (`${{order.items.-1.sku}}` is the last item).
Traversal reads own properties only, so `${{tags.length}}` and
`${{v.constructor}}` do **not** resolve. A reference must resolve to a single
scalar.

**Authoring rules that matter:**

- **Lock anything a guard reads.** Host seeds are locked automatically (`title`
  excepted, which is never locked); for an agent-established fact pass `lock: true`. An unlocked variable can be
  overwritten by any later state — that rewrite is permitted, being one writer
  twice, and the later value simply wins — so a guard bound to an unlocked name is
  a weak guard. A lock is the only thing that makes a fact settled.
- **Guarantee the reference.** Name it in the `requires` of a state that runs
  first, or seed it. Otherwise assembly only *warns*, and the run **fails** at
  the guarded call if the agent never set it — an unresolvable reference is
  terminal, not a retryable block, because a guard the runtime cannot evaluate
  is not a guard.
- **A positional index makes the guard move.** `${{order.items.-1.sku}}` permits
  a different value as the array grows. Sometimes exactly right ("the newest
  attachment"); when you want a *stable* guard, store the value you mean as its
  own named variable.
- **An `archmax_set_variables` typo creates a new variable** rather than erroring — there
  are no declarations to check against. `requires` is the safety net that turns
  that into a visible failure.

Substituted values are matched **literally** (a value holding `*` matches `*`,
not everything), so a variable can never widen the guard it lands in.

### The same references work in the agent's own tool arguments

`${{…}}` is not only an authoring syntax. Anywhere a tool argument is text, the
runtime substitutes references from the run's variables **before** the call is
governed or executed — and a reference may sit *inside* a longer string, and
repeat:

```
"Thanks — your refund is on its way.

--- Original message ---

${{inbound.text}}"
```

So the agent quotes a stored value by naming it rather than retyping it. Three
consequences worth authoring around:

- **A reference is exact.** A copy the model retypes can truncate, paraphrase, or
  drift; a reference cannot. When a state's job is to emit a large stored value,
  its `instructions` should **name the variable to interpolate** rather than
  telling the agent to include the original text.
- **The guard and the argument meet on the value.** Substitution runs ahead of the
  kernel, so `args: { to: ["${{from_email}}"] }` and an argument of
  `"${{from_email}}"` resolve independently to the same string — they agree by
  construction, not by the model having retyped an address correctly.
- **A bad reference here is recoverable**, unlike a bad guard. The call is refused
  with the reference named and the agent retries; only an unresolvable *guard* is
  terminal, because that is a defect the agent cannot fix.

The transcript keeps the reference — the substituted value goes to the tool and to
the `tool-called` event a run trail renders, and no further, so the value's tokens
are not re-sent on every later model call. An cases `calledTool` assertion
therefore states the **reference** the agent wrote; pin the delivered text through
the tool's effect instead (the file it wrote, the variable it set).

To write the characters `${{…}}` literally — authoring a guard through
`write_file`, or writing about the syntax — double the dollar: `$${{name}}`.

This is **model-facing only**. An `archmax_eval` or hook script already holds the
run's variables as `args.variables` and composes strings in JavaScript, so
`${{…}}` in a script's `tools.*` call is ordinary text.

## Lifecycle hooks

```yaml
# single hooks (the yaml wires the hook, nothing more):
before:
  script: hooks/check.js                   # hand-authored, self-contained JS file;
                                           # resolves to workflows/<slug>/hooks/check.js
after:  { rubric: reply-tone, max_iterations: 2 }   # per hook, not per state
# a script after hook may carry the same budget:
# after: { script: hooks/review.js, max_iterations: 2 }

# or a list, run in sequence (short-circuits on veto):
before:
  - { script: hooks/pre.js }
  - rubric: { instructions: judge the tone }
```

- A `HookSpec` is one hook or a list, run in order and short-circuiting on the
  first non-ok. Each hook is either `{ script: <path> }` (JS in the QuickJS
  sandbox) or `{ rubric: <declaration> }` (the grader itself, inline).
- **A script hook's path is workflow-relative and lives under `hooks/`.**
  `{ script: hooks/check.js }` resolves to `workflows/<slug>/hooks/check.js` on the
  authoring plane. An absolute path, a `..` climb, or anything outside `hooks/`
  (including the former `skills/<name>/scripts/…` spelling) is a load error and a
  `validate` error. Hook scripts are **not** agent-readable and **not** runnable
  with `archmax_run`: the runtime runs them, and that separation is what stops an
  agent probing the guard that gates it.
- **Reserved sidecar key** on a script or custom hook: `max_iterations` (see
  Verdicts below). It is **refused beside a `rubric`**, whose budget is inside its
  declaration. There is no `instructions`, `model` or `specification` sidecar on
  any hook.
- **Script hooks are hand-authored.** The script is an ordinary,
  self-contained `.js` file you design and write directly against the sandbox
  contract; it **must** open with a leading JSDoc title + description (plain
  prose, no special tags) — see
  [Code description docblocks](#code-description-docblocks).
  `archmax validate` errors on a missing script file or a
  foreign (non-`@archmax-ai/harness/*`) import; it does not check the docblock on a
  hook script. The runtime never generates: a missing
  script at run time vetoes (fail-closed).
  (A rubric's contract is its own `instructions`.)
- **Phases**: `before` runs before the agent acts in the state and gates entry;
  `after` runs after the agent calls `archmax_advance`, before the transition
  commits (the "veto window"), or at completion for a terminal state.
- **Verdicts**: `ok` (proceed), `correct` (agent gets another attempt), `veto`
  (block). Return the vocabulary or nothing: a bare `false` is **not** a veto, it
  is no verdict, which fails closed. Both hook kinds
  can return `correct` from an `after` hook — a script by evaluating to
  `{ verdict: "correct", reason: "..." }`, a rubric in its response —
  and both get the same bounded flow.
- **`max_iterations`** bounds how many times a `correct` may send the agent back
  before the hook becomes a hard veto: inside the declaration for a rubric, a
  sidecar for a script or custom hook, else 0. It is counted **per hook by
  position**, so two graders on one state never share a budget. An
  exhausted budget is a *terminal failure* — see
  [Budgets & error routing](#budgets--error-routing).
- **`before` hooks are ok/veto only**: a `correct` verdict from a `before` hook
  is treated as veto, and `max_iterations` on a `before` hook is a validation
  error.
- **Fail-closed**: a hook that *errors* vetoes the transition. A rubric
  whose response cannot be parsed into a verdict also fails closed (**veto**),
  never coerced to ok — as does a `model` id the host cannot serve.

The hook contract — a default-export function called with one object:

```js
export default async function hook({
  state, phase /* "before"|"after" */, trigger, variables, messages,
  from, to, reason,                 // from/to/reason present on "after"
  tools,                            // privileged tool bridge, e.g. tools.readFile
}) {
  return ok();                      // or veto(reason) / correct(reason)
}
```

Returning nothing is `ok`; a thrown error vetoes (fail-closed); the reason of a
`veto` is shown to the agent so it can correct itself. Full contract, field
semantics, and complete worked `before`/`after` examples:
[`hook-and-test-scripts.md`](hook-and-test-scripts.md).

## Budgets & error routing

```yaml
states:
  refund-request:
    budget:
      maxTurns: 24         # bounds this turn's agent loop
      # timeoutMs: 60000   # aborts the turn when exceeded
    on_error: escalation   # terminal-failure target
  escalation: { instructions: "Explain the failure and hand off." }  # terminal
```

Two failure classes, routed differently:

- **Recoverable rejections keep the agent in place**: an invalid edge in
  `archmax_advance`, a deliberate hook `veto`, or an in-budget `correct` — the
  agent sees the reason and retries within the same state. A **tool that
  throws** is answered the same way: its error message is the call's
  error-status answer, and it never routes to `on_error`.
- **Terminal failures route to `on_error`**: a hook *execution error*, an
  exhausted iteration budget (`max_iterations` used up), or an exhausted
  `budget` (`maxTurns`/`timeoutMs`). With `on_error: <state>` declared, the run
  routes to that state (the failure reason arrives as an `[error]` runtime note)
  instead of ending; without it, the failure ends the run.

**Recommendation**: declare `on_error` on states with strict `after` hooks, so
an exhausted judge doesn't hard-fail the run. The bundled example demonstrates
this: its `refund-request` state pairs `budget.maxTurns: 24` with
`on_error: escalation`, a terminal escalation state.

## Human states

`type: human` state:
- Parks the session with a checkpointed **pending-decision record** built from
  `instructions`, evidence file paths, and the transition descriptions/`type`s.
  Nothing is rendered to a file; `archmax run`/`archmax sessions` present that
  context on demand.
- **Evidence is declared plus attached.** The state's `evidence:` is the baseline
  every reviewer sees; the agent advancing in may attach what this run produced —
  `archmax_advance({ to: "refund-review", reason: "…", evidence: ["scratchpad/carrier-report.md"] })`
  — and the record lists declared paths first, attached after, de-duplicated.
  Attachments are refused (transition untaken, agent may retry) when `to` is not a
  human state, when a path is not one the agent can read (`scratchpad/…`,
  `scratchpad/…`, an authored mount), or when more than 20 are attached. Each
  attachment belongs to the one decision it was made for. Author `evidence:` for
  what must always be shown; leave run-specific artifacts to the attachment.
- A **human** selects the outgoing edge (optionally with a comment). The LLM does
  not choose. On resume the graph routes deterministically to the chosen target.
- The target turn is told what happened by a `[decision]` **runtime note**
  naming the edge, the comment, and the state the run is now in. It is a note,
  not a human message: a model reads authorship from a message's channel, and a
  routing event that looks like a person's request gets treated as one — routed
  onward, answered in place, or waited on — instead of being the cue to do the
  target state's work. Do not write instructions that tell a state to "answer
  the user's latest message" when its only inbound edge is a human decision.
- Resume programmatically with `agent.workflow.decide(sessionId, { target, comment })` or via
  the CLI `archmax decide <sessionId> <target>`.

## Sub-workflows are tools

A state that may run another workflow names it in `tools.allow`. That entry is
the whole declaration — there is no state kind and no second key.

```yaml
enrich:
  instructions: >-
    Enrich the account by calling archmax_workflow_enrich-account with its id,
    then record what it returned with archmax_set_variables.
  requires:
    - enrichment            # nothing captures the result — this makes it mandatory
  tools:
    allow:
      - archmax_workflow_enrich-account   # the slug, verbatim
  budget: { timeoutMs: 120000 }          # bounds the whole turn, calls included
  on_error: enrichment-failed
  transitions:
    - to: draft-reply
      description: The account has been enriched.
```

- **The target's signature is the call signature.** Its `manual` trigger's
  `requires:` are the tool's required parameters (typed in the tool schema
  where the entries are typed, by the same mapping `signatureJsonSchema`
  publishes); its `returns:` are what the result carries; its `description`
  leads the tool description, and its `instructions` never reach the caller:

  ```
  archmax_workflow_enrich-account({ account_id: "acct-42" })
    → { message: "Enriched acct-42.",
        returns: { enrichment_file: "scratchpad/e/acct-42.json", risk_level: "low" } }
  ```

  A target declaring no `returns:` answers with the closing message alone.
- **Nothing captures the result.** The agent records what it needs with
  `archmax_set_variables`, or a script writes it. Declare the state's `requires:`
  so it cannot advance without doing so — that is what replaces the old automatic
  capture.
- **One call runs one sub-run.** There is no fan-out argument: an agent fans out
  with parallel tool calls, a script with `Promise.all`. Both are bounded by
  the dispatcher's `maxConcurrent`, and each call succeeds or fails on its
  own.
- **A script is the deterministic fan-out.** Delegation tools are on the PTC
  surface, so a script decides how many calls to make:

  ```js
  // the bridge camelCases tool names; a tool result arrives as text
  const results = await Promise.all(
    orders.map((o) => tools.archmaxWorkflowEnrichAccount({ account_id: o.id })),
  );
  const returns = results.map((r) => JSON.parse(r).returns);
  ```

  A script's delegation **cannot park**: a child that reaches a human state fails
  that call closed with `parked`.
- **Governance is ordinary.** The surface is closed by default, so a state naming
  no target may call none; `tools.forbid_always` blocks a delegation tool like any
  other.
- **A failure is a tool error** the calling agent can handle; the state's
  `on_error` catches the turn if it cannot. Depth, cycle, missing-input
  (`missing-param`), mistyped-input (`invalid-param`), unresolvable-reference
  (`unresolved-param`) and **disabled-target** refusals are blocked calls —
  nothing ran, so correct the call and retry. A child whose returns are unset
  (`missing-return`) or mistyped (`invalid-return`) is a failure: it ran.
- **A whole-argument reference keeps its type.** `{ quantity: "${{count}}" }`
  seeds the child with the number `count` holds, so it satisfies an `integer`
  parameter; `{ note: "order ${{order_id}}" }` is substituted as text.
- **A `disabled: true` target is refused at dispatch, not at assembly.** The tool is
  still bound and the caller still assembles (disabling one leaf must not take every
  caller — or its parked sessions — offline); the call is a blocked call of kind
  `disabled`, and it beats a declared mock. `validate` **warns** on each state that
  allows a disabled target: the caller's spec is not wrong.
- **A caller enters the child's `manual` entry** — the one entry the CLI, a host
  firing and a call all use. There is no opt-in on the target: whether a
  delegation may happen is decided by the caller's `tools.allow` entry. A target
  with no `manual` entry has no state to start in and fails closed. `session:` and
  `message:` on that trigger are host-facing keys a delegation ignores: a sub-run
  shares its parent's session, and carries no message. `sub-workflow` is no longer
  a trigger id — load and `validate` report it with the rename.
- **Declare the child's signature** on that trigger — the contract, enforced both
  ways and at both ingresses:

  ```yaml
  states:
    enrich:
      triggers:
        manual:
          description: Enrich one order.       # leads the caller's tool description
          requires:                            # a caller must supply these
            - { name: order_id, type: string, description: The order to enrich. }
          returns:                             # the child guarantees it sets these
            - enrichment_file
            - { name: delayed, type: boolean }
  ```

  Develop it standalone on the same contract:
  `archmax run enrich-order --variables '{"order_id":"ORD-1003"}'`. `${{trigger}}`
  reads `manual` either way, so the machine cannot branch on having been called.

  A dispatch missing a `requires` name is **refused before the child is
  composed**; a child that completes without every `returns` name set is
  **rejected** rather than handing back half a contract (a child that *parks* is
  not checked — it has not finished). A typed entry is held to its type at both
  ends: a mistyped argument is refused `invalid-param` before the child runs, and
  a mistyped return fails the call `invalid-return`. What the child must *do* to
  produce a variable belongs in the state `instructions` that set it. The names,
  with type and description where declared, are rendered into the child's prompt
  under its entry state, so it is told what to produce before it can be failed
  for omitting it.
- **The call answers with the returns, by name.** A signed target answers
  `{ message, returns: { enrichment_file, delayed } }`; one declaring no
  `returns:` answers with the closing message alone. The message keeps its own
  key rather than being folded into the data — prose the model reads, values a
  guard or a script reads by name. **Nothing captures it into a variable**: the
  agent records what it needs with `archmax_set_variables`, or a script writes it,
  and the calling state's `requires:` is what makes that mandatory.
- **Mocks are held to the same contract.** An `archmax_workflow_<slug>` mock for a
  signed target supplies `returns:`, and one that omits a declared name
  (`missing-return`) or supplies a mistyped typed one (`invalid-return`) fails
  the mocked dispatch — a mock stands in for the sub-run, never for its agreement.
- **No prose crosses the boundary.** A sub-run gets no instruction from its
  caller — it works from its own state `instructions` plus the arguments it was
  seeded with as locked variables, both of which reach the model through the
  system prompt. Nothing to author, nothing to keep in sync.
- **Same agent, isolated context, shared session.** Same model, backend, host
  tools; its **own** grading rubrics, from its own spec; a fresh transcript; the child's *own* per-state
  `tools.allow`. It shares the run's session, so it writes `scratchpad/…` and
  `scratchpad/…` exactly as the parent does and the parent reads them afterwards.
- **Nothing crosses implicitly.** Down: only the arguments the call passed —
  the calling run's own variables are not copied. Up: only the result message
  and the files. Everything the child sets is discarded when it finishes.
- **Give each concurrent sub-run its own output path** — they share one run zone.
- **Bounds** — the dispatcher's `bounds: { maxDepth: 3, maxConcurrent: 4 }`. No longer a spec key: the strict schema rejects `settings.sub_workflows` by name.
  Excess concurrency queues; depth and cycles are refused.
- **Params are the sub-run's initial variables** — same construction, same name
  rule, same lock as a host's `variables`. So a delegated machine also runs
  **standalone** with those inputs supplied directly:
  `archmax run <child> --variables '{"order_id":"ORD-1003"}'` — no `--trigger`,
  because a caller and the CLI enter the same `manual` entry. That is how you
  develop one in isolation, on exactly the contract a caller holds it to.
- **A child may stop for a person.** A `type: human` state in a delegated machine
  suspends the sub-run *and* the delegating run; `archmax decide <sessionId>
  <target>` resolves the **child's** decision, the sub-run finishes, and the
  parent carries on with its result. This holds for a **fan-out** too: each
  dispatch is its own checkpointed task, so resolving one decision re-runs only
  that sub-run — siblings that finished keep their results.
- **Fails closed** — rejection, budget, refusal or an unresolvable param routes
  through `on_error` (or ends the run rejected); a suspension for a person is not
  a failure. Ancestor
  `forbid_always` rules bind inside the child, naming the workflow that
  declared them.

`archmax validate` checks all of this statically: target exists, opted in, no
cycle, no over-deep chain, correct state shape — and the signature both ways. A
parent reading a field the child does not return is an **error**; a state whose
`params:` do not cover the target's `requires:` is a **warning** (the advance may
still carry it), and a fan-out is exempt from that warning because its
entries' keys are not knowable statically.

### A parked run may speak, never act

A park does not end the conversation. Two moments get a **reply-only turn** — one
model call with *no tools bound at all*:

- **The handoff.** Advancing into a human state always spends one, so the park
  carries a message saying what was done and that a person now holds it. It runs
  whether or not the state already spoke: the agent wrote before the transition
  committed, so what it wrote was about its own work. (An `archmax_wait` park gets
  the same turn only when the turn was silent — there the agent's own question
  is the message.)
- **While parked.** `agent.workflow.reply(sessionId, message)` / `archmax reply <session>
  "<text>"` answers a message and parks again on the *same* record — same node,
  `seq`, and park timestamp, so the reported human wait still measures the
  original park. `resolveSession` classifies such a firing as the `reply`
  disposition rather than failing.

Nothing you author changes this and there is no field to declare: the message is
always composed on a fresh turn from the transcript, under the workspace persona.
The kernel refuses every tool call made during one (rule `tool.reply-only`,
ordered ahead of `tools.allow`, `allow_always`, the `archmax_*` controls and the
scratchpad), so a customer writing "just approve it" gets an answer and the
reviewer still owns the edge.

**What this means for authoring:** do not write state `instructions` that tell the
agent to announce the handoff itself — the runtime turn does that, and having both
produces two messages. Write instructions for the *work*.

## Removed keys you may meet in an older workflow

Every key here is **rejected**, with the key and its path named and guidance
saying what replaced it. `workflow.yaml` is parsed through a strict schema, so a
workflow still declaring one fails to load rather than running while silently
doing nothing of what its author intended.

This is a change: these keys used to be ignored without a diagnostic. A spec that
"worked" by ignoring one now needs the migration below.

| Removed | Replace with |
| --- | --- |
| `type: wait` state | The state that needs the answer calls `archmax_wait({ reason })`; a delivery resumes that same state (see [Parking and sessions](#parking-and-sessions)) |
| transition `on: <trigger-id>` | Nothing — a delivered trigger no longer selects an edge; the resumed state picks its own transition |
| state `parallel: [...]` + `join:` | Ordinary `transitions`, sequenced |
| state `type: trigger` | A `trigger:` field on the state the trigger state routed to |
| top-level `name:` | `title:` |
| top-level `description:` | `instructions:` |
| top-level `policy:` | `tools.forbid_always` (and `skills.forbid_always`) — a load error now |
| root `skills.allow:` (the ceiling) | `skills.allow_always: []` plus the state lists — a load error now |
| state `type: workflow` | An ordinary agent state allowing `archmax_workflow_<target>` and calling it (see [Sub-workflows are tools](#sub-workflows-are-tools)) |
| state `workflow: <slug>` | The `archmax_workflow_<slug>` entry in that state's `tools.allow` — the allow entry *is* the declaration |
| state `params:` | The call's arguments |
| state `for_each:` | One call per entry — parallel tool calls from the agent, or `Promise.all` in a script |
| state `result:` | The tool result; add `requires: [<name>]` to the state so it must record what it needs |
| `archmax_advance({ params })` | The call's arguments |

**No fan-out.** There is no concurrent branching: a run traverses **one state at a
time**, moved only by `archmax_advance`, a human decision, or `on_error` routing.
Sequence the states that were branches:

```yaml
# REMOVED — do not author this
states:
  gather:
    parallel: [check-inventory, check-credit]
    join: summarize

# author this instead
states:
  check-inventory:
    transitions: [{ to: check-credit }]
  check-credit:
    transitions: [{ to: summarize }]
  summarize: { instructions: "..." }
```

Concurrent composition **is** sub-workflows: a state calling a delegation tool
once per unit of work — the calls run concurrently (see
[Sub-workflows are tools](#sub-workflows-are-tools)). Sequence anything that is not that —
it costs latency, not correctness.

## Workspace layout

```
workflows/<name>/workflow.yaml    # the machine (canonical spec)
workflows/<name>/WORKFLOW.md      # OPTIONAL prose addendum (no frontmatter)
workflows/<name>/hooks/*.js       # lifecycle hook scripts — run BY THE HARNESS.
                                  # Authoring plane: the agent cannot read or run
                                  # anything under workflows/
workflows/<name>/tests/           # cases (*.test.yaml, one case per
                                  # file; fixture files referenced with `from:`)
skills/<capability>/SKILL.md      # a capability, bundled (Agent Skills format).
                                  # Shared guidance for content that generalizes
                                  # across MULTIPLE states — single-state
                                  # behavior goes inline in that state's
                                  # `instructions` (never one SKILL.md per state)
skills/<capability>/scripts/*.js  # its archmax_run sources — run BY THE AGENT
                                  # (lifecycle hook scripts are NOT here: they
                                  # live in workflows/<name>/hooks/, are run by
                                  # the runtime, and the agent cannot read them)
skills/<capability>/assets/*      # its inputs (read-only)
scratchpad/                       # THE working area: intermediate files and the
                                  # artifacts a state produces. The run IS the
                                  # workspace root — resolves to
                                  # sessions/<sessionId>/scratchpad/. Always
                                  # writable, per-session
large_tool_results/               # runtime-offloaded tool results (read-only)
conversation_history/             # runtime-offloaded history (read-only)
AGENTS.md                         # workspace persona/system prompt
```

This is the **complete** directory contract — there are no other magic
locations, so design the full file set up front instead of exploring.
Reference these paths **workspace-relative, without a leading slash**
(`skills/order-data/assets/orders.json`, `scratchpad/refund.json`) — in `instructions`, `evidence`,
allow-entry globs, and paths referenced inside hook scripts alike.

The authoring-plane prefix (`workflows/`) is **reserved**: a
host cannot mount it (`MountCollisionError` at assembly), an allow entry naming
it is a `validate` **error**, and a script that reads it is blocked with a
diagnostic naming the prefix. Never write an allow entry, an `evidence` path, or a
case `workspace:` key under it.

### Grading rubrics — inline on the hook

A grader is the **value** of the hook that applies it, not a file beside the spec
and not a named entry a hook points at:

```yaml
states:
  respond:
    after:
      - rubric:
          instructions: |-       # REQUIRED — the criteria and the verdict
            Judge the tone of the last assistant message. Return `ok`,
            `correct` or `veto`, always with a concise `reason`.
          max_iterations?: number  # the grade-and-retry budget, counted per hook
          model?: string           # a model id to grade on, resolved through the
                                   # assembly's modelFactory (third argument)
          metadata?: object        # host data the runtime never reads
```

A rubric has **no name**, and there is deliberately **no `title`, `description`
or `response_format`**: nothing routes to a rubric, nothing labels one in a prompt
(a display label goes in `metadata`), and a rubric only ever grades — so every
dispatch requests the verdict schema unconditionally.

Verdict shape: `{ verdict: "ok"|"correct"|"veto", reason: string }`.

Two states needing the same grader declare it **twice**: a state legible on its
own beats a de-duplicated document. Its identity is its position (state, phase,
index), which is what the runtime dispatches it under and what its retry budget
is keyed against — so two graders on one state never share a budget.

The agent learns nothing of it: the rendered graph says a phase carries a hook of
kind `rubric`, there is no `task` tool to call one with, and no sandbox context
has `task()`.

## Cases

Declarative YAML case documents under `workflows/<name>/tests/*.test.yaml`
(or `.test.yml`) — **one case per file**; the case id is the tests/-relative
path minus the extension. `archmax test <workflow>` interprets them
**host-side**: no QuickJS sandbox runs a case (the sandbox serves only
lifecycle hooks and `archmax_run` inside the driven agent). These are distinct
from the runtime's own colocated unit tests. Only `*.test.yaml`/`*.test.yml`
files are discovered — a leftover `*.test.js` is ignored without a diagnostic.

A workflow declaring `disabled: true` runs **no** cases: the suite is reported as
**skipped** and the exit code is **0** (not run is not failed, so retiring a
workflow never reddens CI). There is no flag to force them; `archmax validate` is
the static feedback while a workflow is out of service.

**Suite config lives in the `tests:` block of `workflow.yaml`**
(`maxConcurrency`, `caseTimeoutMs`, `judge` — see [Root fields](#root-fields)).
`tests.config.js` is **REMOVED**: its presence is a hard error in
`archmax test` and `archmax validate`. There is no `reporters` option.
`judge: {}` enables the grader with the env-configured default model.

**The complete case schema (top-level keys, the flat step-entry list, the
assertion grammar, start conditions, mocks, `from:` fixture references) plus
worked examples — routing,
tool mocking, human-in-the-loop decide flows, triggered starts — and the
JS→YAML migration table are in
[`hook-and-test-scripts.md`](hook-and-test-scripts.md).**

Every case carries two mandatory prose fields, both length-capped: a `title`
(a short label, ≤ 60 chars, printed beside the verdict) and a `description`
(≤ 200 chars — the scenario driven and what is asserted). `archmax validate`
**errors** on a missing or over-long field; longer rationale belongs in a YAML
comment above the document (see
[Code description docblocks](#code-description-docblocks)). A case is one
conversation on one session; `steps` is one flat list where actions (`send`,
`decide`) and assertions are peers, each assertion evaluating against the
nearest action above it. Unknown keys anywhere in a case are validation
errors — fail closed.

```yaml
# Nothing is mocked — the case reads the real orders.json fixture, so the
# denial is re-derived by the refund policy hook rather than asserted directly.
title: Refund denied for a shipped order
description: >-
  A refund for shipped A-1002 parks at refund-review; the reviewer confirms the
  denial via refund-closed, the run succeeds, and the reply names the order.
steps:
  - send: "Hi, I'm support@acmecorp.com. Please refund order A-1002."
  - parked: true
  - reachedState: refund-review
  - decide:
      to: refund-closed
      comment: "The denial matches policy."
  - succeeded: true
  - reply:
      includes: "A-1002"
```

## Code description docblocks

**Every** code file in the workspace — both kinds: lifecycle hook scripts and
`archmax_run` sources — MUST begin with a leading JSDoc block (`/** ... */`): a
title line, a blank line, then prose stating what the code does **and how**.
Cases are YAML documents, not code — they carry no JSDoc block;
their mandatory `title` and `description` fields are short and capped instead,
with any longer rationale in a YAML comment above the document. The canonical
statement of the
rule, with the required depth per file kind, is
[SKILL.md → Code files are description-first](../SKILL.md#code-files-are-description-first).

- The block is the **human-facing contract**: admin UIs display only this
  description, and the code below it must honor it. Author
  description-first; when behavior changes, update the description, then edit
  the code to match — never leave the two contradicting each other.
- Write it deep enough to review on its own: inputs read, the sequence of
  checks or assertions, and each outcome the code can produce. A one-line label
  is not enough.
- It is inert at runtime — the QuickJS sandbox executes the source verbatim
  (typed `@archmax-ai/harness/*` imports excepted; they are stripped).
- The prose ends at the first `@tag` line (tags are allowed but not part of
  the description), so keep the title and body above any tag. There is no
  `@specification` tag and no generation marker: the block is a human
  description, not a machine contract.
- `archmax validate` **errors** when an cases is missing its
  `description` (the case schema requires it). Hook scripts and `archmax_run`
  sources are **not** checked — there the JSDoc rule is an authoring standard
  you uphold yourself.
- Backends/UIs extract it with the package's exported
  `parseCodeDescription(source)` helper rather than scraping comments.

## Read-only zones

Writes (via `write_file`/`edit_file`) targeting any read-only authored mount —
the conventional directories plus root files such as `AGENTS.md`, or whatever the
wiring code mounted — are blocked, by the mount itself and by governance
(`zone.read-only`). A mount key of several segments (`catalogs/eu`) is matched by
**longest prefix**, so a nested mount is a read-only zone exactly as a
single-segment one is, and a sibling under the same first segment (`catalogs/uk`)
is not.

A mount the host mounted **writable** is not a read-only zone — its paths are
governed like ordinary run paths — but a state may still be given it read-only,
with `mounts: { allow: [{ mount: <name>, access: read }] }`. A write refused by
that grant is `mount.read-only`; one refused by the wiring is `zone.read-only`.
See [Mount governance](#mount-governance).

The run root is writable, and it has exactly one named working area:
`scratchpad/**`, permitted (read and write) in **every** state regardless of
`tools.allow`. Agent-visible `scratchpad/…` resolves to
`sessions/<sessionId>/scratchpad/…`, so concurrent sessions never collide.

Because that permission is unconditional, an allow entry naming a path *inside*
`scratchpad/` does not constrain where within the area a write lands — `archmax
validate` warns when a write entry's paths are all scratchpad paths. To govern
*where* a result lands, name an ordinary run path instead (any run-root path
outside the reserved areas — `reports/x.json`, or a root-level file); those are
matched against the state's `tools.allow` like any other argument. The framework
owns no second artifact area.

## Annotated example: order-lookup

The bundled reference workspace lives at
`examples/customer-support/workflows/order-lookup/` and demonstrates the full
v2 layout: `workflow.yaml` (the machine, including the `tests:` block and
script/rubric hook wiring) plus a frontmatter-free `WORKFLOW.md` prose addendum
(ASCII graph + domain constraints). Read both in full for a real, working
example. It declares a top-level `title` and a `title` on every state, with the
slugs below as the reference targets, plus a top-level `instructions` block
holding the rules that hold across every state — where the data and artifacts
live, the tenancy rule, and naming an order's exact status — so no state repeats
them. Its shape:

- `identify-case` (`triggers: { manual: , email_reply: }`, `before: check-requester.js`) routes to one
  of three cases via transition descriptions.
- `orders-question` (terminal) answers from `skills/order-data/assets/orders.json`; an
  `after: { rubric: order-reply-tone }` grades the reply at completion.
- `refund-request` records a decision to `scratchpad/refund.json` (no allow entry
  narrows it — the working area is open in every state; what holds the agent to a
  correct file is the hook), runs `after: check-refund.js`, and pairs
  `budget.maxTurns: 24` with `on_error: escalation` so a terminal failure
  (hook error, exhausted corrections, exhausted budget) routes to escalation
  instead of ending the run. On success it advances to `refund-review`.
- `refund-review` (`type: human`, `evidence: [scratchpad/refund.json]`) — a person
  approves (→ terminal `refund-closed`) or refines (→ back to `refund-request`).
- `escalation` (terminal) is the error handler entered only via
  `refund-request`'s `on_error`.
- `general-question` (terminal) answers and writes `scratchpad/answer.json`.

### Source of truth in code

If you need to confirm a detail, these files define the schema in the runtime:

| Concern | File |
| --- | --- |
| Spec types (`MachineState`, `Transition`, `HookSpec`, `AllowEntry`, `WorkflowTestsConfig`) | `src/machine/types.ts` |
| Two-file loading (`workflow.yaml` + prose addendum) | `src/machine/load-spec.ts` |
| Spec parsing, `ALWAYS_ALLOWED_TOOLS` | `src/machine/machine.ts` |
| allow-entry matching, hook normalization | `src/machine/allow.ts` |
| Rendered workflow header + per-state graph block | `src/workflow/render-prompt.ts` |
| Lifecycle running + verdicts | `src/lifecycle/` |
| Governance kernel (precedence) | `src/kernel/kernel.ts` |
| `archmax_advance` tool | `src/workflow/advance-state.ts` |
| Checkpointed state, `WORKFLOW_STATUSES` | `src/workflow/state.ts` |
| Grading rubrics, verdict schema | `src/rubrics/rubrics.ts` |

# workflow.yaml — exhaustive schema reference

The complete, field-by-field reference for authoring a `workflow.yaml` (and its
optional `WORKFLOW.md` prose addendum) plus the surrounding workspace. Targets
**runtime contract version `"3"`**.

## Contents

- [File shape](#file-shape)
- [Root fields](#root-fields)
- [States (`MachineState`)](#states-machinestate)
- [Ending a run as a failure: `archmax_raise`](#ending-a-run-as-a-failure-archmax_raise)
- [Transitions](#transitions)
- [Tool governance](#tool-governance)
- [Skill governance](#skill-governance)
- [Mount governance](#mount-governance)
- [Grader and code states](#grader-and-code-states)
  — full script contract + worked examples in
  [`code-state-and-test-scripts.md`](code-state-and-test-scripts.md)
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
  `instructions`, `disabled`, `runtime`, `settings`, `tests`, `tools`, `skills`,
  `mounts`, `metadata`, `states`.
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
                              # TRANSITION's `description` is what the agent routes
                              # on (see `transitions` below).

disabled?: boolean            # `true` = this machine STARTS NO NEW TURNS. Bounds
                              # STARTING, not finishing.
                              # REFUSES: `archmax run` (one line, non-zero exit, no
                              # session minted); a host `invoke`; a firing on a fresh
                              # session; a FOLLOW-UP message to a settled session
                              # (a new turn is new work) — all rejected AT THE TURN
                              # BOUNDARY with `status: rejected` and
                              # "Refusing to start: workflow '<slug>' is disabled.",
                              # before any state or model call; and a caller's
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
  version?: string | number   # target contract — "3", the only one supported (and
                              # the default when omitted). "1"/"2" are refused as
                              # an unsupported runtime contract, naming the
                              # supported set.

budget?:
  maxModelCalls?: number      # default 50 — the AGENT's model calls ONE TURN may make
                              # across EVERY state (a turn = one message, decision, reply
                              # or delivery; each counts from zero). A grader or code
                              # state's run is none of them; the agent's calls after an
                              # automated move count as any other. A state's maxTurns
                              # restarts on every entry, so only this ends an agent
                              # cycling between states. Exhaustion routes once through the current
                              # state's on_error, else the turn ends rejected; the agent
                              # is warned once a fifth is left. The step limit follows
                              # it. RAISE it for turns that legitimately run long (a long
                              # state chain, a self-driven review cycle).

settings?:
  model?: string              # MODEL ID ONLY — the id every state of this workflow runs
                              # on, over the endpoint/credentials the assembly already
                              # has. Overrides ARCHMAX_MODEL; a state's `model` overrides
                              # it. NOT a block: `{ id, temperature }` is a load error —
                              # sampling and endpoint are env/host configuration.
                              # Opaque: nothing validates the id against a list.
                              # A grader state runs on it too unless it declares its
                              # own `model`. Does NOT change the case judge
                              # (tests.judge.model).
  timeoutMs?: number          # default 15000; per sandbox evaluation — one
                              # archmax_eval/archmax_run call, or a code state's
                              # whole script
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
  judge?:                     # {} = enable the case judge (`grade:`) with the
    model?: string            #      env-configured default model — unrelated to
                              #      grader states
    modelOptions?: { temperature?: number, maxTokens?: number }
                              #      applied over the env model config, via the
                              #      factory's `judge` role; other keys are errors

tools?:
  allow_always?: AllowEntry[] # the WORKFLOW-WIDE GRANT, in every state. ABSENT = the
                              #      default tools (ls, read_file, write_file, edit_file,
                              #      glob, grep, copy_file, move_file, remove_file,
                              #      write_todos, archmax_eval, archmax_run). DECLARED
                              #      ([] included) = exactly what it lists: it REPLACES
                              #      the default tools, so list each one you want. A
                              #      new workflow lists all twelve.
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
                              # read_write }` to say what this level gives. A bare NAME
                              # asks for NO write: a governed mount is written only
                              # where some grant of THIS workflow says `read_write`
                              # (a child's or caller's grant never counts). The host's
                              # readOnly is a CEILING: `read_write` on a read-only mount
                              # opens nothing (validate warns); `read` NARROWS a
                              # writable one, and no narrower level widens it back.
                              # validate ERRORS on a name the table does not mount.
  forbid_always?: string[]    # MOUNT NAMES out of reach of EVERY state, governed or
                              # not, whatever any list grants. Deny beats allow.
                              # Binds this workflow's grader and code states too,
                              # and is inherited by every sub-workflow, naming the workflow
                              # that declared it. A NAME only — a denial is total, so
                              # there is no `access` to qualify. (A root `mounts.allow`
                              # is a load error: one mounts model.)

metadata?: Record<string, unknown>   # HOST PRESENTATION METADATA — an authoring
                              # UI's own state (canvas zoom, pan). Also accepted on
                              # a state (its position). The one key the runtime
                              # never reads: not shape-checked, not prompted,
                              # not governed, and excluded from the spec hash.
                              # Do NOT author it by hand and do NOT invent a
                              # use for it — but PRESERVE it verbatim when you
                              # rewrite a spec that already carries one, or the
                              # builder that wrote it loses every state position.
                              # The root is otherwise STRICT: any other
                              # unrecognized key is a load error — `extensions:`
                              # included.

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
    locks?: [string]           # RUN VARIABLES this state OWNS: only it may write them,
                               # on any visit, before or after they are set; a write
                               # from another state is refused naming the owner. To
                               # change one (the person meant another order), the
                               # session goes BACK to the owner, whose rules apply
                               # again, and later guards re-read it — so give the
                               # owner an edge back from the states that use it. Any
                               # variable, guarded or not. One owner per variable;
                               # never `trigger`/`title`; not on a human state.
                               # `lock: true` is refused for an owned variable, and a
                               # host-supplied value with the same name stays final.
                               # Pair with `requires` to make the owner set it.
    title?: string             # HUMAN-READABLE label. Presentational only: carried
                               # in a human state's pending-decision record and shown
                               # in host surfaces. REACHES NO MODEL CALL. Never a
                               # routing target — `to` always takes a slug — so
                               # rewording it changes no behavior. Not unique.
                               # NOT a substitute for `instructions` (behavior
                               # guidance) or a transition `description` (routing).

    type?: "agent" | "human" | "grader" | "code"
                               # default "agent" = the session's agent works here.
                               # "human" = a person routes.
                               # "grader" = an isolated grader judges the session
                               #   and decides the edge (see Grader and code states).
                               # "code"   = the runtime runs `script` and the
                               #   script decides the edge.
                               # grader + code = AUTOMATED states: run on entry
                               # with no call of the agent's model.
                               # (`workflow` was removed: a state CALLS another
                               # workflow by allowing `archmax_workflow_<slug>`.)

    script?: string            # CODE STATES ONLY, and REQUIRED there: the file the
                               # state runs, workflow-relative inside `scripts/`,
                               # ending .js or .mjs, no `..` segment —
                               #   script: scripts/check-refund.js
                               # resolves to workflows/<slug>/scripts/check-refund.js
                               # on the authoring plane. A code state without it,
                               # or `script` on any other type, is a LOAD ERROR.


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
                               # state's transition `description`s, or a target's
                               # `instructions` where an edge is undescribed; a
                               # target's summary is never disclosed.

    instructions?: string      # behavior guidance.
                               #   agent state: surfaced to the LLM while active.
                               #     Write the state's behavior INLINE here; a
                               #     skill bundle (skills/<slug>/) is a capability
                               #     with data or scripts, enabled by slug — not a
                               #     per-state instruction sheet.
                               #   human state: REQUIRED — the decision for the packet
                               #   grader state: REQUIRED — its criteria, the
                               #     grader's system prompt after a compiled-in
                               #     preamble; never shown to the agent
                               #   code state: a validate ERROR (nothing reads it)
                               # There is NO `before:`/`after:` on a state: hooks
                               # are removed, and a leftover key is a load error
                               # naming it (rewrite it as a grader or code state).

    tools?:
      allow?: AllowEntry[]     # grants beyond the workflow-wide grant (plus the
                               # always-allowed archmax_advance); an entry naming
                               # a tool that grant includes NARROWS it, and one
                               # naming a default tool a declared allow_always
                               # leaves out GRANTS it here.
      forbid?: ForbidEntry[]   # what this state DENIES while active — beating the
                               # workflow-wide grant, this state's own allow,
                               # and a host's essentialTools alike. Deny beats allow.
                               # Not inherited by a sub-workflow. Binds a grader's
                               # and a code state's calls exactly as the agent's.

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
                               # A grader or code state is bound like the agent: a
                               # code state reading skills/order-data/assets/orders.json
                               # enables `order-data` in ITS OWN list. To gate the
                               # agent's use of a capability while a check still
                               # reads it, enable it on the check's state only.

    mounts?:
      allow?: MountGrant[]     # which MOUNTS this state ADDS, by NAME — on top of the
                               # root's `mounts.allow_always`, which is reachable here
                               # whatever this says. ABSENT = adds none, the same as
                               # `allow: []`. An empty list is NOT a deny (validate
                               # warns about one that reads like it) — `forbid` is.
                               # An entry may name its access:
                               #   allow: [{ mount: shared, access: read }]
                               # reads a writable mount without writing it here, and
                               #   allow: [{ mount: shared, access: read_write }]
                               # asks to write it — which a bare name never does. The
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
                               # included. Binds a grader's and a code state's
                               # calls exactly as the agent's: grant the mount on
                               # the automated state that reads it.

    model?: string             # MODEL ID ONLY — this state's turns run on it (and the
                               # handoff message of a park it holds). Most specific of
                               # state.model > settings.model > the assembly's default
                               # (createAgent `model`/`modelFactory`, else ARCHMAX_MODEL).
                               # Same id as settings.model ⇒ validate WARNS (inert).
                               # On a GRADER state: the id the grader runs on, resolved
                               # under the `grader` model role
                               # (modelFactory("grader", env, id)). On a CODE state: a
                               # validate ERROR. A sub-workflow resolves its OWN
                               # spec's ids — nothing is inherited across it.
                               # A host passing an explicit `model` INSTANCE to
                               # createAgent outranks every declared id (one assembly
                               # warning names them); `modelFactory` is what honours one.

    budget?:                   # per-state execution budget
      maxTurns?: number        # bounds this turn's agent loop (on a grader: the
                               #   grader's own model calls)
      timeoutMs?: number       # aborts the turn when exceeded (on a grader: its run)
      maxParks?: number        # bounds archmax_wait parks here (see Parking); an
                               #   ERROR on a grader, which cannot park
                               # Any `budget` on a CODE state is a validate ERROR:
                               # settings.timeoutMs bounds its script.
    on_error?: string          # state to route to on a TERMINAL failure
                               # (see Budgets & error routing)

    transitions?: Transition[] # outgoing edges. EMPTY/absent ⇒ terminal state.
                               # `parallel:`/`join:` are REMOVED — a run traverses
                               # one state at a time; sequence what were branches.
                               #
                               # Transition = {
                               #   to: string          # a declared state's SLUG
                               #   description?: string # what the agent routes on
                               #   type?: "approve" | "reject" | "refine" | "none"
                               # }
                               #
                               # THE AGENT SEES THIS STATE'S EDGES AND NOTHING
                               # ELSE OF THE GRAPH — no other state's slug, title,
                               # summary, script, criteria or transitions, and no
                               # count of the states. So `description` is what it
                               # knows about where an edge leads. An UNDESCRIBED
                               # edge (absent/empty/blank) routes on the TARGET's
                               # `instructions` instead: the edge's line carries
                               # them, quoted, and nothing else of the target.
                               # LOAD ERRORS (states.<slug>.transitions.<i>.description):
                               # an undescribed edge whose target has no
                               # instructions; an undescribed transition of a
                               # HUMAN state (it is the button label); an
                               # undescribed edge INTO a GRADER (its instructions
                               # are criteria the work it judges is never shown)
                               # or a CODE state (it has none); a non-string. A
                               # code state's OWN edges may go undescribed: its
                               # script routes, and nothing reads them. An
                               # undescribed edge INTO a human state discloses
                               # that state's reviewer-facing instructions to the
                               # agent — describe it to keep them private.
                               #
                               # Write it for a reader standing in THIS state,
                               # which knows nothing about the target:
                               #   GOOD: "The refund is over $50."   (when)
                               #   BAD:  "Go to refund-review."      (where)
                               # A routing condition CANNOT live in the target's
                               # summary, which is never disclosed; it lives in the
                               # target's instructions only when the edge is left
                               # undescribed.
                               #
                               # The rendered line marks a target that is a human
                               # decision node, a grader, a code state or terminal
                               # (each changes the call or what follows it);
                               # nothing else of the target.
                               # A GRADER needs at least one transition (validate
                               # ERROR otherwise): with nowhere to send the session
                               # it could only approve by saying nothing.

    # human states only (ignored on agent states; a validate ERROR on grader and
    # code states):
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
    Ask exactly one clarifying question and, in that same message, call
    archmax_wait with a reason naming what you are waiting for. When the reply
    arrives you continue here: read it, and if it identifies the order, advance
    to answer.
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
  firing that does not supply every `requires` name does not start. `returns`
  is checked once as the run finishes, and **nothing is handed back**: a
  sub-workflow child with a name unset **completes**, and its caller gets
  every declared return, the unset ones `null`, plus `note: "Not all return
  variables were set by the sub-workflow: '<name>' was not set."`; a top-level
  run with a name unset is **rejected**; a typed one mistyped rejects either
  way. A run that *parks* is not checked — it has not finished. A return is
  owed **only at the finish**: `archmax_advance` checks a state's own
  `requires:`, never the returns, a later write replaces an unlocked earlier
  one, and a seed of one (a name in both lists) lands **unlocked** and does not
  overwrite a value the session already holds. So do not list a return in a
  state's `requires:` unless that state must settle it, and do not tell the
  agent to lock one before its value is final. `note` is reserved: a `returns`
  list may not declare it. Want the model to try again? Route the finishing
  state through a code state that checks the returns and sends the work back
  with what is missing. Each entry is a bare
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
  array), `array` or `file` (a path from the workspace root, such as
  `scratchpad/attachments/invoice.pdf` or `skills/billing/assets/template.pdf`; see
  [Passing files](#passing-files)). Nothing is coerced (`"4"` is not an `integer`) and a typed
  entry never takes `null`. It is held **at the start** (a mistyped seed is
  refused before any model call), **at the write** (`archmax_set_variables` of a
  mistyped typed return of the current trigger is a correctable refusal,
  nothing written) and **at completion** (a mistyped typed return rejects the
  run — in practice a code state's write). There are no enums, item or
  property schemas, ranges or optional inputs. An unknown `type`, an unknown
  entry key (`default:`) or an empty `description` fails load.
- **A `file` value must name a readable file.** The pure rule checks only the
  path's shape (a host runs it in a browser). At the start, at the write, at
  completion and at a delegation call the runtime also requires a **file** (not a
  folder) at the path that the session may read **on runtime authority** — the
  runtime's own `file`-value read check, the one call that runs outside a state's
  surface: zone rules (`checkpoints/`, `artifacts/`, `_specs/`
  never), the workflow's mount grants taken across all its states (a governed
  mount no state is granted is out of reach), and every workflow-wide
  `forbid_always`, inherited ones included; the state's allow list and its own
  mount/skill grants do not narrow it. So tell the agent to
  write the file *before* it sets a `file` return: `archmax_set_variables` refuses
  a path with nothing there. A host hands a file in with `TurnInput.files` (CLI:
  `archmax run … --file invoice=./invoice.pdf`), which places it under
  `scratchpad/attachments/` and seeds the path.
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

  One state, one behavior, one governance block; `${{trigger}}` and a code
  state's `trigger` input still read which one actually fired.
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
`archmax_reset`, `archmax_wait`, `archmax_raise`, `archmax_run`,
`archmax_get_variables`, `archmax_set_variables`, and `archmax_get_history`
(grader states only) — and are the names to write in `tools.allow`,
`tools.allow_always`, and the `forbid`/`forbid_always` lists. These are the only spellings:
an entry naming an unprefixed variant governs a tool that does not exist,
silently granting nothing. A host tool may never claim the prefix. Deep Agents' built-ins
(`read_file`, `task`, …) keep their own names.

- A state with **no `tools` block** gets the **workflow-wide grant only**: what
  `tools.allow_always` lists, or the default tools (`ls`, `read_file`, `write_file`,
  `edit_file`, `copy_file`, `move_file`, `remove_file`, `glob`, `grep`, `write_todos`,
  `archmax_eval`, `archmax_run`) when the key is absent, plus the always-allowed
  `archmax_advance` and a host's `essentialTools`, minus whatever a `forbid` list
  denies there, and read-only-zone protection. A grader or code state never has
  `write_todos`, `archmax_eval`, `archmax_run`, `archmax_wait` or `archmax_reset`,
  even when `allow_always` lists one; a grader also has `archmax_get_history`.
  Governance is closed by default; there is no way to declare a fully open state.
- `tools.forbid` on a state **denies** while that state is active, beating every
  grant that would otherwise reach it (see [Tool governance](#tool-governance)).
- A state with **no transitions** is **terminal**: the run ends when the agent
  finishes its turn there; it cannot call `archmax_advance`.

## Ending a run as a failure: `archmax_raise`

When the work **cannot be completed** — a system it depends on keeps failing, the
thing asked about does not exist — the agent calls
`archmax_raise({ code, reason })`. It is in every state (terminal ones included),
never declared, and only for failure: a session that ends without it is a
success.

- The call must be the **only** tool call in its message; one sent beside other
  calls is refused, and the model may raise again on its own.
- The session ends **at once** with status `failed` (classified **finished**): no
  further model call, no `on_error` route, no further state (an automated one
  included), no check of the trigger's `returns`. A rejection still
  pending from earlier in the turn is replaced. The position stays where the
  agent raised; the trail records no step.
- The host reads `Outcome.kind === "failed"` and `Outcome.exit`
  (`{ success: false, code, reason }`); a completed turn carries
  `exit: { success: true }`. `code` is the agent's own free-form token (≤ 64
  characters, one line), so if hosts branch on particular codes, name them in
  the state's `instructions` ("if the order does not exist, raise
  `order-not-found`").
- A **child** session that raises fails its caller's delegation call with kind
  `raised`, naming the code and reason; the caller may recover, route through
  its own `on_error`, or raise in turn.
- Ban it with `tools: { forbid_always: [archmax_raise] }` (or one state's
  `tools.forbid`) where the agent must not end the run itself — say, a state that
  must always reach a person instead. An agent's script cannot call it; a code
  state's script (`tools.archmax_raise`) and a grader can, and their raise ends the
  session the same way (the note and `exit` carry their code).
- Test it with the structural `raised` assertion; `succeeded: true` fails on a
  raise.

## Transitions

```yaml
transitions:
  - to: string                 # REQUIRED target state SLUG (must exist); never a title
    description?: string        # shown to the agent (or human) to pick the edge; absent =
                                #   the agent is shown the target's instructions instead.
                                #   REQUIRED on a human state's edges and on an edge INTO
                                #   a grader or code state; a code state's own may omit it
    type?: "approve" | "reject" | "refine" | "none"   # default "none"
```

- On **agent** states the agent chooses one edge via
  `archmax_advance({ to, reason })`; `type` is metadata only.
- On **grader** and **code** states the grader or the script chooses one the same
  way (`archmax_advance` / `tools.archmax_advance`), and its `reason` is what the
  next state reads.
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

**The model is closed by default, and a denial beats every grant.** Every state has the
**workflow-wide grant**: what `tools.allow_always` lists, or, when the workflow does not
declare that key, the **default tools** (`ls`, `read_file`, `write_file`, `edit_file`,
`copy_file`, `move_file`, `remove_file`, `glob`, `grep`, `write_todos`, `archmax_eval`,
`archmax_run`). A declared list **replaces** the default tools, never adds to them:
`allow_always: []` grants no tool workflow-wide, and a list without `write_file` leaves
every state that does not name it unable to write. So a new workflow lists all twelve and
removes only what it must not have. Every state also has its type's control tools and
any tool the host passes as `essentialTools`, whatever the workflow declares. A grader or
code state is never offered `write_todos`, `archmax_eval`, `archmax_run`, `archmax_wait` or
`archmax_reset`, even when `allow_always` lists them, and naming one in its own `tools.allow`
is a `validate` error.
One built-in is **never disclosed** and grantable by nothing: `task`, Deep Agents'
subagent dispatch — grading is a grader state and delegating is a sub-workflow, so naming
`task` in an allow entry is a `validate` error and the kernel refuses the call.
The planning scratchpad `write_todos` and the sandbox
`archmax_eval` are default tools: granted wherever the workflow-wide grant includes
them (everywhere, in a workflow without `allow_always`). `write_todos`'s prompt
guidance appears only when some state is granted it, and code states run in the
sandbox whether or not any state is granted `archmax_eval`. The interpreter is safe as a
default because the `tools.*` calls its code makes are decided against the active
state by the same kernel: it adds computation over what the state permits, not
access. `archmax_run` — executing an authored script **file** — is a default tool on
the same terms (the script is a file the state could already read); declare it
per state to **narrow** which files may run there. The file operations —
`copy_file({ source, destination, overwrite? })`, `move_file` (same arguments)
and `remove_file({ file_path })` — are default tools on the same terms: every tool
**declares its path arguments** with how the call uses each (`read`, `list`,
`search`, `write`, `remove`, `execute`), and every path rule reads that
declaration. `copy_file` reads `source` and writes `destination`; `move_file`
**removes** `source`, so a move out of a read-only mount is refused before
anything is written; a removal is refused wherever a write is. A call naming
several paths is refused when any one is, naming the argument. `paths:` in an
entry guards every declared path argument: a grant needs all of them to match
(`{ tool: copy_file, paths: [skills/**, reports/**] }`), a denial needs one
(`{ tool: "*", paths: [secrets/**] }` blocks a copy in or out). A host tool that
declares its paths (`toolPaths`, or a descriptor's `paths`) is governed the same
way; an argument may hold a list of paths, each one governed (and each one
tested by a `paths:` guard), and any other shape is refused
(`tool.path-argument`). `scratchpad/` is open in every state to each default file tool the state
is granted, whatever the granting entry narrows, and to a host's `essentialTools`.
A file tool the state is not granted gets nothing from it, and a host tool a state
must grant stays refused where it is not granted, whatever its paths. Any other tool
must be declared in the state's `tools.allow` or workflow-level
`tools.allow_always`. A `tools.allow` entry naming a tool the workflow-wide grant
includes **narrows** it for that state. A guard on an `allow_always` entry is
enforced like any other (`{ tool: write_file, paths: [reports/**] }` binds in every
state that does not name `write_file`).
Denial is declared beside the grant, in the same two positions and with the same
entries: `tools.forbid_always` at the root denies in every state,
`tools.forbid` on a state denies while it is active — subtracting from the
workflow-wide grant, the state's own `allow` and a host's `essentialTools` alike.
**Deny beats allow, and no narrower level widens a denial.** A forbid entry may
name the tool `*` (every tool); `*` in an allow list is a load error. A grader's
calls and a code state's script are governed against **their own state** exactly
as the agent is — its `allow`, its `forbid`, `forbid_always` and every ancestor's.
The only call on runtime authority is the runtime's own `file`-value read check,
held to the workflow's grants across all its states and to every `forbid_always`.

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
2. **The state type's control tools** (baked in): an agent or human state has
   `archmax_advance`, `archmax_reset`, `archmax_wait`, `archmax_raise` and the
   variable tools; a code state `archmax_advance`, `archmax_raise` and the
   variable tools; a grader state those plus `archmax_get_history`.
3. **Per-state `tools.allow`** — the listed tools/arg-shapes. An entry for a
   tool the workflow-wide grant includes takes precedence (**narrower wins** —
   the state's arg globs apply, not the broader grant); an entry for a default
   tool a declared `allow_always` omits grants it in this state.
4. **The workflow-wide grant** — the declared `tools.allow_always`, guards
   included, or the default tools, unconstrained, when the key is absent; in a
   grader or code state, minus `write_todos`, `archmax_eval` and `archmax_run`.
5. **The host's `essentialTools`** — always permitted when no state entry
   narrows them, whatever the workflow declares.
6. **Default**: everything else is blocked.

**Progressive disclosure.** The model is only shown the active state's tool
surface: the workflow-wide grant + a host's `essentialTools` + the state's entries +
its control tools (`archmax_advance` hidden in terminal states), minus every tool
denied there by name. A grader is offered, and a code state's script reaches,
exactly the same derivation for its own state — anything else is absent
(`undefined` on `tools`). Disclosure is
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
  into `scratchpad/` is unrunnable, a code-state script is unrunnable, and
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

Grader and code states are **not exempt**: their calls are governed against their
own state, so a code state that reads a bundle enables it in its own
`skills.allow`. That is the shape to reach for when a capability should *enforce*
something without being *usable* by the agent: the agent's state enables nothing,
and a code state in front of or behind it enables the bundle and runs the check. A
bundle the workflow's `skills.forbid_always` denies is refused to every state.

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

A grant entry is either a bare mount name, which asks for no write, or a mapping
naming the access this level gives:

```yaml
mounts:
  allow_always:
    - reference                                  # read; written only if a grant below asks
    - { mount: shared, access: read_write }      # writable where the host allows it

states:
  review:
    mounts:
      allow: [{ mount: shared, access: read }]   # reads it, cannot write it here
```

**A workflow writes a governed mount only where its own grants ask to.** It is
writable in a state when the host serves it writable, some grant of *this*
workflow says `access: read_write` (in `allow_always` or any state's `allow`), and
no grant applicable in the state says `access: read`. So a bare grant in one state
and a `read_write` grant in another both write. One mount table serves a session
and every child it dispatches, and the host serves a route writable when any
workflow in that tree asks; a mount still belongs to the workflow that grants it,
so a caller's `read_write` never lets its child write through a bare grant, nor the
other way round. An ungoverned mount takes the host's posture: it has no grant to
ask with.

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
one a **grant** narrowed, or one no grant of the workflow asks to write, is
`mount.read-only` (fix the spec; the refusal says which).

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
  narrows the access to `read`, or asks `read_write` of a mount the root grants
  bare: both do real work);
- a state's `allow: []` beside a non-empty `allow_always`;
- a `forbid` naming a governed mount nothing would have enabled there;
- a `forbid_always` name some `allow` list also grants;
- a `tools.allow` path entry that can only match inside a mount the state does not
  enable (the grant reaches nothing);
- **once**, when a spec declares no root `mounts` block at all in a workspace that
  governs mounts, naming what the workflow cannot reach. Any root block silences
  it — write `mounts: { allow_always: [] }` when a workflow reaches none.

Grader and code states are bound by **their own state's** mount grants, exactly
like the agent: a code state reads a governed mount only where `allow_always` or
its own `mounts.allow` grants it, and writes one only where that grant asks
`access: read_write`. So when a check needs a mount no agent state should see,
grant it on the check's code state alone. The one read on runtime authority is
the runtime's own `file`-value check, held to the **workflow's** grants taken
across every state and to every `forbid_always`.

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
| Set by | the runtime, at every arrival | the **agent**, prompted by the platform prompt (a sub-workflow child is not) |
| Locked | always | **never**, by any route |
| Guaranteed set | yes | no — absent until written |
| In a trigger's `requires:` | accepted | accepted (seeded unlocked) |
| In a trigger's `returns:` | refused | refused |

`trigger` holds the current turn's trigger id. `title` holds a short one-line label
naming the task the run is doing; the platform system prompt asks the agent to set
one as its first activity, and to rename it only when the whole conversation has
moved to a different subject (a follow-up on the same subject keeps it), so a
host can name a run instead of showing a session id. A sub-workflow's child is not
asked — its title names a session nothing lists and is never returned — so its
prompt leaves the step out; do not write "set the title" into a child's state
`instructions` to bring it back. A write must be a non-empty
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
  and a seed of a trigger's `returns` excepted, which land unlocked); for an
  agent-established fact pass `lock: true` — on a return, only once it is final. An unlocked variable can be
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

This is **model-facing**: the agent's calls and a grader's get it. An
`archmax_run` script (`args.variables`) or a code state's script (`variables`)
already holds the run's variables and composes strings in JavaScript, so `${{…}}`
in a script's `tools.*` call is ordinary text.

## Grader and code states

Two state types are run by the runtime itself, together called **automated
states**. Both are ordinary states on the graph: entered by a transition, leaving
by `archmax_advance` along one of their own transitions, ending the session with
`archmax_raise`, governed by their own tool surface.

```yaml
states:
  check-refund:                  # CODE state: runs its script, makes no model call
    type: code
    script: scripts/check-refund.js
    skills: { allow: [order-data] }      # what the SCRIPT reads is granted HERE
    on_error: escalation
    transitions:
      - to: refund-review
        description: The recorded decision matches the refund policy.
      - to: refund-request
        description: The recorded decision contradicts the policy; send it back with the fix.

  review-reply:                  # GRADER state: an isolated grader decides the edge
    type: grader
    budget: { maxTurns: 4 }      # the grader's own model calls
    on_error: escalation
    instructions: |-             # REQUIRED — its criteria
      Judge only the tone of the last assistant message with text.
      - Friendly and professional: advance to `answered`.
      - Curt, cold or blunt: advance back to `orders-question`, saying what to change.
      - Count the trail's steps with kind "grader" and to "orders-question"; if there
        are already two, raise `reply-tone` instead.
    transitions:                 # REQUIRED — at least one
      - to: answered
        description: The reply is friendly and professional.
      - to: orders-question
        description: The reply's tone is off; send it back naming what to change.
```

- **When it runs.** Whenever the session's position reaches it — the agent's
  `archmax_advance`, another automated state's advance, a human decision, an
  `on_error` route, a turn that opens there, an `archmax_reset` back to it — the
  runtime runs it **in place of the next model call** of the session's agent. The
  agent's model is not called while the session stands there (and an automated
  state spends none of the agent's `maxTurns` or of the turn's
  `budget.maxModelCalls`). Consecutive automated states run one after another,
  each committed as its own checkpointed step, so **a chain of code states makes
  no model call at all**. A chain that never reaches an agent
  state, a human state or a completion is stopped by the session's recursion limit
  (`GraphRecursionError`, not an `on_error` route).
- **What it is offered** — exactly its own state's surface: its `tools.allow`, the
  workflow-wide grant (`allow_always`, or the default tools when it is absent), the
  host's essential tools, and its controls `archmax_advance` (absent when
  terminal), `archmax_raise`, `archmax_get_variables`, `archmax_set_variables` —
  plus `archmax_get_history` for a grader. Never `write_todos`, `archmax_eval`,
  `archmax_run`, `archmax_wait` or `archmax_reset` — not even when `allow_always`
  lists one (it is left out), and naming one in its own `tools.allow` is a
  `validate` error. An automated state **cannot park**. Every call is decided by the kernel against
  that state, like the agent's: its `forbid`, `forbid_always`, its skill and mount
  grants and every safety rule bind it, and a tool another state grants is not
  reachable.
- **How it moves.** `archmax_advance({ to, reason })` is checked at the call (the
  edge exists, the state's `requires` hold against the variables at that moment;
  `evidence` only into a human state); a refusal can be retried. The **first
  accepted** advance or raise is the decision and every later one is refused. The
  decision takes effect when the run finishes **cleanly**.
- **How it settles** — exactly one of:
  - **advanced** → the session moves; the trail records `{ to, kind: grader | code,
    reason }`; a runtime note carries the reason to the next state
    (`[grader] The '<state>' grader moved the run to '<to>': <reason>. …` /
    `[code] '<state>' moved the run to '<to>': <reason>. …`); a human target parks
    after its one reply-only handoff message.
  - **raised** → the session ends `failed`, its `exit` carrying the code and reason.
  - **completed** → a terminal state finished without either call; the session
    completes, held to the trigger's `returns`.
  - **failed** → it threw, timed out, exhausted its budget, or a **non-terminal**
    state finished without either call (`<type> state '<slug>' finished without
    calling archmax_advance or archmax_raise`) — routed through `on_error`, else the
    session ends rejected. A raise wins over an error; an error discards a recorded
    advance. Finishing undecided is never read as approval.
- **Code state.** `script` (required, `scripts/<file>.js|.mjs`) runs in the QuickJS
  sandbox in a fresh REPL per run. Its default export receives `{ state, trigger,
  variables, messages, trail, toolCalls, tools }`: `messages` and `trail` are the
  session's whole transcript and trail (a tool entry carries its `tool` and call
  `id` with an empty `text`), and `toolCalls(filter?)` resolves to every domain
  tool call with its result, status, state and visit. Its return value is never
  read. `instructions`, `model`, `budget`, `evidence` and `approvers` on a code
  state are `validate` errors; `settings.timeoutMs` bounds the script. A
  **terminal** code state completes the session when its script returns: approve
  into one to end without another model call. Script contract and worked
  examples: [`code-state-and-test-scripts.md`](code-state-and-test-scripts.md).
- **Grader state.** A subagent with its own isolated context, built per run: its
  system prompt is a compiled-in grader preamble followed by the state's
  `instructions`; its task names the state and lists its transitions; it reads the
  session only through `archmax_get_history` (`{ messages, trail, toolCalls }` —
  the whole transcript, trail and tool calls with their results as JSON, not
  windowed). Its messages never enter the session's transcript, its tokens never
  stream, it writes no checkpoint; the session reads its decision as the trail
  step and the note. `instructions` (non-empty) and at least one transition are
  required; `evidence`, `approvers` and `budget.maxParks` are errors. Every edge
  into a grader needs a `description` (its instructions are never shown to the
  work it judges). `budget.maxTurns` bounds its own model calls and
  `budget.timeoutMs` its run. `model` (else `settings.model`) is resolved under the
  **`grader`** model role.
- **No iteration budget.** Nothing caps how often a state is visited. A
  state that gives up after N rounds counts them in the trail — each earlier
  send-back is `{ kind: grader | code, to: <graded state> }` — and raises (or routes
  to an escalation) on the round after.
- **Events.** `code-start { state, script }`, `code-output { state, line }`,
  `code-result { state, status, durationMs, reason? }`, `grader-start { state }`,
  `grader-result { state, status, durationMs, reason? }`; a grader's model calls are
  `model-usage` events under its state, added to the session's usage.

**Patterns.**

| Want | Shape |
| --- | --- |
| A deterministic check **in front of** a state | Make the trigger's entry (or the edge's target) a code state that advances to the work, or to a state that declines it (its agent reads the reason from the note) — or raises |
| A check **behind** a state | Point the state's transition at a code state with an edge onward and an edge **back**; a send-back's `reason` is the correction the agent reads |
| **Approve, then end** | Approve into a terminal code state (records the result, completes the session, no model call) |
| Judgment (tone, completeness) | A grader behind the graded state, with an edge back; its `instructions` say when to raise, counting send-backs in the trail |

**Migrating hooks.** `before:`/`after:` are removed, with every hook kind
(`{ script }`, `{ rubric }`, custom kinds), `max_iterations` and the root
`extensions:` block; each is a load error naming the key. A `before` check becomes
a code state in front of the state; an `after` check a code state behind it; a
rubric a grader state behind it. Move `workflows/<slug>/hooks/*.js` to
`scripts/` and rewrite each to the code-state contract (it advances or raises
instead of returning `ok`/`veto`/`correct`), and grant on the code state whatever
the script reads — there is no runtime authority any more.

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

The workflow's root `budget: { maxModelCalls }` (default 50) bounds the agent's
model calls across a whole turn, beside each state's own `maxTurns`; its exhaustion
routes the same way. A grader or code state's run spends none of it (a grader's own
calls are bounded by its `budget.maxTurns`). A turn that throws (model failure,
cancellation, the step limit) ends the session `failed` with exit code
`turn-error`, `turn-cancelled` or `recursion-limit`; the next message starts a
fresh turn.

Two failure classes, routed differently:

- **Recoverable rejections keep the mover in place**: an invalid edge in
  `archmax_advance` or an unmet `requires` — the agent (or a grader, or a code
  state's script, which may catch it) sees the reason and retries within the same
  state. A **tool that throws** is answered the same way: its error message is the
  call's error-status answer, and it never routes to `on_error`. A grader or code
  state *sending the work back* is a transition, not a failure: the agent reads
  the reason as a note.
- **Terminal failures route to `on_error`**: an exhausted `budget`
  (`maxTurns`/`timeoutMs`/`maxParks`), a failed sub-workflow call nothing
  recovered, and a grader or code state that **fails** — threw, timed out, spent
  its budget, or finished without advancing or raising. With `on_error: <state>`
  declared, the run routes to that state (the failure reason arrives as an
  `[error]` runtime note) instead of ending; without it, the failure ends the run.

**Recommendation**: declare `on_error` on every grader and code state, so a script
error or an undecided grader routes somewhere instead of ending the session
rejected. The bundled example demonstrates this: `refund-request` pairs
`budget.maxTurns: 12` with `on_error: escalation`, and its `screen-request`,
`check-refund` and `review-reply` route to the same terminal escalation state.

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
  `on_error` catches the turn if it cannot. Each failed call is recorded on
  its own, with its arguments, and stays the calling state's failure until a
  **later** successful call of the same workflow from the same state recovers
  it. One success recovers **one** failed call: the one whose arguments it
  repeats (compared after `${{…}}` resolves, key order ignored), else the
  oldest — so two parallel calls that failed need two successes. A sibling
  call in the same batch, another workflow's success, or a rejection with
  another cause (a terminal kernel block, exhausted parks) recovers nothing,
  and the route names every outstanding failure with its arguments. An
  advance, a park or a reset clears them, as it clears any pending rejection. Depth, cycle, missing-input
  (`missing-param`), mistyped-input (`invalid-param`), unresolvable-reference
  (`unresolved-param`) and **disabled-target** refusals are blocked calls —
  nothing ran, so correct the call and retry. A child whose returns are
  mistyped (`invalid-return`) is a failure: it ran. One that left returns unset
  is not: the call answers with them `null` and a `note`.
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
  is its own session, derived from its caller's, and carries no message. `sub-workflow` is no longer
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
  composed**; a child that completes without every `returns` name set
  **completes anyway**, and the call answers with every declared return, the
  unset ones `null`, plus a `note` naming them — no second attempt is spent, and
  the caller decides
  (a child that *parks* is not checked — it has not finished; a child that
  raises fails the call `raised`). A typed entry is held to its type at both
  ends: a mistyped argument is refused `invalid-param` before the child runs, and
  a mistyped return fails the call `invalid-return`. What the child must *do* to
  produce a variable belongs in the state `instructions` that set it. The names,
  with type and description where declared, are rendered into the child's prompt
  in every state, so it is told what to produce before it can be failed for
  omitting it — and to set each once its final value is known, locking one only
  when it is final.
- **The call answers with the returns, by name.** A signed target answers
  `{ message, returns: { enrichment_file, delayed } }`; one declaring no
  `returns:` answers with the closing message alone. The message keeps its own
  key rather than being folded into the data — prose the model reads, values a
  guard or a script reads by name. **Nothing captures it into a variable**: the
  agent records what it needs with `archmax_set_variables`, or a script writes it,
  and the calling state's `requires:` is what makes that mandatory.
- **Mocks are held to the same contract.** An `archmax_workflow_<slug>` mock for a
  signed target supplies `returns:`. One that supplies a mistyped typed one
  (`invalid-return`) fails the mocked dispatch, and one that omits a declared
  name answers like a real child that left it unset: that name `null`, plus a
  `note` — a mock stands in for the sub-run, never for its agreement.
- **No prose crosses the boundary.** A sub-run gets no instruction from its
  caller — it works from its own state `instructions` (system prompt) plus the
  arguments it was seeded with as locked variables, whose values its opening
  message lists: strings JSON-quoted, numbers and booleans as written. A list,
  an object, `null`, a value rendering past 200 characters, or one past the
  message's 1,000-character total is only named, with `archmax_get_variables`
  as the way to read it. Nothing to author, nothing to keep in sync, and nothing
  in the child's state `instructions` should say "read your inputs first".
- **A child goes straight to its work.** Its prompt leaves out the platform
  prompt's "Name the run first" step (a child's `title` is never returned), so a
  one-state child with short scalar inputs spends its first model call on the
  state's work. A workspace overriding the platform prompt
  (`.platform/system/GRAPH_STATE.md`) keeps that by wrapping what children skip
  in `<!-- top-level-only -->` … `<!-- /top-level-only -->` lines.
- **Same agent, isolated context, own session.** Same model, backend, host
  tools; its **own** grader and code states, from its own spec; a fresh transcript; the child's *own* per-state
  `tools.allow`. It is a separate session (`<parent>~<n>`, `n` the dispatch's
  number in the caller, counted across its turns) with its own checkpoints and its own `scratchpad/`: a path it reads or writes
  resolves inside its own session, so it can neither see nor overwrite a file of
  its caller's, and concurrent sub-runs cannot collide on a path.
- **Nothing crosses implicitly.** Down: only the arguments the call passed —
  the calling run's own variables are not copied. Up: only the result message
  and the declared returns. Everything else the child sets or writes stays in its
  session. The only files that cross are runtime-made copies of `file` arguments
  and `file` returns (see "Passing files" below).
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

### Passing files

A sub-run's `scratchpad/` is not its caller's, so a bare path string returned by a
child (`returns: [result_file]`, untyped) names a file the caller **cannot
read**. Type the entry `file` instead, and the runtime copies the file across:

```yaml
# the child
triggers:
  manual:
    requires: [{ name: invoice, type: file }]
    returns: [{ name: report, type: file }]
```

- **Down.** The caller passes any path in its workspace (`scratchpad/inbox/a.pdf`,
  `skills/billing/assets/template.pdf`). Before the child starts, the runtime
  copies the exact bytes into the **child's** `scratchpad/attachments/` (same name;
  two arguments with one name take `-1`, `-2`) and seeds the child with that path,
  so its opening message shows it. The child edits its own copy and never the
  caller's file. The argument is a `read` path argument of the delegation tool, so
  a `paths:` guard on the allow entry and the zone and mount rules bind it. An
  argument naming nothing is refused `invalid-param` before the child runs. A
  failed call's record names the caller's path.
- **Up.** On completion, each `file` return the child set is copied into the
  **caller's** `scratchpad/attachments/` and the result names that path. A taken
  name gets the lowest free `-1`, `-2`, … before the extension (`report-1.pdf`), so
  repeated or parallel calls never overwrite each other or the caller's files. A
  return whose file is gone at completion fails the call `invalid-return`.
- **No laundering.** A `file` value must name a file the session may read on
  runtime authority (its own workflow's mount grants and `forbid_always`), and a
  child inherits every ancestor's `forbid_always`. So a
  child cannot hand back a file its caller's workflow denies: its agent's write
  is refused, and a script's write is rejected at completion.
- **Instructions to write.** Tell the child to write the file *first* and then set
  the return to its path. Tell the caller the returned path is under
  `scratchpad/attachments/`. Name files for what they hold (`<order_id>.json`):
  the name survives the copy.
- **Mocks and cases.** A mocked `file` return names a file in the case's own
  session (seed it with `workspace:`), and it arrives copied into
  `scratchpad/attachments/` like a real one. Assert the copy's path.

### A parked run may speak, never act

A park does not end the conversation. Two moments get a **reply-only turn** — one
model call whose only product is text. It is handed the parked state's tool list
like any other call there (a transcript's tool calls and runtime notes need their
definitions on some providers), and every call it makes is refused:

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
reviewer still owns the edge. A model that calls a tool instead of writing its
message gets the refusal, and the run parks without a second model call.

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
| state `before:` (any hook kind) | A **code state in front** of the state — the trigger's entry, or the target of the edge into it — advancing to the work or to a declining state (see [Grader and code states](#grader-and-code-states)) |
| state `after: { script: hooks/<x>.js }` | A **code state behind** the state: its transition points at the code state, which advances onward or back with the fix as its `reason` |
| `{ rubric: … }` hook | A **grader state** behind the graded state with an edge back; the criteria become its `instructions` |
| `max_iterations` / `max_corrections` | Nothing: the grader's `instructions` (or the script) count send-backs in the trail and raise |
| root `extensions:` (custom hook kinds) and `createAgent({ hookExecutors })` | Nothing: a custom check is a code state |
| `workflows/<slug>/hooks/*.js` returning `ok`/`veto`/`correct` | `workflows/<slug>/scripts/*.js` that call `tools.archmax_advance` / `tools.archmax_raise` |
| `runtime.version: "1"` / `"2"` | `"3"` (or omit `runtime`) — 1 and 2 are refused as unsupported |

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
workflows/<name>/scripts/*.js     # code-state scripts — run BY THE RUNTIME when a
                                  # `type: code` state is entered.
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
                                  # (code-state scripts are NOT here: they live in
                                  # workflows/<name>/scripts/ — same directory
                                  # name, other plane — are run by the runtime,
                                  # and the agent cannot read them)
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
allow-entry globs, and paths referenced inside code-state scripts alike.

The authoring-plane prefix (`workflows/`) is **reserved**: a
host cannot mount it (`MountCollisionError` at assembly), an allow entry naming
it is a `validate` **error**, and a script that reads it is blocked with a
diagnostic naming the prefix. Never write an allow entry, an `evidence` path, or a
case `workspace:` key under it.

## Cases

Declarative YAML case documents under `workflows/<name>/tests/*.test.yaml`
(or `.test.yml`) — **one case per file**; the case id is the tests/-relative
path minus the extension. `archmax test <workflow>` interprets them
**host-side**: no QuickJS sandbox runs a case (the sandbox serves only
code-state scripts and `archmax_run` inside the driven agent). These are distinct
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
`judge: {}` enables the case judge (`grade:`) with the env-configured default model.

**The complete case schema (top-level keys, the flat step-entry list, the
assertion grammar, start conditions, mocks, `from:` fixture references) plus
worked examples — routing,
tool mocking, human-in-the-loop decide flows, triggered starts — and the
JS→YAML migration table are in
[`code-state-and-test-scripts.md`](code-state-and-test-scripts.md).**

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
# denial is re-derived by the check-refund code state rather than asserted directly.
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

**Every** code file in the workspace — both kinds: code-state scripts and
`archmax_run` sources — MUST begin with a leading JSDoc block (`/** ... */`): a
title line, a blank line, then prose stating what the code does **and how**.
Cases are YAML documents, not code — they carry no JSDoc block;
their mandatory `title` and `description` fields are short and capped instead,
with any longer rationale in a YAML comment above the document. The canonical
statement of the
rule, with the required depth per file kind, is
[SKILL.md → Workspace layout](../SKILL.md#workspace-layout-complete--nothing-else-exists).

- The block is the **human-facing contract**: admin UIs display only this
  description, and the code below it must honor it. Author
  description-first; when behavior changes, update the description, then edit
  the code to match — never leave the two contradicting each other.
- Write it deep enough to review on its own: inputs read, the sequence of
  checks or assertions, and each outcome the code can produce (for a code-state
  script: each `archmax_advance` target and why, each `archmax_raise` code). A
  one-line label is not enough.
- It is inert at runtime — the QuickJS sandbox executes the source verbatim
  (typed `@archmax-ai/harness/*` imports excepted; they are stripped).
- The prose ends at the first `@tag` line (tags are allowed but not part of
  the description), so keep the title and body above any tag. There is no
  `@specification` tag and no generation marker: the block is a human
  description, not a machine contract.
- `archmax validate` **errors** when an cases is missing its
  `description` (the case schema requires it). Code-state scripts and `archmax_run`
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
governed like ordinary run paths — but a governed one is written only where a grant
of the workflow says `access: read_write`, and a state may still be given it
read-only, with `mounts: { allow: [{ mount: <name>, access: read }] }`. A write
refused by a grant is `mount.read-only`; one refused by the wiring is
`zone.read-only`.
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
v3 layout: `workflow.yaml` (the machine, including the `tests:` block and its
grader and code states), the code-state scripts under `scripts/`, plus a
frontmatter-free `WORKFLOW.md` prose addendum (ASCII graph + domain constraints).
Read them in full for a real, working example. It declares a top-level `title`
and a `title` on every state, with the slugs below as the reference targets, plus
a top-level `instructions` block holding the rules that hold across every state —
where the data and artifacts live, the tenancy rule, and naming an order's exact
status — so no state repeats them. Its shape:

- `screen-request` (code, `triggers: { manual: , email_reply: }`,
  `scripts/screen-request.js`, enables `order-data`) — a check **in front**: it
  merges the requester and tenancy checks before any model call, and advances to
  `identify-case`, or to `decline` (a terminal agent state that tells the person
  why) with the reason.
- `identify-case` routes to one of four paths via transition descriptions.
- `orders-question` answers from `skills/order-data/assets/orders.json` and
  advances to `review-reply`, a **grader** with the tone criteria: it approves to
  `answered` — a **terminal code state** (`scripts/answered.js`) that records the
  approved reply in `scratchpad/answered.json`, so approval ends the session with
  no further model call — sends the reply back with the correction, or raises
  `reply-tone` after two send-backs, counted on the trail.
- `refund-request` records a decision to `scratchpad/refund.json` (no allow entry
  narrows it — the working area is open to `write_file` wherever it is granted;
  what holds the agent to a correct file is the check) and advances to
  `check-refund`, a code state **behind** it (`scripts/check-refund.js`): it
  re-derives the policy, advances to `refund-review` when the decision matches,
  sends it back with the fix otherwise, and escalates after two send-backs.
  `refund-request` pairs `budget.maxTurns: 12` with `on_error: escalation`.
- `refund-review` (`type: human`, `evidence: [scratchpad/refund.json]`) — a person
  approves (→ terminal `refund-closed`) or refines (→ back to `refund-request`).
- `escalation` (terminal) is the error handler entered via `on_error` (and from
  `check-refund`'s give-up edge).
- `general-question` (terminal) answers and writes `scratchpad/answer.json`.

### Source of truth in code

If you need to confirm a detail, these files define the schema in the runtime:

| Concern | File |
| --- | --- |
| The schema (every key, `script` grammar, `refineSpec`) | `src/machine/spec-schema.ts` |
| Per-type lint errors and warnings | `src/machine/lint-spec.ts` |
| Spec types (`MachineState`, `Transition`, `AllowEntry`, `WorkflowTestsConfig`) | `src/machine/types.ts` |
| Two-file loading (`workflow.yaml` + prose addendum) | `src/machine/load-spec.ts` |
| Type-aware surfaces (`controlTools`, `disclosedTools`, `checkAllowed`) | `src/machine/machine.ts`, `tool-names.ts` |
| allow-entry matching | `src/machine/allow.ts` |
| Rendered workflow header + per-state graph block | `src/workflow/render-prompt.ts` |
| Automated states: running, outcomes, controls, code and grader runs, history | `src/workflow/automated.ts`, `automated-controls.ts`, `code-state.ts`, `grader-state.ts`, `history.ts` |
| Governance kernel (precedence) | `src/kernel/kernel.ts` |
| `archmax_advance` and the other control tools | `src/workflow/control-tools.ts` |
| Checkpointed state, `WORKFLOW_STATUSES` | `src/workflow/state.ts` |

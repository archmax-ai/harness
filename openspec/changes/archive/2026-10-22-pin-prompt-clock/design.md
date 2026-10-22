## Context

The clock line is built by `renderNow(new Date())` in `src/workflow/governance.ts` and placed first
in `volatileSection`, on both branches: the normal state block and the reply-only block that writes
a park's handoff message. `renderNow` rounds the instant down to a ten-minute bucket, prints it in
UTC with the weekday, and appends the local time when the host's zone (`hostTimeZone()`) is not
UTC. Nothing can change the instant it is given. A plain agent has no `volatileSection`, so it
renders no clock today.

The repo's own unit tests pin time with `vi.useFakeTimers`, but that only works inside the test
process. A case run by `archmax test` drives a real model through the CLI, and nothing in the case
can reach the process clock.

Two existing paths are relevant:

- **Assembly options to governance.** `createAgent` keeps its `params` on the `AssemblyContext`.
  `composeGoverned` hands options to `createWorkflowMiddleware`, which builds the
  `GovernanceContext`. The delegation registry composes every child from the same
  `AssemblyContext`, so an option read there reaches children with no extra work.
- **Per-turn settings for cases.** A case's mocks travel in `configurable.__toolMocks` on the run
  config (`src/core/tool-mocks.ts`). Governance can read the same `configurable` from
  `request.runtime` in `wrapModelCall`; it already derives the session id from there. A sub-workflow
  child's run config spreads its caller's `configurable` (`sub-workflow.ts`, the dispatch's
  `invoke`), so a per-turn key reaches the child too. In the case driver, only `send` builds a
  `configurable`. `decide` and `deliver` pass `runConfig` (just the abort signal) as is.

JavaScript's `Date.parse` is too lenient to validate a pin by itself. Under `TZ=Europe/Berlin`,
`"2026-03-20T10:00"` parses as `09:00Z`, because a date-time without a zone is read in the
machine's zone. `"2026-02-30"` parses as March 2.

## Goals / Non-Goals

**Goals:**

- One place, in `volatileSection`, picks the instant the line shows. The host option and the case
  key both feed it, so neither can miss the reply-only branch or a child.
- A pinned case renders the same line on every machine and on every run.
- A case's pin reaches every model call the case causes: every action, and every child.

**Non-Goals:**

- Suppressing the line. A pin removes the drift and keeps date reasoning testable. A later
  `clock: false` can be added beside the string form without breaking it.
- Faking the runtime's clock. Trail and park timestamps, `archmax_wait`'s `resumeAt`, and the
  sandbox's `Date` stay real.
- A pinned local zone. A pinned line is UTC only. A later `clock: { at, timeZone }` could add a
  zone without breaking the string form.
- Carrying mocks on `decide` and `deliver`. The testing spec says mocks ride each `send`, and this
  change leaves that as it is.
- A CLI flag. `archmax run` keeps the real clock, and `archmax test` gets the pin from the case.

## Decisions

**1. `clock?: string` on `CreateAgentParams`; empty means not set.** A non-empty string pins the
instant, and an absent or empty one keeps the real clock. Treating `""` as unset lets a host pass
an environment value straight through (`clock: process.env.EVAL_CLOCK`) without a guard.
Alternatives:

- `clock?: boolean | string`, so `false` would suppress the line: deferred (see Non-Goals). The
  string covers the use case, and adding `false` later is additive.
- `clock?: Date`: rejected for the option, because a case file cannot carry a `Date`, and two
  types for one setting would need two validation paths. A string also prints the same way in
  YAML, in docs and in an error message.
- An environment variable such as `ARCHMAX_CLOCK`: rejected. It would also pin `archmax run` in the
  same shell, and it would keep the pin in the shell instead of the case file, where a reviewer
  reads it.

**2. A strict ISO 8601 grammar, checked once at the edge.** One function in `src/core/`,
`parseClock(value)`, accepts exactly two forms, and both edges use it:

- `YYYY-MM-DD`, read as midnight UTC.
- `YYYY-MM-DDThh:mm[:ss[.fff]]` followed by `Z` or `±hh:mm`.

It returns the instant, `undefined` for an empty string, or an error message for anything else. A
matching string must also round-trip: shifting the parsed instant by the written offset must give
back the date and time as written. That catches `2026-02-30`, which `Date.parse` rolls into March,
and `25:00`, while `2026-03-20T01:00+02:00`, which falls on the 19th in UTC, still passes.

- **The option** is validated in `createAgent` before anything is composed. An invalid value
  throws a plain `Error` naming `clock`, the value and the accepted forms. No new error class is
  exported, so the public surface is unchanged.
- **The case key** is validated in the case schema, so a bad pin is a parse error that
  `archmax validate` reports too.

The zoneless date-time is the important rejection: it is the one form that would make a pinned
case render differently on a developer's machine and on CI. Alternatives:

- Plain `Date.parse`: rejected for the two leniencies above.
- Rendering the string verbatim as the line's text: rejected. Nothing would validate it, the
  weekday would be whatever the author typed, and the model would read a different format in tests
  than in production.

**3. The pinned instant goes through the same renderer, minus the local-time clause.**
`renderNow(at, { localZone })` takes the instant and whether to append local time. The real clock
passes `new Date()` and `hostTimeZone()`. A pin passes its instant and no zone. Everything else is
shared, so a case sees the production format: UTC, weekday, and the ten-minute rounding and its
note. A pin at `14:37` shows `14:30`; the docs advise pinning on a ten-minute mark.

- **Why no local time:** it depends on the host's zone, so the same pinned case would render
  "Locally that is 15:30 in Europe/Berlin" on one machine and nothing on a UTC CI runner. That is
  exactly the drift this change removes.
- **Rejected alternative:** rendering a pin without the rounding note. That would make the pinned
  line differ in shape from the production line. The rounding is harmless on a pin, and the note
  stays true.

**4. The instant is picked per call: the turn's pin, then the option's, then now.**
`volatileSection` resolves `readClockPin(request.runtime?.configurable) ?? ctx.shaping.clock` and
renders the pin when there is one, else `new Date()` with the host zone. Both branches use that one
value. A pinned line is a pure function of the configuration, so it is byte-stable across every call
and turn. Prompt caching gets slightly better under a pin and never worse.

**5. One configurable key, beside `__toolMocks`.** The same `src/core/` module exports
`CLOCK_CONFIG_KEY = "__clock"` and `readClockPin(configurable): Date | undefined`. It lives in
`src/core/` because `src/workflow/` (the reader), `src/testing/` (the writer) and
`src/assembly/` (the option's check) all import it, as they do `tool-mocks.ts`.

- **What the driver writes:** the normalized ISO instant (`toISOString()`) of a case's validated
  pin, never the author's raw text.
- **How the reader fails:** a value that is not a string reads as unset. A non-empty string that
  fails `parseClock` makes the model call throw an error naming the key. Only a host that writes
  the key by hand can produce one, and failing closed beats silently showing the real time.
- **What stays private:** the key is not exported from the barrel. Hosts use the option, and cases
  use the case key.

**6. The option reaches governance through the existing plumbing.** It goes from the validated
`params.clock`, parsed again where `composeGoverned` builds the middleware, into `PromptShaping.clock`:
the record that already carries how the model-facing payload is shaped (the cache strategy and
TTL) from the assembly into the `GovernanceContext`. A new field there needs no new plumbing.
Children are composed from the same `AssemblyContext`, so they inherit it. `composePlain` ignores
it, because a plain agent renders no clock.

**7. The case's pin is a session start condition, applied on every action.** `clock` joins
`trigger` and `variables` as something a case declares once for its session.

- **Schema:** the case schema takes a string, checks it with `parseClock`, and reports "'clock'
  takes an ISO 8601 date (2026-03-20) or a date-time with Z or an offset (2026-03-20T14:30:00Z)".
- **YAML:** quoting is optional. `yaml` v2 parses YAML 1.2, where an unquoted `2026-03-20` is a
  string, not a timestamp, while `clock: true` is a boolean and is rejected.
- **Carrying it:** `CaseDocument` gains `clock?: string`, holding the normalized instant or nothing
  for an empty value. The driver stores it on the `DriveSession` at `open`. One helper builds each
  action's config: `runConfig`, plus a `configurable` holding `__clock` when the case declared one,
  and `__toolMocks` on `send` as today. `send`, `decide` and `deliver` all go through that helper,
  so none of them can drop the pin.

Alternatives:

- **One agent per pin.** Rejected. The runner may be handed a caller-built agent it cannot rebuild,
  and `archmax test` builds one agent for every case.
- **Persisting the pin on the session as a state channel.** Rejected. A test setting would outlive
  its case if the session id were reused, and per-turn config needs no checkpoint migration.
- **A suite-wide `tests.clock` in `workflow.yaml`.** Not chosen for now. The case key is narrower,
  and a case says what it depends on. A suite default can be added later as a fallback between the
  case key and the host option without changing either.

**8. The "one rendering" claim holds without an exception.** `reference/public-api.md` says every
option and spec setting leaves the rendering alone. A pin changes the instant the line shows, not
the line's shape. The local-time clause it leaves out already varies with the host. The claim needs
no amendment, only the new `clock` section beside it.

## Risks / Trade-offs

- **[Risk] The model's "today" and the sandbox's `Date` disagree under a pin, so a script the agent
  runs to count days since an order uses the real date.** → Mitigation: the testing guide and the
  skill say so beside the case key. A script or hook that needs "today" should read it from a
  variable the case seeds.
- **[Risk] Under a pin, the model may give `archmax_wait` an absolute `until` that is in the real
  past, which the runtime treats as due now.** → Mitigation: documented with the case key. Wait
  flows in cases are resumed by `deliver`, which does not depend on `resumeAt`.
- **[Risk] A host pins the clock in production, and a session that resumes days later reasons as if
  no time had passed.** → Mitigation: the default is the real clock. The option's doc comment and
  `public-api.md` describe it as meant for cases and evaluations, and name parks as the place where
  the real clock matters most.
- **[Trade-off] A pin that is not on a ten-minute mark is shown rounded down.** It keeps the
  production format. The docs advise pinning on a mark.
- **[Trade-off] The internal key is a second `__` key on the run config.** It follows the
  `__toolMocks` precedent and stays unexported. It is still a contract between `src/testing/` and
  `src/workflow/`, held by the shared constant and parser.

## Migration Plan

Additive, and the default is unchanged: existing hosts and cases render exactly as before. Ship it
with a changelog section. A new public option is a `release:minor`. Rollback is a revert, and no
stored session or checkpoint carries the pin.

## Why

Every model call of a governed agent opens its volatile block with `Current date and time: …`,
showing the real time. A case whose fixtures carry dates — an order placed on `2026-03-15`, a
ticket due "in 30 days" — therefore reads a different "now" on every run, so the model's answer,
and the case's verdict, drifts with the real calendar. A case that passed in March fails in October
without anything in the workspace changing. Authors need to fix the date a case runs on, so that
its outcome depends on the workspace alone and date reasoning stays testable.

## What Changes

- **`createAgent({ clock })`**: a new string option. A non-empty value pins the clock: every model
  call the assembly makes renders that instant in the `Current date and time:` line in place of the
  real time. That covers a sub-workflow's child sessions and the call that writes a park's handoff
  message. Absent or empty, the line shows the real time, as today. A plain agent
  (`workflow: false`) renders no clock, so the option changes nothing there.
- **Accepted forms**: an ISO 8601 date (`2026-03-20`, read as midnight UTC) or a date-time with `Z`
  or a UTC offset (`2026-03-20T14:30:00Z`, `2026-03-20T16:30+02:00`). A date-time without a zone is
  rejected, because JavaScript reads it in the machine's own zone and a case would then render
  differently on each machine. So is a date that does not exist (`2026-02-30`), which JavaScript
  would otherwise roll over into March. An invalid value fails assembly naming `clock`.
- **Same line, same format**: a pinned instant goes through the same renderer as the real one: UTC,
  weekday, rounded down to ten minutes. The one difference is that it never appends the host's
  local time, which differs between a developer's machine and CI.
- **A case-level `clock:` key** in `*.test.yaml`, in the same forms. When a case declares it, every
  action of the case (`send`, `decide`, `deliver`) carries it in the run configuration, as `mocks`
  are carried, and it outranks the host option for that case. A case without it runs under the host
  option. One agent still serves every case.
- Only the prompt line changes. The runtime's own clock is untouched: park and trail timestamps,
  `archmax_wait`'s `until` and the sandbox's `Date` still read the real time.
- Suppressing the line entirely is out of scope. A pinned clock already removes the drift and keeps
  date reasoning testable. A later `clock: false` could be added without breaking the string form.
- `archmax run` and every other CLI command keep the real clock. No CLI flag is added.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `assembly`: "System prompt composition" says the clock line shows the pinned instant when one is
  set; "`createAgent` mirrors `createDeepAgent`" lists `clock` among the additive options; new
  requirements describe the `clock` option, the forms it accepts, and how a turn's run
  configuration overrides it.
- `testing`: "A case is one YAML document" lists `clock` among the optional top-level keys; a new
  requirement describes the case-level `clock:` key and how it reaches every action of the case.

## Impact

- **Code**: `src/assembly/index.ts` (`CreateAgentParams.clock`, validated at assembly), the option's
  path through `src/assembly/compose.ts` and `src/workflow/middleware.ts` into `GovernanceContext`;
  `src/workflow/governance.ts` (`renderNow` takes the instant and whether to append local time;
  `volatileSection` picks the instant); `src/testing/case-schema.ts`, `case-document.ts`,
  `interpreter.ts` and `driver.ts` (the case key, carried on every action). One shared module in
  `src/core/` parses a clock string and holds the configurable key beside `__toolMocks`.
- **Tests**: `src/workflow/middleware.test.ts` (pinned line, no local time, reply-only call,
  per-turn override), `src/assembly/assembly.test.ts` (an invalid option fails assembly),
  `src/testing/case-schema.test.ts`, `src/testing/driver.test.ts`, and behaviour-suite checks for a
  child session, a park and two cases on one target.
- **Public API**: one new optional `createAgent` parameter. No new export, so the public-API barrel
  test is unaffected.
- **Docs** (`docs/`): `reference/public-api.md` (a `clock` section), `guides/token-efficiency.md`
  (the clock paragraph), `guides/testing.md` (the top-level keys table and a "Cases and the date"
  section), and a new section in `reference/changelog.md`. A pin changes the instant, not the
  line's shape, so the public-API claim that every option leaves the rendering alone still holds.
- **README.md**: no change. It lists no `createAgent` options beyond the basics and documents no
  case keys; both live in the docs and the skill.
- **Authoring skill** (`skills/archmax-harness/`): `references/cases.md` and
  `references/code-state-and-test-scripts.md` (the top-level keys tables, and when to pin a case's
  clock), `references/backend-integration.md` (the options table) and `references/wiring.md` (the
  option in the `createAgent` sketch).

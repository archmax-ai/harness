## 1. Setup

- [x] 1.1 Verify the baseline with `npm run typecheck` and `npx vitest run src/workflow/middleware.test.ts -t "clock"`, which both pass on the unchanged tree.

## 2. Parsing a clock string

- [x] 2.1 Add the shared clock module in `src/core/` (design decisions 2 and 5), with three exports. `parseClock(value)` accepts `YYYY-MM-DD` and `YYYY-MM-DDThh:mm[:ss[.fff]]` with `Z` or `±hh:mm`, and checks the round-trip. `CLOCK_CONFIG_KEY = "__clock"`. `readClockPin(configurable)` reads a non-string as unset and throws on a non-empty string that fails to parse.
- [x] 2.2 Write that module's colocated test. `parseClock` cases: `2026-03-20` is midnight UTC; `2026-03-20T16:37+02:00` is `14:37Z`; `2026-03-20T01:00+02:00` is accepted although it falls on the 19th in UTC; `""` is `undefined`. These are rejected: `2026-03-20T10:00` (no zone), `2026-02-30`, `2026-03-20T25:00Z`, `next tuesday` and `20260320`. Run the zone-sensitive cases under a stubbed non-UTC `TZ`, so the result is the same on any machine. `readClockPin` cases: a non-string reads as unset, and an unparseable string throws naming the key. Verify with `npx vitest run src/core/` on the new test file.

## 3. The `clock` option

- [x] 3.1 Add `clock?: string` to `CreateAgentParams` in `src/assembly/index.ts`. Its doc comment says what the empty and absent values mean, that the option is meant for cases and evaluations, and that parks are where the real clock matters most. Validate it with `parseClock` before anything is composed, throwing an `Error` that names `clock`, the value and the accepted forms. Thread the resulting `Date` (or nothing) through `composeGoverned` and `createWorkflowMiddleware`'s options into `PromptShaping.clock` (design decision 6). `composePlain` does not read it. Verify with `npm run typecheck`, and add a test to `src/assembly/assembly.test.ts` that `clock: "2026-03-20T10:00"` and `clock: "2026-02-30"` fail assembly naming `clock`, while `clock: ""` assembles.
- [x] 3.2 Change `renderNow` in `src/workflow/governance.ts` to take the instant and the local zone to append (`null` for none), per design decision 3. In `volatileSection`, resolve `readClockPin(request.runtime?.configurable) ?? ctx.shaping.clock` once. Render the pin with no local zone, or `new Date()` with `hostTimeZone()`, on both the reply-only and the normal branch. Verify with the tests in 3.3.
- [x] 3.3 In `src/workflow/middleware.test.ts`, under "the clock in the state prompt", add tests:
  - A pinned `14:30Z` renders exactly `Current date and time: 2026-03-20 14:30 UTC (Friday), rounded down to the nearest 10 minutes — it can be that much behind.`, with a non-UTC host zone stubbed and no "Locally" clause.
  - A pin at `14:37` renders `14:30`.
  - The line stays the same when fake timers advance hours.
  - The reply-only call carries the pin.
  - A per-turn `__clock` pin outranks no option, and also outranks an option's pin.
  - A per-turn non-string falls back to the option.

  The existing real-clock tests must still pass unchanged. Verify with `npx vitest run src/workflow/middleware.test.ts -t "clock"`.
- [x] 3.4 In the behaviour suite, add checks with the scripted fake model, recording each model call's system text.
  - In `src/behaviour/delegation.test.ts`: with a pinned `clock`, and separately with a per-turn `__clock` pin on an agent without one, every model call of the child session carries the pinned line.
  - In `src/behaviour/parks.test.ts`: with a pinned `clock`, an `archmax_wait({ until: "1d" })` park still records real timestamps, and a `resumeAt` one day after the real time.

  Verify with `npx vitest run src/behaviour/delegation.test.ts src/behaviour/parks.test.ts`.
- [x] 3.5 Docs for the option. In `docs/src/content/docs/reference/public-api.md`, add a `### clock: pinning the date` section beside `images`, covering:
  - the accepted forms and what an empty value means;
  - that a pinned line is UTC only and rounded like the real one;
  - what stays real (recorded timestamps, the sandbox's `Date`);
  - the risk of pinning in production across parks.

  In `docs/src/content/docs/guides/token-efficiency.md`, say in the clock paragraph that a pin (the option or a case's `clock:`) replaces the instant and leaves out the local time. Verify with `npm run docs:build`.
- [x] 3.6 Authoring skill for the option. In `skills/archmax-harness/references/backend-integration.md`, add a `clock` row to the `createAgent` options table, and add `clock` to the option list near line 718 if that list enumerates all of them. In `skills/archmax-harness/references/wiring.md`, add `clock` to the options comment in the `createAgent` sketch. Verify with `grep -rn "clock" skills/archmax-harness`, which shows each addition.

## 4. The case-level `clock:` key

- [x] 4.1 In `src/testing/case-schema.ts`, accept a top-level `clock` string, validated with `parseClock` (design decision 7, including its error message). Add `clock?: string` to `CaseDocument` in `case-document.ts`, holding the normalized ISO instant or nothing for `""`, and have `parseCaseDocument` set it. In `src/testing/case-schema.test.ts`, test that:
  - unquoted `clock: 2026-03-20` and quoted `clock: "2026-03-20T14:30:00Z"` parse to their instants;
  - `clock: ""` parses to no pin;
  - `clock: "2026-03-20T10:00"`, `clock: "next tuesday"` and `clock: true` fail naming `clock` and the accepted forms;
  - the unknown-key message's known-key list now includes `clock`.

  Verify with `npx vitest run src/testing/case-schema.test.ts`. `archmax validate` uses the same parser, so it accepts and rejects the same documents.
- [x] 4.2 Make the pin a session start condition (design decision 7). `SessionStartConditions` and `DriveSession` in `src/testing/driver.ts` gain `clock?: string`, and `interpreter.ts` passes `doc.clock` when it opens the session. One helper builds each action's config: `runConfig`, plus a `configurable` holding `[CLOCK_CONFIG_KEY]` when there is a pin and `__toolMocks` on `send` only, as today. `send`, `decide` and `deliver` all use it. In `src/testing/driver.test.ts`, test that each of the three actions passes the pinned instant when the case declared one and no `__clock` when it did not, and that `decide`/`deliver` still carry no mocks. Verify with `npx vitest run src/testing/driver.test.ts`.
- [x] 4.3 In `src/behaviour/cases.test.ts`, run two cases on one target. The first declares `clock: 2026-03-20`, parks at a human state on `send`, and is resumed by `decide`. The second declares nothing. Check that every model call of the first case, the handoff call and the calls after the `decide` included, shows `2026-03-20 00:00 UTC (Friday)`, and that the second case's calls show the real time. Verify with `npx vitest run src/behaviour/cases.test.ts`.
- [x] 4.4 Docs for the case key. In `docs/src/content/docs/guides/testing.md`, add a `clock` row to the top-level keys table and a short "Cases and the date" section covering:
  - why a case whose fixtures or prompts carry dates should pin its clock;
  - the accepted forms, with the advice to pin on a ten-minute mark;
  - that code-state scripts, the sandbox and recorded timestamps still read the real clock, so a script that needs "today" should read it from a seeded variable;
  - that an absolute `archmax_wait` `until` may land in the real past.

  Verify with `npm run docs:build`.
- [x] 4.5 Authoring skill for the case key. Add a `clock` row to the top-level keys tables in `skills/archmax-harness/references/cases.md` and `references/hook-and-test-scripts.md`. In the latter's start-conditions section, add when to pin (fixtures or prompts that carry dates) and the sandbox caveat. Check `skills/archmax-harness/SKILL.md` for a list of case keys and add `clock` there if one exists. Verify with `grep -rn "clock" skills/archmax-harness`.

## 5. Release notes and integration

- [x] 5.1 Add entries for the `clock` option and the case key to the unreleased `0.9.0` section of `docs/src/content/docs/reference/changelog.md`, linking to the public-API and testing pages. Verify with `npm run docs:build`.
- [x] 5.2 Confirm that `README.md` needs no change: grep it for `createAgent` option lists and case top-level keys and find neither to extend.
- [x] 5.3 Run `npm run typecheck`, `npm test`, `npm run lint`, `npm run build`, `npm run docs:build`, `npx openspec validate pin-prompt-clock --strict` and `npx openspec validate --specs`. All pass.

## Workflow follow-up

- Archive the change with `/opsx:archive` once it is reviewed and merged, which syncs the `assembly` and `testing` deltas into `openspec/specs/`.

# Tasks

## 1. One story for child sessions (docs correction, no behaviour change)

- [x] 1.1 Ship collectively with the in-flight `platform-prompt-reset-and-title` and `pin-prompt-clock` changes: retitle the changelog's `0.4.3` section `0.5.0` (a minor release), and make this change's skill and changelog edits on top of their uncommitted edits to the same files. Verify that the changelog has one unreleased section, `0.5.0`, and that `git diff` keeps the other changes' text.
- [x] 1.2 Add a behaviour test to `src/behaviour/delegation.test.ts` pinning "A child's file space is its own".
  - A child writes `scratchpad/notes.md` and `scratchpad/result.json`, the caller has its own `scratchpad/result.json` and `scratchpad/secret.txt`, and the child reads `scratchpad/secret.txt`.
  - Assert that the child's files exist only under the child session, the caller's `result.json` is unchanged, and the child's read finds nothing.
  - Verify with `npx vitest run src/behaviour/delegation.test.ts`. This should pass already, which confirms the runtime matches the requirement.
- [x] 1.3 Rewrite "What crosses, and what does not" in `docs/src/content/docs/guides/sub-workflows.md`.
  - The "Up" row lists the declared `returns` and the result message; `file` returns arrive as copies.
  - Replace "any files the child wrote" and the contradicting "never the child's files" sentence with one statement: the child is a separate session with its own file space, it never writes into the caller's, and only copies of declared `file` returns come back.
  - Verify with `grep -n "files the child wrote" docs/` (no match).
- [x] 1.4 In `docs/src/content/docs/guides/triggers.md`, make "Its session derives from the caller's" say the child is a separate session whose id derives from the caller's, with its own `scratchpad/`. Verify by reading it against the delegation spec's "The child is its own session" requirement.
- [x] 1.5 Fix the skill's stale passages, then verify with `grep -rn "run zone\|shared session\|shares its parent's session" skills/` (no match).
  - `skills/archmax-harness/references/workflow-schema.md`:
    - replace the "Same agent, isolated context, shared session" bullet with "own session, own `scratchpad/`";
    - replace "Up: only the result message and the files" with "declared returns and the closing message; `file` returns copied";
    - drop "Give each concurrent sub-run its own output path — they share one run zone";
    - fix "a sub-run shares its parent's session" to "a sub-run is its own session".
  - `references/hook-and-test-scripts.md`: drop "they share one run zone".
  - `references/backend-integration.md`: replace "The child runs on the parent's session id … nested checkpoint namespace, so `sessions.list()` reports one session" with the separate-session model (`<parent>~<state>:<workflow>:<n>`, `parentSessionId`, own checkpoints and zone).
- [x] 1.6 Change the header comment of `src/workflow/sub-workflow.ts` from "what the child wrote to the run zone" to "copies of its declared `file` returns". Verify with `npm run typecheck`.

## 2. The `file` signature type

- [x] 2.1 In `src/machine/signature.ts`:
  - add `file` to `SIGNATURE_TYPES`;
  - implement the path grammar in `conforms` (a path from the workspace root: one leading `/` tolerated, at least one segment, no empty, `.` or `..` segment, no `\`, no NUL, no trailing `/`);
  - add its `TYPE_PHRASES` entry ("a path to a file in the workspace");
  - map it in `signatureJsonSchema` to `{ type: "string", format: "file" }`.

  Verify with new cases in `src/machine/signature.test.ts`: the accepted paths, each refused shape from the spec scenario, and the mapping.
- [x] 2.2 Confirm that the strict schema picks up the type and its refusal lists `file`. Verify with `npx vitest run src/machine/spec-schema.test.ts` and a new case loading `requires: [{ name: invoice, type: file }]` and `returns: [{ name: report, type: file }]`.
- [x] 2.3 Document the type:
  - the signature-types table in `docs/src/content/docs/reference/machine-spec.md` and the types paragraph in `guides/triggers.md`;
  - the signature types in `skills/archmax-harness/references/workflow-schema.md`, and `SKILL.md` if it lists them;
  - open the `0.5.0` section in `reference/changelog.md` with the type.

  Verify with `npm run docs:build`.

## 3. Byte transfer and the attachments folder

- [x] 3.1 Export a byte read/write pair from `src/core/file-operations.ts` (`readBytes(backend, path)`, `writeBytes(backend, path, bytes)`), factored from `readSource`/`writeDestination`, keeping the exact-bytes readback and the no-lossy-text refusal. Move `copy_file`/`move_file` onto them. Verify with `npx vitest run src/core/file-operations.test.ts src/behaviour/file-operations.test.ts` (unchanged behaviour).
- [x] 3.2 Add `src/core/attachments.ts`:
  - `attachmentName(taken, fileName)` implements the suffix rule: lowest free `-N` before the last extension, the end for no extension or a leading-dot name.
  - `placeAttachment(backend, sessionId, fileName, bytes)` lists `scratchpad/attachments/`, chooses a free name and writes it with `writeWorkspaceBytes` (exact bytes, read back) as one step, serialized per session, so concurrent placements never pick the same name.

  Verify with a colocated `attachments.test.ts` covering `report-2.pdf`, `notes-1`, `.env-1`, `archive.tar-1.gz`, and two concurrent placements of `report.pdf` landing on distinct names.
- [x] 3.3 Build the `SessionFiles` port in assembly (`src/assembly/compose.ts`) over the workspace composite and `sessionBinder`: `read(sessionId, path)` and `place(sessionId, fileName, bytes)`, each binding the named session. Thread it into the dispatcher options. Verify with a unit test that places into a child id from inside a parent binding and reads it back from the child's folder in the store.
- [x] 3.4 Cover the store limits in `src/behaviour/bare-stores.test.ts`: a placement of non-UTF-8 bytes through a store without `uploadFiles` fails naming the path and writes nothing; the filesystem store round-trips the bytes exactly. Verify with `npx vitest run src/behaviour/bare-stores.test.ts`.
- [x] 3.5 Document `scratchpad/attachments/` (who places files there, the naming rule, the store requirement for binary files) in `docs/src/content/docs/guides/sessions.md`, and add the changelog line. Verify with `npm run docs:build`.

## 4. A file value names a file the session holds

- [x] 4.1 Add async `fileValueIssues(entries, values, { backend, readable })` to `src/workflow/signature-checks.ts`. For each conforming `file` value it returns an `invalid` issue when `readable(path)` (the kernel's `read_file` verdict with `origin: "lifecycle"` in the state in force) denies it, naming the rule's reason, or when the path is not a non-directory entry of its parent folder ("'<name>' must name a file, but nothing is at '<path>'"). Verify with unit tests: a file, a missing path, a folder, a path under a `mounts.forbid_always` mount, `checkpoints/…`, and an authored file under `skills/`.
- [x] 4.2 Run it at the turn boundary after the pure rule (middleware `beforeAgent`). Verify with a test in `src/behaviour/variables.test.ts`: a seed naming a missing file is refused with no model call, and the same seed with the file present starts.
- [x] 4.3 Run it in `archmax_set_variables`' typed-return write check (`src/workflow/control-tools.ts`) as a correctable refusal. Verify in `src/workflow/control-tools.test.ts` that the write is refused before the file exists and succeeds after.
- [x] 4.4 Run it in the completion check, keeping one returns-rejection string so `settledReturns` still recognises it. Verify with a test in `src/behaviour/returns.test.ts`: a file removed after `report` was set rejects the session naming the state, `report` and `file`.
- [x] 4.6 Fix found on the way: `agent.workflow.send(id, { variables })` never satisfied a trigger's `requires`, because turn variables went into the graph's `variables` channel and the turn boundary checks only the opening seeds. Route a turn's variables through the per-invocation seed channel (`SEED_VARIABLES_KEY`) the boundary reads. `TurnInput.files` depends on it. Verified by "starts on a turn's own variables, sent with the message" in `src/behaviour/variables.test.ts` and by the full suite. (The file-check behaviour tests for 4.2–4.4 live in `src/behaviour/files.test.ts`.)
- [x] 4.5 In `guides/triggers.md` and the skill's signature section, document where a `file` value must exist and be readable on runtime authority (the four boundaries), and that the pure rule checks shape only. Verify with `npm run docs:build`.

## 5. File arguments are copied into the child

- [x] 5.1 In `check()` (`src/workflow/sub-workflow.ts`), run `fileValueIssues` against the caller's session after the pure rule, so a missing file is refused `invalid-param` before composition and `refusal()` reports it. Verify with a `src/workflow/sub-workflow.test.ts` case: no child session is created.
- [x] 5.2 In `run()`, copy each `file` argument with `files.read(callerId, path)` and `files.place(childId, basename, bytes)`, in declaration order, before `child.driver.invoke`. Seed the child with the placed paths and render the opening note from them. Verify with behaviour tests in `src/behaviour/delegation.test.ts`:
  - identical bytes in the child;
  - the child's `invoice` reads `scratchpad/attachments/invoice.pdf`;
  - the opening note shows it;
  - the child's edit leaves the caller's file unchanged;
  - two arguments named `statement.pdf` become `statement.pdf` and `statement-1.pdf`;
  - a `${{…}}` argument from a script is copied;
  - an authored `skills/…` file is copied like a session file.
- [x] 5.3 Register each allow-listed delegation tool's `file` arguments as `read` path arguments in the per-assembly tool-path table. Verify with a governance test: `{ tool: archmax_workflow_reconcile, paths: ["scratchpad/inbox/**"] }` blocks `scratchpad/private/payroll.pdf`, copies nothing and starts no child.
- [x] 5.4 Record a failed call's arguments as the caller's resolved params, not the rewritten seeds. Verify with a test in `src/behaviour/delegation.test.ts`: the `on_error` route names `scratchpad/inbox/invoice.pdf`.
- [x] 5.5 Add the file sentence to the delegation tool description only when the target declares a `file` entry. Verify in `src/workflow/sub-workflow.test.ts` (or the tool-description test): the sentence is present for a file target, and the description is byte-identical for a target without one.
- [x] 5.6 Add a "Passing files" section to `guides/sub-workflows.md` (arguments copied into the child's `scratchpad/attachments/`, the governance of the read, failure records), and a matching paragraph in the skill's delegation section. Add the changelog line. Verify with `npm run docs:build`.

## 6. File returns are copied back

- [x] 6.1 In `settledReturns`, after the conformance and existence checks, copy each set `file` return with `files.read(childId, path)` and `files.place(callerId, basename, bytes)` and rewrite `returns[name]`. A failure becomes `invalid-return` naming the variable. Verify in `src/behaviour/delegation.test.ts`:
  - the first call lands `report.pdf`;
  - a second call lands `report-1.pdf` and leaves the first unchanged;
  - an agent-written `scratchpad/attachments/report.pdf` is kept, and the copy is `report-1.pdf`;
  - an unset file return copies nothing and yields the `note`;
  - a file removed before settling fails `invalid-return`;
  - a return under a mount the root's `mounts.forbid_always` denies fails `invalid-return` and copies nothing;
  - an authored `skills/…` return is copied.
- [x] 6.2 Concurrency: run three children in one tool batch, and three through a script's `Promise.all`, each returning `report.pdf`. Assert three distinct names, each call's `returns.report` naming its own, and each file holding its own child's bytes. Verify with `npx vitest run src/behaviour/delegation.test.ts -t "concurrent"`.
- [x] 6.3 Resume: a child parks at a human state and is decided, then settles with a `file` return. Assert the copy lands in the parent at that settle and the `sub-workflow` note names the parent-side path. Verify with `npx vitest run src/behaviour/parks.test.ts`.
- [x] 6.4 Mocks: give `applyMock` the port. A mocked `file` return naming a caller fixture is copied into `scratchpad/attachments/`, and one naming no file fails `invalid-return`. Verify with a case in `src/behaviour/cases.test.ts` that seeds `scratchpad/fixtures/report.txt` via `workspace:`.
- [x] 6.6 Fix found on the way: a child resumed after a park answered its caller with its closing message only, so the caller never saw its returns (and could not find a copied `file` return). The `sub-workflow` note now carries `returns: {…}` beside the message when the child declares returns. Verified by "copies a file return back when a child that parked settles" and the full suite. (Task 6.2's concurrency is covered by a three-call tool batch plus `placeAttachment`'s concurrent-placement unit test; 6.4's mock by a behaviour test passing `__toolMocks`; 5.4 needed no code — `callInput` already records the caller's resolved arguments.)
- [x] 6.5 Document file returns in `guides/sub-workflows.md` (the copy, the suffix rule, concurrent calls) and in the skill. Add a cases note on mocking a `file` return to `guides/testing.md` and the skill's cases reference. Add the changelog line. Verify with `npm run docs:build`.

## 7. Hosts and the CLI hand a session files

- [x] 7.1 Add `files?: Record<string, { name: string; content: Uint8Array }>` to `TurnInput` (`src/agent.ts`). In the send path (`src/sessions/resume.ts` / turn start):
  - validate the names (a single plain segment);
  - reject a variable given in both `files` and `variables`;
  - place each file under the bound session;
  - merge the paths into the invocation's `variables`.

  Verify with `src/behaviour/sessions.test.ts`:
  - a host file satisfies a `file` input;
  - a second turn's same-named file lands at `invoice-1.pdf`;
  - a bad name is refused with nothing written;
  - a variable given twice is refused.
- [x] 7.2 Export any new public type (e.g. `TurnFile`) from `src/index.ts` and list it in `docs/src/content/docs/reference/public-api.md`. Verify with `npx vitest run src/index.test.ts`; the barrel and doc are checked against each other both ways.
- [x] 7.3 Add `multiple?: boolean` to the CLI flag shape (`src/cli/command.ts`), passed through to `util.parseArgs`. Add `--file <variable>=<path>` to `run` in `src/cli.ts`: it reads the local file, uses its base name, and feeds `TurnInput.files`. A missing `=`, an invalid name, a duplicate, an overlap with `--variables` or an unreadable file is a one-line usage error with exit 2. Verify with `src/cli.test.ts` cases for each, plus a happy path asserting the placed file and the seeded variable.
- [x] 7.4 Document `--file` in `docs/src/content/docs/reference/cli.md` and `guides/cli.md`, the `AGENTS.md` command table, and the skill's CLI reference. Document `TurnInput.files` in `skills/archmax-harness/references/backend-integration.md`. Add one line to README.md on `file` inputs and returns, with a `--file` example where `run` is shown. Add the changelog lines. Verify with `npm run docs:build`.

## 8. Integration

- [x] 8.1 End to end against a scratch workspace with a parent that delegates to a child taking `invoice: file` and returning `report: file`. Run `npm run dev -- run <parent> "…" --file invoice=<local pdf> --root <workspace>` twice in one session. Verify that the child's session holds its own `scratchpad/attachments/invoice.pdf`, and the parent holds `report.pdf` then `report-1.pdf`.
- [x] 8.2 Run `npm run typecheck`, `npm test`, `npm run build`, `npm run docs:build`, `npx openspec validate file-signature-type --strict` and `npx openspec validate --specs`. All pass.

Notes on group 8: 8.1 ran without a live model, which would send the workspace to an external endpoint. It is covered by the CLI happy path (`driveTurn` with a scripted model: `--file` placed and seeded, in `src/cli.test.ts`), the delegation behaviour tests (copy in, copy back, suffixes, a three-call tool batch), and a one-off run of the reference workspace's `enrichment-fan-out` case through `runTests` with a scripted model. That run passed, with the fixture copied to `scratchpad/attachments/ORD-1002.json`. A live `archmax run … --file` against a configured model is still worth doing once before release. 8.2 passed: typecheck, lint, 2566 tests, build, docs build, and `openspec validate` (change `--strict`, and specs).

## Workflow follow-up

- Release as `0.5.0` (PR labelled `release:minor`).
- Pangea:
  - bump `@archmax-ai/harness`;
  - render a file control in `StartTurnFields` for `format: "file"`;
  - upload through `TurnInput.files` (or into `scratchpad/attachments/` directly);
  - add the `workflows.editor.signature.types.file` label;
  - decide what MCP and webhook callers send for a `file` input.
- Archive the change once implemented and reviewed (`/opsx:archive`).

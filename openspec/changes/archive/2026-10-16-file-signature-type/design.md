# Design

## Context

- **Signatures.** Types and the conformance rule live in `src/machine/signature.ts`, which is
  pure and browser-safe. Pangea imports `signatureValueIssues` and `signatureJsonSchema` through
  `@archmax-ai/harness/spec` and runs them in its start form. The strict schema's enum is
  `SIGNATURE_TYPES` itself. Every runtime check calls `signatureValueIssues`:
  - the turn boundary (middleware `beforeAgent`, via `signature-checks.ts`);
  - `archmax_set_variables` (`control-tools.ts`);
  - the completion check;
  - the delegation refusal (`sub-workflow.ts` `check()`);
  - `settledReturns`.
- **Children are already isolated.** A child is a separate session,
  `<parent>~<state>:<workflow>:<n>`. The dispatcher invokes it through `child.driver.invoke`,
  the child's own turn runner, whose `sessionBinder` binds the session zone to the child's id. Its
  id-free paths therefore already resolve inside its own folder. The docs and skill passages
  saying otherwise predate child sessions; see the proposal for the list.
- **Addressing another session.** The dispatcher runs inside the caller's binding. The session
  zone router passes a path through unprefixed only when it equals or starts with
  `<boundId>/`. A child id is `<boundId>~…`, so the dispatcher can't write
  `<childId>/scratchpad/…` from the caller's binding: the router would prefix it with the caller's
  id. It has to bind the child.
- **Byte transfer.** `src/core/file-operations.ts` already moves exact bytes. It reads through
  `downloadFiles` (always present on the mapped backend, with a `readRaw` fallback). It writes
  through `uploadFiles` when the store has it, and otherwise as text only when the bytes are valid
  UTF-8, refusing the rest. It also reads the result back to verify it. Its helpers are private
  and work within one backend binding.

## Goals / Non-Goals

**Goals:**

- One type word, one value shape, the same at every ingress (host, CLI, delegation, case).
- A file moving between sessions is always a copy made on the runtime's authority. No session
  ever holds a path into another session's folder.
- No collision can lose a file, including between concurrent children of one caller.

**Non-Goals:**

- Size limits or quotas on copied files. A host that needs them enforces them at upload.
- Files nested inside `object` or `array` values. Only a top-level `file` entry is copied.
- Binary `from:` fixtures in cases. Fixtures are still read as text, which is enough to test the
  mechanism.
- Cleaning up attachments. They live and die with their session, like the rest of `scratchpad/`.

## Decisions

**1. A `file` value is a path string from the workspace root.** The value is a workspace path
such as `scratchpad/attachments/invoice.pdf` or `skills/billing/assets/template.pdf`, with one
leading `/` tolerated, as the workspace tolerates it. It is not an object such as
`{ path, name, mediaType }`.

- A string is what the agent already passes to `read_file` and writes with
  `archmax_set_variables`.
- It renders in the opening note.
- It maps to `{ type: string, format: file }`.

The grammar only refuses malformed paths:

- empty, `.` or `..` segments;
- a backslash or NUL;
- a trailing `/`.

Where the path may point is a governance question (decision 2), not a shape one.

*Alternatives:*

- Restrict values to `scratchpad/`: simpler governance, but an authored asset would have to be
  copied into the scratchpad before it could be passed or returned. The user asked for any root
  path.
- An opaque file handle: a new value kind the model can't write by hand.

**2. Shape is pure; existence and readability are runtime checks.** `conforms("file", v)` checks
only the path grammar, so pangea's form gate and MCP validation stay synchronous and
browser-safe. A new async `fileValueIssues(entries, values, { backend, readable })` in
`signature-checks.ts` adds an `invalid` issue for each conforming `file` value that fails either
check:

- **Readability:** `readable(path)` is the kernel's verdict for a `read_file` of the path with
  `origin: "lifecycle"` in the state in force. That is runtime authority: the per-state allow list
  and mount and skill grants are skipped, but zone rules (`zone.runtime-internal`) and every
  workflow-wide denial bind, including the ones a child inherits from its ancestors. A denial
  reads "'<name>' names '<path>', which this session may not read: <reason>".
- **Existence:** the value must name a non-directory entry of its parent folder (`ls`). A miss
  reads "'<name>' must name a file, but nothing is at '<path>'".

Each site runs it after the pure rule, so one message format reaches every caller:

- the turn boundary;
- the write check;
- the completion check;
- the delegation `check()`, against the caller.

The completion check keeps one refusal string, so `settledReturns` still recognises a
returns-only rejection.

This is what keeps copy-back from laundering a file. A child inherits every ancestor's
`forbid_always` lists. A child that returns a path under a mount its root denied fails its own
completion check, before the runtime reads anything, so no file a caller may not read on runtime
authority is ever copied into the caller's `scratchpad/`. A host's seed is held to the same rule:
a host can't hand a session a path the session itself could never read.

**3. A `SessionFiles` port for cross-session copies.** Assembly builds a small port and hands it
to the dispatcher. It is built over the workspace composite and `sessionBinder`:
`read(sessionId, path) → bytes`, `place(sessionId, fileName, bytes) → path`. Each call binds the
named session for its duration. AsyncLocalStorage nests, so binding the child inside the caller's
turn and returning to the caller afterwards is safe.

`file-operations.ts` exports its existing byte read/write pair (`readBytes`, `writeBytes`), which
keep the exact-bytes guarantee and the readback check. The port and `copy_file` share them.

*Alternative:* write `<childId>/…` through the raw session store. Rejected: it bypasses the router
and its id validation, and needs a second notion of where a session's folder lives.

**4. The attachment naming rule, serialized per session.** `placeAttachment`
(`src/core/attachments.ts`) chooses the name and writes it as one step:

1. List `scratchpad/attachments/`.
2. Take the file's own name, or the lowest free `stem-N.ext`.
3. Write the bytes with `writeWorkspaceBytes` (exact, read back).

Placements into one session run one at a time through a per-session promise queue
(`Map<sessionId, Promise>`). Listing, choosing and writing can't interleave, so
concurrent children of one caller settling at once each take their own name. A
reservation set alone wasn't enough, because a backend's `write` overwrites an
existing file: a placement that listed before another one's write landed could
pick the same name. A session's turn runs in one process, so an in-process queue
covers every placement into it. An agent's own `write_file` racing a placement in
the same instant isn't guarded. That is the agent overwriting its own folder,
which `write_file` already allows.

*Alternatives:*

- Per-dispatch subfolders (`attachments/<dispatchId>/report.pdf`): no collisions at all, but the
  user asked for flat names with suffixes, and dispatch ids mean nothing to the agent.
- Timestamps: not deterministic in tests.

**5. Where the copies happen in the dispatcher.**

- **Copy-in** happens in `run()` after `check()` and before `child.driver.invoke`:
  1. Resolve the params (already done).
  2. For each `file` entry, `read(callerId, path)` and then `place(childId, basename, bytes)`.
  3. Rewrite the seed to the placed path.
  4. Render the opening note from the rewritten seeds.

  The child's attachments folder is empty at dispatch: child ids carry a fresh ordinal. A
  re-dispatch reaching an existing child id only happens on a replayed parent, which re-places the
  same bytes. Collisions between two arguments are resolved by the same rule.

  The existence check is part of `check()`, so `refusal()` reports a missing file as
  `invalid-param` before any child is composed.
- **Copy-back** happens in `settledReturns`, which both `run()` and `resume()` call. The
  child's completion check has already held each `file` return to existence and readability
  (decision 2), so a child rejected for its returns is recognised by `isReturnsRejection`
  (the one sentence shape `returnsRejectionFor` writes) rather than by recomputing the
  sentence, which the dispatcher can't do without the child's kernel. Such a rejection
  fails `invalid-return`. For each `file` return the child set, `settledReturns` then
  runs `read(childId, path)` and `place(callerId, basename, bytes)`, and rewrites
  `returns[name]`. A read or place failure also becomes `invalid-return`, naming the
  variable.
- **Mocks:** `applyMock` gets the port too and copies from the caller's own session, so a case
  sees the same `scratchpad/attachments/<name>` path a real call gives.

**6. Governance of copy-in.** The delegation tool registers its `file` arguments as `read` path
arguments in the tool-path table (`resolveToolPaths` gets a per-assembly entry for each
allow-listed `archmax_workflow_<slug>` whose signature has `file` entries). The kernel's path
rules and any `paths:` guard on that tool then bind the argument, with no new rule. Signatures are
read at assembly for every allow-listed target, so the table is complete before the first call.

**7. Failure records keep the caller's paths.** Control tools record a failed dispatch's
arguments. They record the resolved params from before the copy-in rewrite, so an `on_error`
route and failure recovery name the paths the caller wrote. The dispatcher returns the rewritten
seeds separately, for the opening note only.

**8. `TurnInput.files` and the CLI.**

- **`send`:** `agent.workflow.send` validates the files, places each through the same port and
  naming rule under the bound session, merges `{ [var]: path }` into the invocation's
  `variables`, and proceeds. Validation means each name must be a single plain segment (no `/`,
  `\`, NUL, `.` or `..`, non-empty), and no variable may appear in both `files` and `variables`.
  Placing before the turn boundary means the boundary's existence check sees the files.
- **CLI:** the command table gains `multiple: true` for string flags (passed straight to
  `util.parseArgs`). `run` maps each `--file var=path` to `{ name: basename(path), content:
  readFileSync(path) }`. The CLI is a host, so reading local files there is consistent with the
  rule that the runtime reads only through a backend.

**9. Documentation is corrected in the same change.** Every stale "shared session / run zone"
passage is rewritten to the isolated-session model, and the sub-workflows guide gains a
"Passing files" section. The full list is in the proposal's Impact. The header comment of
`sub-workflow.ts` ("what the child wrote to the run zone") changes to "copies of its declared
`file` returns".

## Risks / Trade-offs

- **Large files are copied twice** (in and back) through memory. → No cap in this change. The
  port reads whole files, as `copy_file` does. A streaming port can come later without touching
  the specs.
- **A store without `uploadFiles` can't carry binary files.** → The placement fails closed with
  an error naming the path and the store, never a lossy text write. The filesystem and memory
  stores have `uploadFiles`, and `createBackendSessionStore` has it whenever its backend does.
  The docs say so.
- **Turn-boundary reads cost latency.** → One existence check per `file` entry, only for
  signatures that declare one. Sessions without `file` entries pay nothing.
- **The placement queue is in-process only.** → A session's turn runs in one process. A host that
  ran one session's turns on two workers at once would already break checkpoints, so this adds no
  new constraint.
- **Attachments accumulate** across many calls in a long session. → They are ordinary scratchpad
  files, deleted with the session. The suffix keeps them distinct rather than unbounded in name
  length.

## Migration Plan

This is additive.

- Existing specs, signatures and hosts are unchanged.
- A spec using `type: file` fails to load on an older harness version, with the existing "'type'
  must be one of …" message.
- Pangea picks the type up when it bumps the dependency. Until it renders a file control,
  `format: file` falls back to its plain string input, which still works with a path.
- Ships as a minor release (`release:minor`), together with the other in-flight changes, under
  one `0.5.0` changelog section.

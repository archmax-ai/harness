# Proposal

## Why

A trigger's signature can say a variable is a number, a date or an object, but not that it is a
file. A workflow that works on an uploaded invoice or produces a report has no way to declare
that. Its caller passes a path string and hopes the file is there, and a host such as pangea
can't render a file picker for that input. Delegation makes the gap worse. A child is its own
session with its own `scratchpad/`, so a path from the caller's workspace means nothing inside the
child, and a file the child produces stays in a session its caller never reads. The documentation
contradicts itself on this point. The sub-workflows guide says files cross back up in one sentence
and that they never do in the next. The authoring skill still describes children as sharing their
parent's session and run zone, which stopped being true when children became separate sessions.

## What Changes

- **A ninth signature type, `file`.** A `requires` or `returns` entry may declare
  `{ name, type: file }`. The value is a path from the workspace root: a session file such as
  `scratchpad/attachments/invoice.pdf`, or an authored one such as
  `skills/billing/assets/template.pdf`. The one conformance rule checks the path's shape (pure,
  so it stays browser-safe). The one JSON Schema mapping renders it as
  `{ type: "string", format: "file" }`, so a host can show a file picker.
- **A `file` value must name a file that exists and that the session may read**, wherever it
  crosses a boundary:
  - at the turn boundary for a host's seeds;
  - at `archmax_set_variables` for a typed return;
  - at the completion check;
  - at a delegation call.

  "May read" means on runtime authority: the rules that bind a hook, which are the zone rules
  and every workflow-wide denial, inherited ones included. A path with nothing there, or one
  those rules deny, is refused like a mistyped value. The runtime checks for the file through the
  backend; the pure rule doesn't check it.
- **Files are copied into a child, never shared.** When a caller passes a `file` argument to
  `archmax_workflow_<slug>`, the runtime copies that file's exact bytes into the **child's**
  `scratchpad/attachments/` before the child starts. It seeds the child with the child-side path.
  Two arguments with the same file name in one call are kept apart with a `-1`, `-2` suffix.
- **File returns are copied back on the runtime's authority.** When a child settles with a
  `file` return, the runtime copies the file from the child's session into the **caller's**
  `scratchpad/attachments/` and hands the caller the caller-side path.
  - If that name is already taken, by an earlier call or by a concurrent sibling settling at the
    same moment, the copy gets `-1`, `-2`, … before the extension (`report.pdf` →
    `report-1.pdf`). A returned file never overwrites another file in the caller's workspace.
  - A file that is missing or can't be copied fails the call closed (`invalid-return`).
- **A child never writes into its caller's file space.** This is now stated as a requirement, not
  just a property of how session ids are derived. A child's workspace is its own session zone,
  and only these things reach the caller:
  - the closing message;
  - the declared returns;
  - copies of its `file` returns, made by the runtime.

  There is no implicit file channel.
- **Hosts and the CLI can hand a session a file.**
  - `TurnInput.files` maps a variable name to `{ name, content }`. The runtime writes the bytes
    into the session's `scratchpad/attachments/` (same suffix rule) before the turn boundary and
    seeds the variable with the path, so a host doesn't need to know the store's layout.
  - `archmax run` gains a repeatable `--file <variable>=<local path>` built on
    it, so a workflow with a `file` input still runs standalone.
- **The documentation stops contradicting itself.** The sub-workflows guide, the triggers guide,
  the authoring skill and the dispatcher's own header comment are corrected to say the child is a
  separate session with its own file space, and that only declared returns (with `file` returns
  copied) come back.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `workflow-spec`: adds `file` to the signature types, extends the conformance rule and the JSON
  Schema mapping for it, and adds the existence and readability check where a `file` value
  crosses the session boundary, the write check and the completion check.
- `delegation`: a child session's file space is isolated from its caller's. `file` arguments are
  copied into the child, `file` returns are copied back under a collision-free name, and a failed
  call's recorded arguments name the caller's paths.
- `workspace-and-sessions`: `scratchpad/attachments/` is where the runtime places files it hands
  a session (host files, copied arguments, copied returns), with one collision rule. A host can
  pass files on a turn through `TurnInput.files`.
- `cli`: `archmax run` accepts a repeatable `--file <variable>=<path>`.

## Impact

- **Code:**
  - `src/machine/signature.ts`: `SIGNATURE_TYPES`, `conforms`, `signatureJsonSchema`, the type
    phrase.
  - `src/machine/spec-schema.ts`: picks up the enum.
  - `src/workflow/signature-checks.ts` and the middleware's turn boundary: the existence checks.
  - `src/workflow/control-tools.ts`: the `archmax_set_variables` write check.
  - `src/workflow/sub-workflow.ts`: copying arguments in and returns back, including on resume and
    for mocks.
  - `src/core/file-operations.ts`: factor a byte transfer between two session bindings.
  - A new attachments helper for the suffix rule and per-session name reservation.
  - `src/agent.ts` / `src/sessions/resume.ts`: `TurnInput.files`.
  - `src/cli.ts` and `src/cli/`: the `--file` flag.
- **Public API:**
  - `SignatureType` gains `file`.
  - `TurnInput.files` is new.
  - `@archmax-ai/harness/spec` exports the same functions with the wider type. That subpath is
    what pangea re-exports, so the editor's type dropdown picks `file` up automatically.
  - `docs/.../reference/public-api.md` updates.
- **Docs:**
  - `guides/sub-workflows.md`: rewrite "What crosses, and what does not" and add a "Passing files"
    section.
  - `guides/triggers.md`: the signature types, and the "session derives from the caller's"
    wording.
  - `guides/sessions.md`: `scratchpad/attachments/`.
  - `reference/machine-spec.md`: the types table.
  - `reference/cli.md` and `guides/cli.md`: `--file`.
  - `reference/public-api.md`.
  - `reference/glossary.md`: no new term needed.
  - `reference/changelog.md`: this change ships together with the other in-flight changes
    (`platform-prompt-reset-and-title`, `pin-prompt-clock`) as one minor release, so their
    `0.4.3` section becomes `0.5.0` and this change adds to it.
- **README.md:** add one line on `file` inputs and returns, and the `--file` flag where `run` is
  shown.
- **Authoring skill (`skills/archmax-harness/`):**
  - `references/workflow-schema.md`: the signature types, and replace the stale "shared session"
    and "share one run zone" bullets and the "a sub-run shares its parent's session" sentence.
  - `references/hook-and-test-scripts.md`: drop "they share one run zone".
  - `references/backend-integration.md`: replace the stale paragraph saying a child "runs on the
    parent's session id … under a nested checkpoint namespace"; document `TurnInput.files`.
  - `SKILL.md`: if it lists the types.
- **Hosts:** pangea needs a file control in its start form for `format: "file"`, an upload that
  goes through `TurnInput.files` (or writes to `scratchpad/attachments/` itself), and an
  i18n label for the type. That's tracked in pangea, not here.
- **Not in scope:**
  - binary `from:` fixtures in cases (case fixtures are still read as text);
  - a size cap on copied files;
  - files inside `object`/`array` values.

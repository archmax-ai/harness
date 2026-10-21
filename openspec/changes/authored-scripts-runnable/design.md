## Context

See proposal.md for the motivation. Today one safety rule, `scriptSkillOnlyRule` in
`src/kernel/kernel.ts`, refuses every `execute` path outside a bundle of the resolved skill registry
(`script.skill-only`). It sits in `SAFETY_RULES`, after the path-argument and authoring-plane rules
and ahead of every denial, consumer rule and grant. The agent's script executor
(`src/sandbox/executor.ts`, created in `src/assembly/compose.ts`) reads every source through the
agent workspace; the hook executor reads through the authoring backend. `archmax validate` reports an
`archmax_run` entry whose patterns reach no bundle as inert, and reports any entry naming
`workflows/` as a misread of the authoring plane.

Two facts shape the change:

- The agent workspace has **no route** to `workflows/`. A path there falls through to the session
  zone, where the default tools let the agent write. So a `workflows/` path read through the agent
  workspace is a session file, and executing it would run the agent's own code.
- Every hook script lives under its workflow's `hooks/`: the schema and `resolveHookScript` refuse a
  hook anywhere else, at load, in `validate` and at runtime.

## Goals / Non-Goals

**Goals:**

- `archmax_run` executes any authored script: a skill bundle's, or a workflow's own file on the
  authoring backend.
- The agent never runs a hook (its own workflow's or another's), never runs a file it could have
  written (the session's files, a mount), and never executes a workflow's spec or cases.
- One classification, shared by the kernel and `archmax validate`, so they cannot disagree.
- The rule stays non-overridable, and a state's entry still narrows it.

**Non-Goals:**

- Letting the agent read, list or search the authoring backend. Executing a source is not
  addressing it.
- A host-declared "authored" flag on mounts.
- Changing which skill scripts run, or the skill rule (`skill.not-allowed`).
- Telling the agent in the platform prompt where workflow scripts are. The author names a script in
  the state's instructions, as with a skill script.

## Decisions

### D1. "Authored" is the skill registry plus the authoring prefix, nothing else

An authored script is a file in a bundle of the resolved skill registry, or a file under an authoring
prefix (`workflows/`) that is not a hook or governance file (D2, D3). Everything else is refused.

*Alternatives considered:*

- **Every read-only mount.** Rejected: a host's data plane and remote folders are read-only mounts
  too (the platform mounts its data folders and SharePoint mounts that way). The harness cannot tell
  an authored mount from a data mount, and the owner's rule keeps mounts unrunnable.
- **Everything the authoring backend serves.** Rejected: with the default filesystem wiring the
  authoring backend is the whole workspace root, `sessions/` and `.env` included, so an agent could
  run a file it wrote into `scratchpad/` by its store path, and a `.env` executed as JavaScript hands
  pieces of it back in its `ReferenceError`.
- **A new `authored: true` mount flag.** Deferred: it adds host API nobody asked for. The two homes
  cover every authored script the harness itself knows about.

So `AGENTS.md`, `.platform/` and a consumer's own authored mount stay unrunnable. That is the same as
today and is named in the docs.

### D2. Every hook, through the hooks location

A path under **any** workflow's `hooks/` is a hook (`workflowFileKind` → `hook`). Because a hook
cannot live anywhere else, this is every script any `before`/`after` hook can reference, without the
kernel knowing which workflow it governs (the machine does not carry its slug) and without resolving
declarations. A sibling workflow's hooks are refused the same way, so an agent cannot run the guard
of a workflow it delegates to.

A custom `hookExecutors` kind's value is host-defined and opaque to the runtime. Its referent, if it
names a file, is the host's to place; the docs recommend keeping such files under `hooks/` too.

### D3. A workflow's spec, prose addendum and cases are not runnable

The owner's rule says "any file of the authored tree". Applied literally, `archmax_run` would execute
`workflow.yaml` and the cases. They are not scripts, and executing them is a side channel onto exactly
what the authoring backend seals: QuickJS reports `ReferenceError: <word> is not defined` for a YAML
line like `instructions: TopSecretCriterion`, which a quick experiment against the executor confirmed.
So `workflow.yaml`, `WORKFLOW.md` and everything under `tests/` (cases and their `from:` fixtures)
classify as `governance` and are refused before they are read. This is called out in the PR for
review. Any other file under `workflows/<slug>/`, including a `.yaml` beside the scripts, is authored.

### D4. Spellings a filesystem resolves to a hook are hooks

The kernel canonicalizes `.`, `..` and `//` already. `workflowFileKind` additionally compares
segments case-insensitively and ignores trailing dots and spaces: a case-insensitive filesystem
(macOS by default) serves `HOOKS/gate.js` from `hooks/gate.js`, and Windows serves `hooks./gate.js`
the same way. A segment named that way on a case-sensitive store is refused too, which is the safe
error. A path holding a `\` is refused outright, before it is classified, in either home: some
backends read `\` as a separator and others as a filename character, so no single classification
matches every backend (`workflows/p/x\..\hooks\gate.js` would be a hook on one and an authored
file on another). This also refuses a skill-bundle path holding a `\`, which used to pass; no
legitimate script path needs one. The authoring prefix itself is matched exactly, as everywhere
else, so `Workflows/x.js` is not authored and is refused.

### D5. The executor reads a workflow's script from the authoring backend

`createScriptExecutor` takes an optional `authoring` workspace. A path whose canonical form is under
an authoring prefix is read from it, using that canonical form, so `skills/../workflows/w/x.js` is
read where the kernel's verdict assumed. Every other path is read from the agent workspace as before.
`compose.ts` passes the authoring backend to both executors. The hook executor's reads do not change,
and its missing-file error now names the authoring backend.

The consequence is structural: a file the agent writes at `workflows/w/scripts/own.js` lands in its
session and is never what `archmax_run` executes. The behaviour suite asserts it.

### D6. Only `archmax_run` treats `workflows/` as authored

`unrunnableScript(tool, path, skills)` returns `not-authored` for a `workflows/` path when the tool is
not `archmax_run`. A host tool declaring an `execute` path receives the path and resolves it itself,
through its `ToolContext.workspace`, which is the agent workspace, so for it that path is a session
file. Its execute paths stay confined to skill bundles, exactly as before.

### D7. The rule is renamed `script.authored-only`

The id says what the rule does now. Rule ids are not public contract: `decide` is not exported, the
`tool-blocked` event carries the reason and not the id, and `GovernanceRule` exposes ids only for a
consumer's own verdicts. The id is visible in `archmax validate` messages and in the docs. The
changelog names the rename. It is listed for the maintainer's review in the PR.

### D8. The validator classifies patterns with the kernel's function

`inertRunPattern` classifies a plain path exactly as a call naming it (`unrunnableScript`). A glob is
classified by its literal directory: when that directory is an authored root (a bundle prefix,
`workflows`) or an ancestor of one, including the root itself (`**`), the pattern can reach an
authored script and is never reported; otherwise a file directly in the directory stands for every
match (`workflows/p/hooks/**` → hook, `scratchpad/**` → not authored). This only reports a pattern
that certainly names nothing runnable; a mixed glob is left to the kernel, call by call. The check now
runs on `tools.allow_always` entries too, whose guards are enforced since 0.8.0. The "names the
authoring plane" check skips `archmax_run`, whose `workflows/` paths now mean what they read as.

### D9. 0.9.0, a minor release

The change widens a safety rule and breaks nothing that worked: every script that ran still runs, and
every refusal that still applies is still a refusal. Per `CONTRIBUTING.md`, `package.json` is not
bumped; the changelog opens a `0.9.0` section and the PR is labelled `release:minor` when the
maintainer decides to cut it.

## Risks / Trade-offs

- **[A wider rule runs more]** A state granted bare `archmax_run` (the default tools) can now run every
  workflow's authored scripts, not only the enabled bundles'. → Each was written by the workspace's
  author to be run, and a state entry narrows the set (`paths: ["workflows/<slug>/scripts/**"]`). The
  docs recommend narrowing in states that should run less.
- **[No skill gates a workflow script]** A state that enables no skill could run no script before; it
  can now run workflow scripts. → Documented. Narrow with a state entry, or leave `archmax_run` out of
  the state's grant.
- **[Existence probe]** The agent can learn whether a non-hook, non-governance file exists under
  `workflows/` from the error. → Hooks, specs and cases are refused before any read, so their presence
  is not observable; the rest is authored content meant to be run.
- **[Host spellings]** A backend could resolve some other alias of a hook path (a symlink in a
  filesystem workspace, a Windows 8.3 short name, a store with its own path rules). → Out of scope:
  the author controls both. Canonical, case-insensitive and trailing-dot spellings are covered, a
  `\` is refused, and deepagents' `FilesystemBackend` refuses every `..` in virtual mode.

## Migration Plan

Nothing to migrate. A workspace may move a skill bundle's single-workflow scripts to
`workflows/<slug>/scripts/` and drop the bundle. Rollback is reverting the change; no stored data
depends on it.

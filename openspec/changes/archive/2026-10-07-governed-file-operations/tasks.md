## 1. Raw transfer and deletion through the workspace (request 2)

- [x] 1.1 `mountSubtree` (`src/core/path-mapping.ts`) maps `downloadFiles`, `uploadFiles` and `delete` in and out; a read-only mount refuses uploads (`permission_denied`) and deletes (error naming the path as written) without delegating; a wrapped backend without transfer throws, without deletion answers an error. Verify with `npx vitest run src/core/path-mapping.test.ts`.
- [x] 1.2 `SessionZoneRouter` delegates the three; `createWorkspaceRouter` routes them (canonical paths, exact file mounts, else the composite). Verify with `src/core/workspace-router.test.ts`: transfer through a directory mount, a file mount and the session zone; upload and delete refused under read-only mounts; no session id in result paths.

## 2. The path table (request 1)

- [x] 2.1 Add `src/machine/tool-paths.ts`: `PathAccess`, `ToolPaths`, `BUILT_IN_TOOL_PATHS`, the built-in aliases, `MUTATING_ACCESSES`/`SCRATCHPAD_ACCESSES`/`OFFLOAD_ACCESSES`, `resolveToolPaths` with `ToolPathsError`, `declaredPathsOf`, `pathArgsOf`, `pathValuesOf`. Verify with `npm run typecheck`.
- [x] 2.2 `src/machine/allow.ts`: mark `paths:` entries `fromPaths`; `pathGuardMatches` (every for grants, any for denials); `src/machine/machine.ts` carries the table (`fromSpec(spec, essential, toolPaths)`), and `checkAllowed`, `renderEntry` and `describeArgConstraints` read `paths:` through it. Verify with `npx vitest run src/machine`.
- [x] 2.3 `src/kernel/kernel.ts`: replace the four name sets and `pathArg()` with declared paths in every path rule; name the argument for multi-path tools; forbid `paths:` match any declared path; keep single-path messages identical. Verify that the existing kernel, validate and PTC tests pass unchanged, plus `src/kernel/kernel.paths.test.ts` (host tool refused `mount.not-allowed`, `mount.read-only`, `skill.not-allowed`; the file operations' zones; `{ tool: "*", paths }` both sides; aliases; `resolveToolPaths` refusals).
- [x] 2.4 `validate` checks every declared `write`/`remove` argument of an allow entry; the spec lint's scratchpad warning covers every mutating built-in. Verify with `npx vitest run src/validate src/machine/lint-spec.test.ts`.

## 3. The file operations (request 3)

- [x] 3.1 Add `COPY_FILE_TOOL`, `MOVE_FILE_TOOL`, `REMOVE_FILE_TOOL` and `RUNTIME_FILE_TOOLS` to `src/machine/tool-names.ts` and `ESSENTIAL_TOOLS`; refuse a host tool shadowing one (`ReservedToolNameError`, `reservation: "file-operation"`). Verify with the assembly behaviour test (3.3).
- [x] 3.2 `src/core/file-operations.ts`: copy, move and remove per the design (gate, exact bytes, write or claim-and-upload, verify; overwrite rule; same-file; read-only move source; sanitized messages) and `createFileOperationTools`. Verify with `npx vitest run src/core/file-operations.test.ts` (text, PNG, `.docx`, BOM, Latin-1, folders, overwrite, missing, directory, symlink, same file, read-only destination, memory store, backend without transfer; move and remove cases).
- [x] 3.3 Register the tools in the governed and plain compositions; CLI hint names `destination`. Verify with `src/behaviour/file-operations.test.ts`: copies without reading; copy into and move out of a read-only mount refused with nothing written; overwrite; copy out of a governed mount not given refused; disclosed in every state and closed by `forbid: [copy_file]`; `tools.copyFile` from a script; a plain agent.

- [x] 3.4 Read every write back (`downloadFiles`, else `readRaw`); fall back to `uploadFiles` when the text channel did not keep the bytes; refuse and remove a created destination otherwise; state the base64 contract in `reference/public-api.md` and the skill (platform review C3). Verify with `npx vitest run src/core/file-operations.test.ts` ("a copy is verified on every backend").

## 4. Host tools on the workspace (request 2)

- [x] 4.1 `src/core/tool-context.ts` (`ToolContext`, `runWithToolContext`, `currentToolContext`), bound in `sessionBinder`; `toolsFromMap` passes it as the handler's second argument (lazy outside a turn) and carries a descriptor's `paths` in tool metadata. Verify with `npx vitest run src/workflow/agent-tools.test.ts`.
- [x] 4.2 `createAgent` option `toolPaths`, merged over descriptor declarations and resolved once onto `AssemblyContext.toolPaths` for the root and every child machine. Verify with the behaviour cases: a host tool reads skills, `AGENTS.md`, a memory-backed `tmp/` mount and `scratchpad/` through its context; is refused a governed mount without running; uploads, downloads and deletes through the context with the read-only mount refusing; is governed by `toolPaths` alone; a built-in declaration throws `ToolPathsError`.
- [x] 4.3 Export `ToolPathsError` and the types `AgentToolDescriptor`, `ToolContext`, `ToolPaths`, `PathAccess` from the root, and the tool names and `BUILT_IN_TOOL_PATHS`/`PATH_ACCESSES` from the spec subpath; list them in `reference/public-api.md`. Verify with `npx vitest run src/index.test.ts src/public`.

## 5. Docs and authoring skill

- [x] 5.1 `docs/`: `guides/workflow-machine.md` (always-on list, "File operations and path arguments"), `reference/machine-spec.md` (always-on list, declared paths, `paths:` grant/deny semantics), `reference/public-api.md` (host tools section, store needs, reserved names), `guides/code-interpreter.md`, `guides/token-efficiency.md` (measured schemas), `reference/changelog.md`. Verify with `npm run docs:build`.
- [x] 5.2 `skills/archmax-harness/references/`: `workflow-yaml.md`, `workflow-schema.md`, `hook-and-test-scripts.md`, `backend-integration.md` (options, exports, host tools, custom backends). Verify with a grep over `skills/` for the always-on lists.
- [x] 5.3 README.md: no change (it names neither the file tools nor host-tool wiring). Verify with a grep for `edit_file`, `toolsFromMap` and `essentialTools`.

## 6. Verify

- [x] 6.1 Run `npm run typecheck`, `npm test` and `npx openspec validate governed-file-operations --strict`. All pass.
- [x] 6.2 Run the reference workspace against a live model and have the agent use the three tools.
  - Run on 7 October 2026: `npm run dev -- run order-lookup "<write scratchpad/a.txt, copy it to b.txt twice, move b.txt to c.txt, remove a.txt>" --root examples/customer-support --session live-fileops-3`, model `anthropic/claude-sonnet-5`.
  - Results, verbatim: `Copied 'scratchpad/a.txt' to 'scratchpad/b.txt' (5 B).`; the second copy `Error: Cannot copy to 'scratchpad/b.txt': a file is already there. Pass overwrite: true to replace it, or choose another destination.`; `Moved 'scratchpad/b.txt' to 'scratchpad/c.txt' (5 B).`; `Removed 'scratchpad/a.txt'.` On disk only `c.txt` ("hello") and `answer.json` remained.
- [x] 6.3 Open a PR with the `release:minor` label (`0.4.0`). Opened as [#32](https://github.com/archmax-ai/harness/pull/32).

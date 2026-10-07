## 1. Binary classification

- [x] 1.1 Create `src/core/binary-read.ts`: Deep Agents' non-text MIME table (images except SVG, audio, video, `.pdf`, `.ppt`, `.pptx`) with `mimeTypeOf(path)` (default `text/plain`) and `isTextMimeType(mime)` copied from `deepagents` `backends/utils.ts`; `binaryReadError(path, result)` returning the notice string (or `null` for a text result) per the design's classification (route `mimeType` first, then the extension; non-string content; `\u0000` in a string) and notice format (workspace-form path, MIME or `application/octet-stream`, byte size when bytes, e.g. `24.1 KB`). Verify with 1.2.
- [x] 1.2 Add `src/core/binary-read.test.ts`: every extension in the local table agrees with the `mimeType` Deep Agents' `FilesystemBackend.read()` reports for a file with that extension, and `.svg`, `.json`, `.md`, `.ts`, `.properties` and no extension read as text there and here; NUL content, `Uint8Array` content and a numeric-key object are binary; a Latin-1 string with U+FFFD is text; the notice names path, MIME and size. Verify with `npx vitest run src/core/binary-read.test.ts`.

## 2. Workspace router

- [x] 2.1 In `createWorkspaceRouter` (`src/core/workspace-router.ts`), make `read()` await the routed result (file mount or composite), return a route `error` unchanged, and return `{ error: binaryReadError(...) }` for a binary result; extend the module header's list of what the router owns. Verify with 2.2.
- [x] 2.2 In `src/core/workspace-router.test.ts`, add cases: a PNG and a NUL-bearing `.zip` on a `FilesystemBackend` mount are refused with the notice; a file mount serving bytes is refused; a custom backend answering `{ content: Uint8Array, mimeType: "image/png" }` is refused with its byte size; a missing `.png` returns the route's not-found error; JSON and SVG read as before; `readRaw` of the PNG still returns its bytes. Verify with `npx vitest run src/core/workspace-router.test.ts`.

## 3. The read_file description

- [x] 3.1 Add `readFileContractMiddleware(emit)` in `src/assembly/compose.ts` (beside `todoMiddleware`): `wrapModelCall` rewrites the registered `read_file`'s description in place, once per instance (LangChain rejects a swapped instance), replacing the two upstream binary lines with the text-only line; when the lines are not found, leave it and emit one `warning` (scope `workflow`) per assembly. Unit-test it in `src/assembly/compose.test.ts` (rewritten once, same instance handed, other tools untouched, warns once). Verify with `npx vitest run src/assembly/compose.test.ts`.
- [x] 3.2 Install it in the governed composition after `instrumentation.middleware` and before the provider cache and the host's middleware (`src/assembly/compose.ts`), and in the plain composition after `todoMiddleware()` (`src/assembly/plain.ts`). Verify with 4.3.

## 4. Behaviour

- [x] 4.1 Add a behaviour test (`src/behaviour/governance-run.test.ts` or a new `src/behaviour/binary-read.test.ts`): a scripted model calls `read_file` on a seeded `scratchpad/chart.png` and on `scratchpad/export.zip` (NUL bytes). Each tool message is the single text notice, no message in the session's history carries an `image`/`file` block or base64, and the `tool-result` event's output is the notice. Verify that the file passes.
- [x] 4.2 Add a sandbox case (`src/behaviour/sandbox-run.test.ts`): an `archmax_eval` script's `await tools.readFile({ file_path: "scratchpad/chart.png" })` resolves to the notice string. Verify that the file passes.
- [x] 4.3 Assert the description in both compositions: the scripted model's recorded `read_file` definition says binary files are reported as binary and does not contain `multimodal content blocks`, for a governed agent and a plain one (`src/behaviour/plain.test.ts`). Verify that both files pass.

## 5. Docs and authoring skill

- [x] 5.1 `docs/src/content/docs/guides/workflow-machine.md`, the workspace part of "Mount governance" (where session areas and authored mounts are described): say reads are text only — a binary file (by type or by NUL content) returns `Error: '<path>' is a binary file (…) and was not read; …` instead of its content, for the agent and for scripts, and that it is not a governance refusal. Verify with `npm run docs:build`.
- [x] 5.2 `docs/src/content/docs/guides/code-interpreter.md`: next to the `tools` bridge description, say `tools.readFile` resolves to file text, and to the binary notice for a binary file. Verify with `npm run docs:build`.
- [x] 5.3 `docs/src/content/docs/reference/changelog.md`: add a `0.3.2 (unreleased)` section saying `read_file` and `tools.readFile` return a binary notice instead of base64 (images, audio, video, PDF/PPT) or decoded garbage (unknown-extension binaries), that the `read_file` description says so, and, **for hosts**, that a multimodal model no longer receives images through `read_file`. Link the sessions guide. Verify that it renders in `npm run docs:build`.
- [x] 5.4 `skills/archmax-harness/references/hook-and-test-scripts.md`: the `tools` row ("→ file text") and the governance section say a binary file resolves to the notice, so a script checks before `JSON.parse`. Verify with a grep over `skills/` for `readFile`.
- [x] 5.5 Confirm README.md needs no change. Verify with a grep for `read_file`, `readFile`, `binary` and `image`.

## 6. Verify

- [x] 6.1 Run `npm run typecheck`, `npm test` and `npx openspec validate read-file-text-only --strict`. All pass.
- [x] 6.2 Run the reference workspace against a live model with a PNG copied into a mount or `scratchpad/` and a prompt asking the agent to read it (`npm run dev -- run order-lookup "<prompt>" --root examples/customer-support --verbose`). Confirm the `read_file` result is the notice, the verbose `tool-result` line carries no base64, and the agent continues.

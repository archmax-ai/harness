## Why

`read_file` on a binary file hands the model base64. Deep Agents' `read_file` (1.13.4, unchanged in
1.14.2) gets raw bytes from the backend for any file whose extension maps to a non-text MIME type —
images, audio, video, PDF, PPT/PPTX — and returns them base64-encoded in a multimodal content block
(`image`, `audio`, `video` or `file`) of up to 10 MB. The runtime's built-in model is
`ChatOpenAICompletions`, which puts that block into a `role: "tool"` message as a data URL; the
OpenAI SDK types tool-message content as text only, so an endpoint either refuses the request or
flattens the block into base64 text. The same bytes reach a script's `tools.readFile` as a JSON
string full of base64, every `tool-result` event preview, and every checkpoint the session writes,
since the block lives in the message history.

A binary file with an extension Deep Agents does not know (`.zip`, `.docx`, `.xlsx`, `.sqlite`,
`.bin`, no extension) takes the other branch: the extension maps to `text/plain`, the filesystem
backend decodes the bytes as UTF-8, and `read_file` returns line-numbered garbage.

Deep Agents 1.14.2 adds `UnsupportedContentMiddleware`, which swaps a block the model cannot accept
for a placeholder at request time. It is not a substitute: it is not in 1.13.4; it decides from the
model's LangChain profile, which for the OpenAI models claims image and PDF support in tool messages
and for any other model name is empty and defaults to supported; and it rewrites only the request,
so state, checkpoints, scripts and events still carry the bytes.

## What Changes

- A read the workspace router serves is **text only**. The router refuses a read as binary when
  Deep Agents' MIME type for the path is not text (the exact set its `read_file` would base64), when
  the backend hands back raw bytes, or when the returned text contains a NUL byte (an
  unknown-extension binary). The refusal is the backend protocol's own `{ error }`, which
  `read_file` renders as `Error: …`:
  `'scratchpad/chart.png' is a binary file (image/png, 24.1 KB) and was not read; read_file returns text files only.`
  A route's own error (not found, a directory, a symlink) passes through unchanged.
- The refusal holds for every caller of `read`: the model's `read_file`, a sandbox or hook script's
  `tools.readFile` (which now gets the notice as its string result), and therefore every
  `tool-result` preview. `readRaw` — the runtime's own reads of specs, hook sources and skills — is
  unaffected.
- The `read_file` description the model is handed no longer promises multimodal content blocks: a
  runtime middleware, installed in both the governed and the plain composition, replaces Deep
  Agents' two binary-file lines with the text-only contract. When the upstream lines are not found
  the description is left unchanged and one `warning` event says so.
- **Behaviour change for hosts:** a host whose model read images, audio or PDFs through `read_file`
  (a multimodal model behind a custom `model`) now gets the binary notice instead. There is no
  opt-out in this change. The public API and the event types are unchanged.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `workspace-and-sessions`: a new requirement, "Reads are text only": the workspace router refuses
  a binary read with the notice, for every caller, and the model's `read_file` description states
  the contract.

## Impact

- **Code:**
  - `src/core/binary-read.ts` (new): the binary classification (a local copy of Deep Agents'
    unexported `getMimeType`/`isTextMimeType`, plus the bytes and NUL checks) and the notice.
  - `src/core/workspace-router.ts`: `read()` applies it to the routed result.
  - `src/assembly/compose.ts`, `src/assembly/plain.ts`: install the `read_file` description
    middleware in both compositions.
- **Tests:**
  - `src/core/binary-read.test.ts`: the classification pinned against Deep Agents'
    `FilesystemBackend` for every extension in its table, NUL detection, and the notice.
  - `src/core/workspace-router.test.ts`: binary refused, text and a route's error passed through.
  - A behaviour test: the model's `read_file` on a PNG and on an unknown-extension binary gets the
    notice and no multimodal block; a script's `tools.readFile` gets the same string; the
    description the model is handed carries the text-only line.
- **docs/:**
  - `guides/workflow-machine.md`: the workspace part of "Mount governance" says reads are text
    only and what a binary read returns.
  - `guides/code-interpreter.md`: what `tools.readFile` returns for a binary file.
  - `reference/changelog.md`: an entry for the release.
- **README.md:** no update. It does not describe `read_file` or the workspace's read behaviour.
- **skills/archmax-harness/:** `references/hook-and-test-scripts.md`, the `tools` row and the
  governance section: `tools.readFile` returns text, and a binary file's notice instead of content.
- **Release:** a patch (`release` label).

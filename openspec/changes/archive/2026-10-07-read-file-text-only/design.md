## Context

See proposal.md for why the change is needed. This section describes how the pieces fit today,
as read in Deep Agents' TypeScript source (1.13.4 installed, 1.14.2 latest).

- **How `read_file` decides.** `createReadFileTool` (`middleware/fs.ts`) calls
  `backend.read(path, offset, limit)`. A result with `error` becomes the text `Error: <error>`.
  Otherwise it takes `mime = result.mimeType ?? getMimeType(path)`; when `!isTextMimeType(mime)`
  it base64-encodes the content into an `image`/`audio`/`video`/`file` block, else it renders the
  text with line numbers. `getMimeType` maps an extension through a fixed table (images, audio,
  video, `.pdf`, `.ppt`, `.pptx`, and text types) and defaults to `text/plain`; `isTextMimeType`
  accepts `text/*`, JSON, JavaScript and SVG. Neither helper is exported.
- **What the backends return.** `FilesystemBackend`, `StateBackend` and `StoreBackend` all report
  `mimeType` on a read. For a non-text MIME type they return the whole file as a `Uint8Array`
  (pagination ignored); for a text one, the requested page as a string. `FilesystemBackend`
  decodes an unknown-extension file as UTF-8, so NUL bytes survive as `\u0000` and invalid
  sequences become U+FFFD. Deep Agents' `grep` already skips non-text MIME types, and defers to
  ripgrep (which skips files containing NUL) when `rg` is installed.
- **One entry point.** Every agent tool, script `tools.*` call and runtime read reaches the
  workspace through `createWorkspaceRouter` (`src/core/workspace-router.ts`), which canonicalizes
  the path and dispatches `read` to a file mount or the mount-routing composite. `readRaw`, which
  the runtime uses for specs, hook sources and skills, is a separate method.
- **Where the description comes from.** `read_file` is built inside Deep Agents'
  `FilesystemMiddleware`; its description is `READ_FILE_TOOL_DESCRIPTION` (identical in 1.14.2),
  which ends with two lines promising multimodal content blocks for images, audio, video and PDFs.
  `createDeepAgent` does not expose `customToolDescriptions`, and a harness profile's
  `toolDescriptionOverrides` only rewrites tools passed in `tools`.
- **Middleware order.** Governed: park, todo, script interpreter, workflow instrumentation
  (governance's `wrapModelCall` filters `request.tools` to the state's surface), provider cache,
  then the host's. Plain: todo, then the host's. The interpreter captures `request.tools` for a
  script's `tools.*` in its own `wrapModelCall`.

## Goals / Non-Goals

**Goals:**

- No path from a workspace read to the model, a script, an event or a checkpoint carries a binary
  file's bytes, in any encoding.
- The model is told the contract by the tool it calls, not only by a refusal after the fact.
- Classification follows Deep Agents' own, so a file `read_file` would treat as text still reads.

**Non-Goals:**

- **A multimodal opt-in.** A host with a vision model that wants images back is a later change; it
  would skip the refusal and lean on Deep Agents' `UnsupportedContentMiddleware` and
  `offloadBinaryContent` (1.14+).
- **The rubric graders' `read_file` description.** Graders are subagents Deep Agents builds
  internally; their tool description is not reachable from a model-call middleware of the parent.
  Their reads still get the refusal, since they share the workspace backend.
- **Writing binary files** and **`grep`/`glob`**: unchanged. `write_file` takes a string; search
  already skips binary files upstream.
- **Content sniffing beyond NUL** (magic numbers, encoding detection).

## Decisions

### Refuse in the workspace router's `read`, after routing

The router calls the route as today, then classifies the result. A route `error` passes through,
so a missing `.png` still reads as not found.

- **Why here:** it is the one point every `read` caller reaches — the model's `read_file`, a
  script's `tools.readFile`, a sub-workflow child, a grader — for every route, including a
  consumer's custom backend. The refusal happens before `read_file` builds a block, so the bytes
  never enter a message, a checkpoint or an event. The backend protocol's `{ error }` is the
  channel Deep Agents itself uses to refuse a read.
- **Alternative: rewrite the tool result in `wrapToolCall`.** Rejected: it runs only for governed
  agent calls, so the PTC gateway and the plain composition would each need the same rewrite, and
  it works on a block already built from the bytes.
- **Alternative: rely on Deep Agents' `UnsupportedContentMiddleware`.** Rejected: absent in 1.13.4,
  gated by a model profile that defaults to "supported", and request-only (state keeps the bytes).
- **Alternative: replace `read_file`.** Rejected: forks upstream behaviour (pagination, line
  numbering, eviction) to change one branch.

### Classify by Deep Agents' predicate, then by content

Binary when `!isTextMimeType(result.mimeType ?? getMimeType(path))`, or the content is not a
string (bytes, or the numeric-key object a `Uint8Array` becomes after serialization), or the
string contains `\u0000`.

- The first test is `read_file`'s own, on the same inputs, so the refused set is exactly the set it
  would base64. The route-reported `mimeType` is primary; the local `getMimeType` is a fallback for
  a custom backend that reports none.
- The two helpers are copied into `src/core/binary-read.ts` (only the non-text table entries are
  needed: anything else is `text/plain`). A test pins the copy against `FilesystemBackend.read()`'s
  reported `mimeType` for every extension in the copy plus a set of text extensions, so upstream
  drift fails the suite.
- **NUL as the content test** (git's and ripgrep's rule). Alternatives: strict UTF-8 decoding
  (`ContextHubBackend`'s rule) refuses Latin-1 text and cannot run exactly on content the backend
  already decoded with replacement; magic-number sniffing needs the raw bytes and a dependency;
  a control-character ratio is a fuzzy threshold.
- The NUL test sees only the page `read` returned. Binary formats carry NUL in their header, so
  the first page — what an agent reads first — catches them.

### The notice

`'<path>' is a binary file (<mime>, <size>) and was not read; read_file returns text files only.`

- `<path>` in workspace form (no leading slash), as the read-only mount error names paths.
- `<mime>` is the classified MIME type, or `application/octet-stream` when only the content
  showed the file is binary.
- `<size>` is the byte length when the route returned bytes (`24.1 KB`, `3.2 MB`), omitted
  otherwise.
- It is an ordinary tool result, not `status: "error"` and not a kernel verdict: no `tool-blocked`
  event, no `on_error` route. The agent reads it and carries on.

### Rewrite the description in a dedicated middleware, in both compositions

`readFileContractMiddleware` (assembly), on the first model call that offers `read_file`, rewrites
that tool's description in place: the two upstream binary lines become one text-only line.

- **In place, not a copy:** LangChain's agent node rejects a `wrapModelCall` that hands the model
  a different instance under a registered tool's name ("You have modified a tool … This is not
  supported"), because the tool node executes tools by identity. The registered instance is this
  agent's own — Deep Agents' `createFilesystemMiddleware` builds new tools per agent, and the
  description is an own writable property — so rewriting it once is local to the assembly. After
  the first call every call hands the provider the same, byte-identical definition, so the
  cached prefix holds.
- **Placement:** governed — after the workflow instrumentation and before the provider cache and
  the host's middleware, so the first call they see already carries the final definition; plain —
  after the todo middleware.
- **Match by line, warn once:** the two lines are matched by their leading text (`- Images (`
  … `multimodal content blocks`, `- For images and PDFs, pagination`). When the first is not
  found the description is left as it is and one `warning` event (scope `workflow`) is emitted per
  assembly, as upstream prompt pruning does.
- **Alternatives:** a per-call copy made with Deep Agents' override idiom (rejected by LangChain,
  as above); a harness profile `toolDescriptionOverrides` (does not reach middleware-built tools;
  the registry is process-global and keyed by model); the governance `wrapModelCall` (misses the
  plain agent); a platform-prompt sentence (the tool description would still contradict it).

## Risks / Trade-offs

- [A UTF-16 text file contains NUL and is refused] → Same as git. Deep Agents decodes as UTF-8 and
  would return it unreadable anyway; the notice is the more honest answer.
- [A page past the first of an unknown-extension binary has no NUL] → Only reachable by paging
  past a first page the agent did not read; that page already read as binary. Accepted.
- [Upstream adds a binary type] → Deep Agents' backends report `mimeType`, so the router follows
  upstream for them automatically; the pin test flags drift for the local fallback table.
- [Upstream rewords the description] → The `warning` event names it; the refusal still holds.
- [A host's vision model loses image reads] → Documented as a behaviour change; the opt-in is a
  non-goal here.
- [The bytes are still loaded before the refusal] → No regression: the backend loads them today
  and `read_file` additionally base64-encodes them. They are dropped at once.

## Migration Plan

A patch release. No data migration: a session's history already holding a base64 block keeps it,
and new reads return the notice. Rollback is reverting the change.

## MODIFIED Requirements

### Requirement: Search dispatch honours a mount's search posture

The workspace router SHALL dispatch `grep` and `glob` by where the search is addressed, after the usual canonicalization. A search whose path is the root, an ancestor of a mount, a session path, or a path inside a **searchable** mount SHALL be served by a composite over the searchable directory routes only — the same default route, the same longest-prefix routing and the same prefix re-application as every other operation — so an unsearchable mount contributes neither matches nor an error to it. A search whose path is an **unsearchable** mount or a path inside it SHALL be delegated directly to that mount's backend with the route-relative path (`/` for the mount itself), and the backend's result SHALL be returned verbatim: matches and files re-prefixed into workspace form, an `{ error }` untouched, so the backend's own refusal reaches the caller. The routing mount of a search path SHALL be determined by longest prefix across every directory mount, so a searchable mount nested inside an unsearchable one is still searched, and vice versa. `ls`, `read`, `readRaw`, `write` and `edit` SHALL be unaffected: a listing of the root still shows an unsearchable mount, and its files read as before.

A `grep`'s match cap — the fourth argument, `maxCount`, which Deep Agents' `grep` tool passes as the call's `max_count` or its default of 1,000 — SHALL reach the backend of every route a search is served by: the session zone, a directory mount, a `mountSubtree` mount and a read-only mount alike. The total SHALL be capped and marked `truncated: true` when the cap is hit: by the composite on a search it serves, and by the router on a search delegated to an unsearchable mount, so a backend that ignores the cap still answers within it.

With no unsearchable mount in the table, the search composite SHALL be the routing composite itself, so every existing table behaves byte-identically. The behaviour SHALL hold for every caller of the workspace backend — a model's tool call (the session's agent's or a grader's), a sandbox script's `tools.*` bridge (an agent's `archmax_eval`/`archmax_run` script or a code state's script), and the runtime's own discovery — since all of them reach the router.

The model-facing prompt SHALL disclose the posture wherever it names the mount: the "Mounts available in this state" section for a governed unsearchable mount, and the static "Workspace zones" section for an ungoverned one, SHALL mark it browse-only — list and read it, do not search it — and SHALL be unchanged for a table with no unsearchable mount.

#### Scenario: A root-wide grep survives a refusing mount

- **WHEN** the table is `{ "/skills/": skills, "/contracts/": { backend: contracts, governed: true, searchable: false } }`, the `contracts` backend answers every `grep` with `{ error }`, and the agent greps `x` at `/`
- **THEN** the result carries the matches from the session zone and `skills/`, no error, and the `contracts` backend's `grep` is never called

#### Scenario: A root-wide glob survives a refusing mount

- **WHEN** the same table's `contracts` backend answers every `glob` with `{ error }` and the agent globs `**/*.md` at `/`
- **THEN** the result lists the session zone's and `skills/` files and the `contracts` backend's `glob` is never called

#### Scenario: A code state's script searches like the agent

- **WHEN** over the same table a code state's script calls `tools.grep({ pattern: "x", path: "/" })`
- **THEN** it receives the matches from the session zone and `skills/`, no error, and the `contracts` backend's `grep` is never called

#### Scenario: A grep addressed at the mount reaches its backend

- **WHEN** the agent greps `x` at `/contracts/`
- **THEN** the `contracts` backend receives `grep("x", "/")` and its `{ error }` is returned to the agent verbatim

#### Scenario: A glob inside the mount reaches its backend

- **WHEN** the agent globs `**/*.md` at `/contracts/2026`
- **THEN** the `contracts` backend receives `glob("**/*.md", "/2026")` and its `{ error }` is returned to the agent verbatim

#### Scenario: An addressed search that succeeds comes back in workspace form

- **WHEN** the `contracts` backend answers `grep("x", "/2026")` with a match at `/2026/a.md`
- **THEN** the agent's grep at `contracts/2026` returns that match at `contracts/2026/a.md`

#### Scenario: A grep's cap reaches every route

- **WHEN** the agent greps with `max_count: 2` over five matching lines in the session zone, on a directory mount, on a `mountSubtree` mount, and on an unsearchable mount whose backend ignores the cap
- **THEN** each search returns the first two matches and Deep Agents' note that the search stopped at the cap

#### Scenario: A search under its cap is whole

- **WHEN** the agent greps with `max_count: 5` over five matching lines
- **THEN** all five matches are returned and no truncation note is added

#### Scenario: The mount still lists and reads

- **WHEN** the agent lists `/` or reads `contracts/2026/a.md`
- **THEN** `contracts/` appears in the root listing and the read is served by the `contracts` backend as before

#### Scenario: An ancestor path skips the mount

- **WHEN** the table mounts `/catalogs/eu/` as `{ backend, searchable: false }` and the agent greps `x` at `/catalogs`
- **THEN** the search is served without calling the `eu` backend

#### Scenario: Longest prefix decides the routing mount

- **WHEN** the table mounts `/data/` as `{ backend: a, searchable: false }` and `/data/public/` as `{ backend: b }`, and the agent greps `x` at `data/public/reports`
- **THEN** backend `b` serves the search with path `/reports`, and backend `a` is not called

#### Scenario: Tables without the flag are unchanged

- **WHEN** no mount in the table declares `searchable: false`
- **THEN** `grep` and `glob` at every path produce the same result they produce today, including an error a searchable mount returns on a root-wide search

#### Scenario: The prompt marks an unsearchable mount

- **WHEN** a state enables the governed mount `contracts` declared `searchable: false`
- **THEN** its line in "Mounts available in this state" says the mount is browse-only, and a table without the flag renders the section exactly as before

### Requirement: Reserved root names fail assembly when shadowed

The session areas (`scratchpad`, `large_tool_results`, `conversation_history`, `checkpoints`, `artifacts`, `_specs`) and the authoring prefix (`workflows`) SHALL be reserved at the workspace root. The authoring prefix SHALL hold what the runtime reads through the authoring backend alone: each workflow's `workflow.yaml` and `WORKFLOW.md`, its code-state scripts under `workflows/<slug>/scripts/`, and its cases under `workflows/<slug>/tests/`. The agent's workspace composite SHALL have no route to it, so no model's tool call and no sandbox script's `tools.*` call reaches a spec, a code-state script or a case. A declared mount whose key names one of the reserved names — or whose first segment does — SHALL throw `MountCollisionError` at assembly, naming the collision. A writable mount served by the same backend as the authoring backend SHALL throw `AuthoringBackendExposedError`. The resolved `MountPrefixes` (`dirs`, `files`, `writable`, `governed`, `unsearchable`) SHALL be the single classification input shared by the router, the kernel, session operations and `validate`; a nested directory name in it SHALL be matched by longest prefix wherever a path is classified or a root name checked for reservation.

`subagents` SHALL NOT be reserved: no part of the runtime reads that prefix, so a workspace may mount a directory of that name as ordinary agent-visible content.

#### Scenario: Mount over a session area refused

- **WHEN** a consumer supplies a mount at `/scratchpad/`
- **THEN** assembly throws `MountCollisionError` and no agent is returned

#### Scenario: Mount over the authoring prefix refused

- **WHEN** a consumer supplies a mount at `/workflows/` or `/workflows/order-lookup/`
- **THEN** assembly throws `MountCollisionError` naming what that prefix holds: workflow specs, `WORKFLOW.md`, code-state scripts and cases

#### Scenario: A code state's script is not in the agent's workspace

- **WHEN** the workflow declares a code state with `script: scripts/check-refund.js`, and the agent lists `/` and reads `workflows/order-lookup/scripts/check-refund.js`
- **THEN** the listing holds no `workflows` entry, and the read is not served from the authoring backend

#### Scenario: A former prefix is mountable

- **WHEN** a consumer supplies a mount at `/subagents/`
- **THEN** assembly succeeds and the mount is served as ordinary authored content

#### Scenario: Writable mount over the authoring backend refused

- **WHEN** a mount is declared `{ backend: authoring, readOnly: false }` where `authoring` is the authoring backend
- **THEN** assembly throws `AuthoringBackendExposedError` naming the mount key

#### Scenario: A nested mount name reserves its prefix

- **WHEN** the table mounts `/catalogs/eu/` and a session id `catalogs` is requested
- **THEN** the id is refused as a reserved root name, as it would be for a single-segment mount

### Requirement: Content-addressed spec snapshots

`computeSpecHash(spec)` SHALL hash the spec with object keys sorted at every level and every runtime-inert `metadata` block removed — at the root and on each state, a grader or code state included — so key order, formatting and canvas state never change the hash. A governing edit SHALL change it, a grader state's `instructions` or `model` and a code state's `script` included. At each turn boundary whose machine `specHash` differs from the one the session last recorded, the runtime SHALL write that governing spec (without any `metadata` block) to `_specs/<specHash>.json` at the store root unless the file exists; a losing create race SHALL be treated as success and any other write failure SHALL be a `warning` event, never a turn failure. `agent.getSpecSnapshot(hash)` SHALL return the persisted `MachineSpec` or `null`.

The persisted snapshot SHALL carry each grader state's `instructions` and `model` and each code state's `script`: a grader or a code state governed the session being recorded, so the record of what governed it is incomplete without the standard each grader decided against and the script each code state ran.

#### Scenario: Hash ignores host metadata at every position

- **WHEN** two specs differ only in a `metadata` block at the root or on a state, a grader state included
- **THEN** `computeSpecHash` is identical and the persisted snapshot omits every such block

#### Scenario: A rubric edit is a governing edit

- **WHEN** two specs differ only in the `instructions` of one grader state, the standard its
  grader decides against
- **THEN** `computeSpecHash` differs and a snapshot is written for the new hash

#### Scenario: Definition changes between turns

- **WHEN** a session's first turn runs under spec A, `workflow.yaml` is edited to B, and the session takes a second turn
- **THEN** snapshots exist for both hashes and the session's recorded `specHash` is B's

#### Scenario: Unknown hash

- **WHEN** `getSpecSnapshot` is called with a hash no session has recorded
- **THEN** it resolves to `null` rather than throwing

### Requirement: Audit trail

The runtime SHALL record an ordered `auditTrail` in checkpointed state, one `TrailStep` (`to`, `kind`, `ts`, optional `reason`, and for `sub-workflow` steps `workflow` and `status: ok | error`) at every commit site: `trigger` at each turn boundary (`to` the opening state, `reason` the trigger id); `agent` on a committed `archmax_advance` of the session's agent with its reason; `grader` and `code` on a committed move out of a grader or a code state, with its reason (see `automated-states`); `human` on a decision at a human state (`to` the chosen target, or the parked state itself when the decision ends the session), with the comment as reason when given; `reset` on `archmax_reset`; `on_error` when a failure, an automated state's included, routes to the state's `on_error` target; `sub-workflow` once per child session, with `to` the calling state. The step kinds SHALL be exactly `trigger`, `agent`, `human`, `grader`, `code`, `sub-workflow`, `reset` and `on_error`. A refused or invalid transition SHALL append nothing, and neither SHALL an automated state's advance that its run discards. The channel's fold SHALL treat an equal list as a no-op echo, an extension as a replacement, and anything else as an append, so every step a state commits is retained in commit order and the order is total. A child session's trail SHALL never be spliced into the parent's. The trail SHALL be exposed on every `Outcome`, on `SessionView.auditTrail`, in `trail.json`, to a grader through `archmax_get_history`, and to a code state's script as its `trail`; a checkpoint predating the field SHALL read as an empty trail.

#### Scenario: Turn opening recorded

- **WHEN** a turn opens in state `identify-case` under trigger `manual`
- **THEN** the trail gains `{ to: "identify-case", kind: "trigger", reason: "manual" }`

#### Scenario: Vetoed transition leaves no step

- **WHEN** the agent's `archmax_advance` is refused because it names a state its state declares no transition to, or a target whose `requires` the variables do not meet
- **THEN** no step is appended

#### Scenario: Automated moves are recorded under their type

- **WHEN** code state `check-refund` advances to `refund-review` with reason `matches the policy`, and later grader state `review-reply` advances to `answered` with reason `the reply is accurate and polite`
- **THEN** the trail gains `{ to: "refund-review", kind: "code", reason: "matches the policy" }` and then `{ to: "answered", kind: "grader", reason: "the reply is accurate and polite" }`

#### Scenario: A discarded advance leaves no code step

- **WHEN** a code state's script calls `tools.archmax_advance` and then throws, and the state declares an `on_error` target
- **THEN** no `code` step is appended, and an `on_error` step to that target is

#### Scenario: Delegation recorded in the calling state

- **WHEN** state `enrich` calls `archmax_workflow_enrich-order` three times in one batch
- **THEN** three `sub-workflow` steps with `to: "enrich"` are recorded in call order, none of the child's own steps appear, and a later `archmax_advance` adds an `agent` step after them

### Requirement: Token accounting

After every model call the governance middleware SHALL read the provider's usage from the AI message (`usage_metadata` with `input_token_details.{cache_read,cache_creation}`, or the OpenAI-compatible and Anthropic raw shapes), treating a missing field as zero, and emit one `model-usage` event carrying `state`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, the `model` it was priced against, and `costUsd` when priced; the default model client SHALL request usage in its stream (`streamUsage: true`). A grader's model calls (see `automated-states`) SHALL be read, normalized and priced by the same rules, each emitting one `model-usage` event whose `state` is the grader state, and SHALL count toward the session's cumulative usage. The reported `inputTokens` SHALL be the **total** input count, of which `cacheReadTokens` and `cacheCreationTokens` are a breakdown: a provider shape that reports those counts beside an input count that excludes them SHALL be normalized to the inclusive total, so one reading holds whatever the provider sent. Cost SHALL come from a `PricingTable` (USD per million tokens; `input`, `output`, `cacheRead`, `cacheWrite`, a missing cache rate falling back to the input rate) resolved by exact model id, then the longest key that is a substring of the id, then `default`; the id resolved against SHALL be **the one the response reported, else the one the runtime asked the endpoint to run, else none** — a response that names no model SHALL NOT cost the call its price, and the id actually used SHALL appear on the event. Cost SHALL charge the input rate on the input tokens that were neither served from nor written to cache, and the cache rates on the remainder, never charging a cached token twice; a breakdown exceeding the reported total SHALL clamp the full-rate portion at zero rather than going negative. The `pricing` assembly option SHALL take precedence over `ARCHMAX_PRICE_INPUT`, `ARCHMAX_PRICE_OUTPUT`, `ARCHMAX_PRICE_CACHE_READ` and `ARCHMAX_PRICE_CACHE_WRITE` (which populate the `default` key); an unpriced model SHALL report tokens only and never a cost of zero. The session's cumulative `UsageSummary` SHALL be written to the checkpointed `usage` channel after each call (a grader's calls when its run commits), so totals survive parks and process restarts, and SHALL be read from the checkpoint onto `Outcome.usage`, `SessionSummary.usage` and `metadata.json` (the in-memory tracker is the fallback when the checkpoint holds none). The exported `createUsageTracker({ onEvent? })` SHALL accumulate `model-usage` events per session from the event envelope's `sessionId`, forward every event to the wrapped subscriber, and expose `totals(sessionId?)`, `bySession()` and `reset()`.

#### Scenario: Cache detail captured while streaming

- **WHEN** a streamed response reports cached-input detail beside its input and output counts
- **THEN** the `model-usage` event records cache-read and cache-creation tokens in their own fields, and `inputTokens` is the total that includes them

#### Scenario: A provider that echoes no model id is still priced

- **WHEN** a response carries usage but names no model, and a price table holds an entry keyed by the id the runtime asked the endpoint to run
- **THEN** that entry prices the call, `costUsd` appears on the `model-usage` event, and the event's `model` is the configured id

#### Scenario: The served model outranks the requested one

- **WHEN** a response names a model different from the one the runtime asked for, and the price table holds an entry for each
- **THEN** the call is priced from the entry for the model that answered, and the event's `model` is the reported id

#### Scenario: Cached tokens are charged once

- **WHEN** a call reports 20,000 input tokens of which 18,000 were served from cache, priced at an input rate and a lower cache-read rate
- **THEN** `costUsd` charges 2,000 tokens at the input rate and 18,000 at the cache-read rate, not 20,000 at the input rate plus 18,000 at the cache-read rate

#### Scenario: A disjoint provider shape is normalized

- **WHEN** a raw provider shape reports an input count that excludes its cache-read count
- **THEN** `inputTokens` reports the two combined and the call is priced identically to the same usage reported inclusively

#### Scenario: Unpriced model omits cost

- **WHEN** no `pricing` option and no `ARCHMAX_PRICE_*` variable is set
- **THEN** every `model-usage` event, `Outcome.usage` and `SessionSummary.usage` carry token counts and no `costUsd`

#### Scenario: A grader's calls count toward the session

- **WHEN** in one turn the session's agent makes one model call and a grader state's grader makes two, each reporting usage
- **THEN** three `model-usage` events are emitted, two of them naming the grader state, and `sessions.get(id).usage` holds the sum of all three

#### Scenario: Totals survive park and resume

- **WHEN** a session consumes tokens, parks at a human state, the process exits, and the session resumes elsewhere and consumes more
- **THEN** `sessions.get(id).usage` and the emitted `metadata.json` carry the sum of both stretches

#### Scenario: Tracker separates concurrent sessions

- **WHEN** two sessions run concurrently on one assembled agent with the tracker's handler as `onEvent`
- **THEN** `totals("a")` and `totals("b")` each hold only their own session's usage and `totals()` holds the sum

### Requirement: Reads are text only

The workspace router SHALL serve `read` as text only. After routing a read (file mount or composite,
as today), it SHALL refuse the result as **binary** when any of these holds:

- the MIME type the route reports, or else the one Deep Agents' `read_file` derives from the path's
  extension, is not a text type. The text types SHALL be Deep Agents' own (`text/*`,
  `application/json`, `application/javascript`, `image/svg+xml`) plus `application/xml` and every
  structured-syntax `+xml` or `+json` type, each compared without its parameters and case, so the
  refused types are images other than SVG, audio, video, PDF, PPT/PPTX and every other non-text
  type;
- the content is bytes rather than a string;
- the content is a string containing a NUL character (a binary file whose extension maps to text).

A binary read SHALL be answered with the backend protocol's `{ error }`, which `read_file` renders
as `Error: …`, and SHALL NOT carry the file's content in any form. The error SHALL name the path in
workspace form, the MIME type (`application/octet-stream` when only the content showed the file is
binary), and the size when the route returned the bytes, and SHALL say the file was not read and
that `read_file` returns text files only — for example:
`'scratchpad/chart.png' is a binary file (image/png, 24.1 KB) and was not read; read_file returns text files only.`
A route's own `{ error }` (a missing file, a directory, a refused symlink) SHALL be returned
unchanged, and a text result SHALL be returned with its content unchanged. A text result under a type
Deep Agents' `read_file` would hand on as a base64 block (`application/xml`, a `+xml` type, JSON
with a parameter) SHALL be relabelled `text/plain`, so `read_file` returns it as text.

The refusal is the workspace's answer, not a governance verdict: no kernel rule fires and no
`tool-blocked` event is emitted; the call settles as an ordinary tool result. It SHALL hold for every
caller of `read` — the model's `read_file`, a sandbox script's `tools.readFile` (an agent's
`archmax_eval`/`archmax_run` script or a code state's script), which receives the error text as its
string result — and for every route, the session zone, every mount and a consumer's custom backend
alike, with one exception: with the `images` assembly option on, the model's own `read_file` of an
image is answered as "An image the agent reads reaches the model" says. `readRaw` SHALL be
unaffected.

The `read_file` description handed to the model, in a governed and a plain agent alike, SHALL NOT
promise multimodal content: Deep Agents' lines saying images, audio, video and PDFs return
multimodal content blocks SHALL be replaced by one line saying a binary file is not returned and is
reported as binary — and, with `images` on, that a PNG, JPEG, GIF or WebP image is shown right after
the tool result. When those lines are not found, the description SHALL be left unchanged and one
`warning` event SHALL say the upstream text may have been reworded.

#### Scenario: An image is reported, not returned

- **WHEN** the model calls `read_file` on `scratchpad/chart.png` in an agent without `images`
- **THEN** the tool result is the single text `Error: 'scratchpad/chart.png' is a binary file (image/png, …) and was not read; read_file returns text files only.`, with no image block and no base64 in the message, the `tool-result` event, or the checkpoint

#### Scenario: Every non-text type is refused

- **WHEN** the model reads `.mp3`, `.mp4`, `.pdf` and `.pptx` files from a mount
- **THEN** each read returns the binary notice naming that file's MIME type, and none returns an `audio`, `video` or `file` block

#### Scenario: An unknown-extension binary is refused

- **WHEN** the model reads `scratchpad/export.zip`, whose bytes contain NUL, and a file `scratchpad/blob` with no extension holding the same bytes
- **THEN** both reads return the binary notice with `application/octet-stream`, not UTF-8-decoded content

#### Scenario: Text still reads

- **WHEN** the model reads `skills/order-data/assets/orders.json`, an SVG file, and a Latin-1 text file with an unknown extension
- **THEN** each returns its line-numbered content exactly as before

#### Scenario: A route's own error passes through

- **WHEN** the model reads `scratchpad/missing.png`, which does not exist
- **THEN** the result is the route's not-found error, not the binary notice

#### Scenario: A script gets the notice as text

- **WHEN** an `archmax_eval` script or a code state's script calls `await tools.readFile({ file_path: "scratchpad/chart.png" })`, with or without `images`
- **THEN** the promise resolves to the binary notice string, not JSON carrying base64

#### Scenario: A custom backend's bytes are refused

- **WHEN** a consumer's mount backend answers `read` with `{ content: <Uint8Array>, mimeType: "image/png" }`
- **THEN** the router returns the binary notice naming `image/png` and the byte size

#### Scenario: The runtime's own reads are unaffected

- **WHEN** the runtime reads a file through `readRaw`
- **THEN** it receives the stored data, bytes included, as before

#### Scenario: The description states the contract

- **WHEN** a governed or a plain agent makes a model call that offers `read_file`
- **THEN** the tool's description says binary files are reported as binary and not returned, and does not mention multimodal content blocks

#### Scenario: Reworded upstream text warns once

- **WHEN** Deep Agents' `read_file` description no longer contains the lines the runtime replaces
- **THEN** the description is passed through unchanged and one `warning` event names `read_file`

#### Scenario: XML a store labels by its registered type is text

- **WHEN** the session store reports `scratchpad/docx/word/document.xml` as `application/xml`,
  `word/_rels/document.xml.rels` as `application/vnd.openxmlformats-package.relationships+xml`, and
  `meta.json` as `application/json; charset=utf-8`, and the model calls `read_file` on each and a
  script calls `tools.readFile` on the first
- **THEN** each read returns the file's text, with no binary notice and no `file` block

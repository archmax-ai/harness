## Why

`read_file` refused every file its backend reported as `application/xml`: "is a binary file
(application/xml) and was not read". The harness's `isTextMimeType` (`src/core/binary-read.ts`), a
copy of Deep Agents' own, accepts only `text/*`, `application/json`, `application/javascript` and
`image/svg+xml`.

An object store labels a file by its registered type. The platform's store returns
`word/document.xml` as text marked `application/xml`, and a `.rels` file as a `+xml` type. Editing
`word/document.xml` as text is what the platform's Office skill relies on, so once request 11 lets a
child find the files it unpacked, the invoice workflow would still stop here. The defect dates from
0.4.0. In production the session-folder bug hid it, because the file was never found.

## What Changes

- **XML and JSON are text whatever the store labels them.** `isTextMimeType` accepts Deep Agents'
  types plus `application/xml` and every structured-syntax `+xml` or `+json` type, matching the
  platform's own rule. It compares a type without its parameters and case, so
  `application/json; charset=utf-8` reads as text too.
- **`read_file` is handed such a read as text.** Deep Agents' `read_file` branches on the result's
  `mimeType` by its own, narrower rule, and would answer `application/xml` text with a base64 `file`
  block. The workspace router relabels a text result under such a type `text/plain`; the content is
  unchanged.
- Bytes, and a string holding a NUL, are still refused under any type.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `workspace-and-sessions`: "Reads are text only" names the text types and the relabelling.

## Impact

- **Code:** `src/core/binary-read.ts` (`isTextMimeType`, `asTextRead`),
  `src/core/workspace-router.ts` (the text-only read).
- **Docs:** `guides/workflow-machine.md`, `reference/changelog.md`.
- **Authoring skill:** `references/hook-and-test-scripts.md` (`tools.readFile`).
- **Release:** a fix; it ships in 0.6.0 beside the other three changes of that release.

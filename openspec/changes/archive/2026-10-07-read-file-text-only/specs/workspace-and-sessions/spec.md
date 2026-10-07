## ADDED Requirements

### Requirement: Reads are text only

The workspace router SHALL serve `read` as text only. After routing a read (file mount or composite,
as today), it SHALL refuse the result as **binary** when any of these holds:

- the MIME type the route reports, or else the one Deep Agents' `read_file` derives from the path's
  extension, is not a text type — exactly the set for which `read_file` would return a multimodal
  content block (images other than SVG, audio, video, PDF, PPT/PPTX);
- the content is bytes rather than a string;
- the content is a string containing a NUL character (a binary file whose extension maps to text).

A binary read SHALL be answered with the backend protocol's `{ error }`, which `read_file` renders
as `Error: …`, and SHALL NOT carry the file's content in any form. The error SHALL name the path in
workspace form, the MIME type (`application/octet-stream` when only the content showed the file is
binary), and the size when the route returned the bytes, and SHALL say the file was not read and
that `read_file` returns text files only — for example:
`'scratchpad/chart.png' is a binary file (image/png, 24.1 KB) and was not read; read_file returns text files only.`
A route's own `{ error }` (a missing file, a directory, a refused symlink) SHALL be returned
unchanged, and a text result SHALL be returned unchanged.

The refusal is the workspace's answer, not a governance verdict: no kernel rule fires and no
`tool-blocked` event is emitted; the call settles as an ordinary tool result. It SHALL hold for every
caller of `read` — the model's `read_file`, a sandbox or hook script's `tools.readFile`, which
receives the error text as its string result — and for every route, the session zone, every mount
and a consumer's custom backend alike. `readRaw` SHALL be unaffected.

The `read_file` description handed to the model, in a governed and a plain agent alike, SHALL NOT
promise multimodal content: Deep Agents' lines saying images, audio, video and PDFs return
multimodal content blocks SHALL be replaced by one line saying a binary file is not returned and is
reported as binary. When those lines are not found, the description SHALL be left unchanged and one
`warning` event SHALL say the upstream text may have been reworded.

#### Scenario: An image is reported, not returned

- **WHEN** the model calls `read_file` on `scratchpad/chart.png`
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

- **WHEN** an `archmax_eval` script calls `await tools.readFile({ file_path: "scratchpad/chart.png" })`
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

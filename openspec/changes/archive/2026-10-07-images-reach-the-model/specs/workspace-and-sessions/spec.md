## MODIFIED Requirements

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
and a consumer's custom backend alike, with one exception: with the `images` assembly option on, the
model's own `read_file` of an image is answered as "An image the agent reads reaches the model"
says. `readRaw` SHALL be unaffected.

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

- **WHEN** an `archmax_eval` script calls `await tools.readFile({ file_path: "scratchpad/chart.png" })`, with or without `images`
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

## ADDED Requirements

### Requirement: An image the agent reads reaches the model

`createAgent` SHALL accept `images` — `true`, or `{ maxBytes?, keep? }` — off by default, because a
model without vision rejects an image. With it on, in a governed and a plain agent alike, the model's
`read_file` of a PNG, JPEG, GIF or WebP image that the call's governance allows SHALL answer with one
text line, `Image '<path>' (<type>, <size>) is shown below.`, and before every later model call of
the session the image SHALL be read from the workspace and added to that call's **request** as a
`user` message placed right after the batch of tool results that read it, as an `image_url` part
carrying a data URL. No `tool` message SHALL carry an image part. The image's bytes SHALL NOT enter
the message history, a checkpoint, a `tool-result` event or a script's result; the tool message
records the path only.

An image larger than `maxBytes` (default 10 MB) SHALL be answered with a line saying it was not shown,
and nothing attached. Of the images read in the session, the most recent `keep` (default: all) SHALL
stay attached on later calls; an older one SHALL be named in text as no longer attached. An image
read earlier and since deleted or changed into something else SHALL be named in text as no longer
available, and the model call SHALL go ahead. Every other binary file (HEIC/HEIF, audio, video, PDF,
PowerPoint, `.docx`, `.zip`) SHALL stay refused with the binary notice, option on or off.

#### Scenario: The image follows the tool results

- **WHEN** an agent with `images: true` reads `attachments/photo.png`
- **THEN** the next model request carries the image as an `image_url` part of a `user` message right
  after that batch's tool results, no `tool` message carries an image part, and a chat-completions
  endpoint accepts the request

#### Scenario: No bytes are kept

- **WHEN** that turn ends
- **THEN** the checkpointed history, the `tool-result` event and a script's `tools.readFile` of the
  same file carry no base64

#### Scenario: A deleted image is named

- **WHEN** an image read earlier in the session is deleted and the model is called again
- **THEN** the request names the image as no longer available instead of attaching it, and the call succeeds

#### Scenario: Other binaries stay refused

- **WHEN** an agent with `images: true` reads a PDF
- **THEN** the result is the binary notice and nothing is attached

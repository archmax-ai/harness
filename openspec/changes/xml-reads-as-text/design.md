## Context

- The workspace router's `textOnly` wraps every routed `read`. It asks `binaryReadError` whether the
  result is binary: by the route's `mimeType` (else the extension's) through `isTextMimeType`, by
  bytes, or by a NUL. A binary result becomes `{ error }`; a text result passes on unchanged.
- Deep Agents' `read_file` then makes its own decision from the same result:
  `readResult.mimeType ?? getMimeType(path)`, through its own `isTextMimeType`. A type it does not
  read as text is returned as an `image`, `audio`, `video` or `file` block of base64, whatever the
  content.
- Deep Agents' `getMimeType` maps `.xml` to nothing, so `text/plain`. The defect needs a backend
  that reports a type of its own, as an object store does.

## Goals / Non-Goals

**Goals:**

- A file an object store labels as XML or JSON reads as text, for the model and for a script.
- Nothing that was refused as binary for its content (bytes, NUL) starts being read.

**Non-Goals:**

- Reading other `application/*` types as text (`application/yaml`, `application/x-sh`). Neither the
  request nor the platform's rule covers them, and a store reporting one is not known.
- Changing Deep Agents' own rule or `readRaw`.

## Decisions

**1. Widen the harness's rule, not upstream's.** `isTextMimeType` keeps Deep Agents' four types and
adds `application/xml`, `+xml` and `+json`, the platform's own rule. `image/svg+xml` was already
text and is now also covered by the suffix. The type is compared by its essence (lowercased, without
`; charset=…`), which upstream does not do; that is why `application/json; charset=utf-8` was
refused.

**2. Relabel the text result where upstream would hand it on as a block.** Widening the harness's
rule alone lets the result through to `read_file`, which would then base64 it into a `file` block,
the very thing "Reads are text only" exists to prevent. `asTextRead` sets `mimeType: "text/plain"`
on a text result whose type Deep Agents' rule rejects. It leaves every other result untouched, so a
type upstream already reads as text keeps its label.

*Alternative:* drop `mimeType` and let `read_file` fall back to the extension. That fails for a
labelled file whose extension upstream maps to a binary type, and for one with no extension; an
explicit `text/plain` does not.

## Risks / Trade-offs

- **A store that labels binary content as XML.** If the bytes come back as bytes, they are still
  refused. If a store decodes binary content to a string, the NUL check still applies, as it does for
  a binary file with a text extension.

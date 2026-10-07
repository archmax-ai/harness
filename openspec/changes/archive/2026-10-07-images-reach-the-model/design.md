## Context

The workspace router refuses a binary `read` for every caller (`core/binary-read.ts`), and
`readFileContractMiddleware` tells the model so. Middleware composes with the first in the list
outermost, so a middleware installed after the workflow's own sees only tool calls governance
allowed, and only model requests the workflow has already shaped.

## Goals / Non-Goals

**Goals:** the model sees an image it reads, where chat completions accepts one; the bytes stay out
of everything that is stored or emitted; nothing changes with the option off.

**Non-Goals:** PDFs, audio and video (chat completions takes none of them in a `user` message
uniformly); HEIC/HEIF; showing images to scripts or hooks; image resizing.

## Decisions

### Intercept the model's `read_file`, not the router

The router stays text only for every caller, so a script's `tools.readFile` and the runtime's own
reads are untouched. The middleware's `wrapToolCall` answers the model's `read_file` of an image
itself: it reads the file through `readRaw` (the workspace's own refusals — a symlink, a missing
file — fall back to `read_file`'s ordinary answer), and returns the one-line result with an
`artifact` naming the path and type. LangChain never sends an `artifact` to the model, and it holds
no bytes.

### Add the image per request, after its batch

`wrapModelCall` scans the request for marked tool messages and inserts one `user` message after each
batch of tool results that read images, with an `image_url` part (a data URL, which LangChain's
OpenAI and Anthropic converters both accept) per image. Only the request changes; the graph state,
and so the checkpoint, never holds the inserted message. Reading per request is what lets a deleted
image be reported instead of resent, at the cost of a read per image per call.

*Alternative:* store the image block in the history and move it at request time, as the platform does
today. That keeps the bytes in every checkpoint, which is what the platform asked to be rid of.

### Defaults

- `maxBytes`: 10 MB, Deep Agents' own bound for `read_file`.
- `keep`: every image read in the session, which is what the platform does today. A bound keeps the
  most recent ones and names the rest in text, so the model can read one again.
- Deleted or changed: named as no longer available; the call is never failed for it.

### An option, installed beside the `read_file` contract

Both compositions install the pair (`fileReadMiddleware`) at the same depth: after the workflow's
middleware and before the provider cache and the host's. The `read_file` description switches to the
images line when the option is on.

## Risks / Trade-offs

- [Every attached image is resent on every later call] → `keep` bounds it; the default matches the
  platform's current behaviour.
- [A model without vision fails the request] → the option is off by default and documented as such.
- [Inserting a `user` message after tool results] → valid for chat completions and for Anthropic,
  whose converter merges consecutive user content; checked live against the reference endpoint.

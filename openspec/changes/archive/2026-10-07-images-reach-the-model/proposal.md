## Why

`read-file-text-only` (unreleased, in the same `0.4.0`) made the workspace refuse every binary read,
images included, because Deep Agents' `read_file` puts an image into the `tool` message, which chat
completions refuses, and the bytes then ride in every checkpoint, event and script result. The
platform relies on its agents seeing images — an uploaded photo or screenshot, an image a connection
tool returned — and today moves Deep Agents' image block into a `user` message itself
(`tool-result-media.ts`). With the refusal, every one of those reads gets "is a binary file … and was
not read". The platform's review of `0.4.0` (C2) asks that an image the agent reads reach the model
as an image, while every other binary stays refused.

## What Changes

- A new assembly option, **`images`** (`true`, or `{ maxBytes?, keep? }`), off by default because a
  model without vision rejects an image.
- With it on, the model's `read_file` of a PNG, JPEG, GIF or WebP answers with one line —
  `Image '<path>' (<type>, <size>) is shown below.` — and a runtime middleware adds the image to each
  later model request as a `user` message right after that batch of tool results, read from the
  workspace per request. The bytes never enter the history, checkpoints, events or scripts.
- Earlier images stay attached on later calls (the most recent `keep`, default all); one deleted
  since, or over `maxBytes` (default 10 MB), is named in text and the call goes ahead.
- The `read_file` description says what happens to an image when the option is on.
- A script's `tools.readFile` keeps the binary notice, and every other binary stays refused.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `workspace-and-sessions`: "Reads are text only" names the one exception; new requirement "An image
  the agent reads reaches the model".

## Impact

- **Code:** `src/assembly/image-reads.ts` (new: the middleware, the option, the request rewrite);
  `src/core/binary-read.ts` (`SHOWN_IMAGE_MIME_TYPES`, the images description line);
  `src/assembly/compose.ts`, `src/assembly/plain.ts` (install it beside the `read_file` contract);
  `src/assembly/index.ts` (`images` option); `src/index.ts` (`ImageReadOptions`).
- **Tests:** `src/behaviour/image-reads.test.ts`; `src/behaviour/support.ts` records each call's
  content parts.
- **docs/:** `reference/public-api.md` (an `images` section and the export),
  `guides/workflow-machine.md` (reads are text only, with the option), `guides/code-interpreter.md`,
  `reference/changelog.md` (the `read-file-text-only` entry under `0.4.0`).
- **skills/archmax-harness/:** `references/backend-integration.md` (the option row),
  `references/hook-and-test-scripts.md`.
- **Release:** in `0.4.0` (`release:minor`), with the other changes.

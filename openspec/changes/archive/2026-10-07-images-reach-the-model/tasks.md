## 1. The middleware

- [x] 1.1 `src/core/binary-read.ts`: `SHOWN_IMAGE_MIME_TYPES` (PNG, JPEG, GIF, WebP), `shownImageMimeTypeOf`, `READ_FILE_IMAGES_LINE`, and a `line` parameter on `textOnlyReadFileDescription`. Verify with `npm run typecheck`.
- [x] 1.2 `src/assembly/image-reads.ts`: `resolveImageReads`, `imageReadMiddleware` (`wrapToolCall` answers the model's `read_file` of an image with the line and an `artifact` mark; `wrapModelCall` inserts a `user` message with the images after each batch, honouring `keep`, `maxBytes`, and a deleted image). Verify with 2.1.
- [x] 1.3 `createAgent({ images })`; `fileReadMiddleware` installs the contract and the image middleware in both compositions after the workflow's middleware; export `ImageReadOptions`. Verify with `npx vitest run src/index.test.ts`.

## 2. Tests

- [x] 2.1 `src/behaviour/image-reads.test.ts`: the image follows the tool results as a `user` `image_url` part and no `tool` message carries one; history and the `tool-result` event carry no base64; a PDF and a script's `tools.readFile` stay refused; a deleted image is named and the call goes ahead; `keep` and `maxBytes`; a governed refusal shows nothing; the description; a plain agent; off by default. Verify that the file passes.
- [x] 2.2 Live check against a chat-completions endpoint: a plain agent with `images: true` reads a generated 16×16 red PNG from `scratchpad/` and is asked its colour. Run on 7 October 2026 with `anthropic/claude-sonnet-5` through the repo's `.env`: the endpoint accepted the request, the model answered "Red", and the session history held no base64.

## 3. Docs and authoring skill

- [x] 3.1 `docs/`: `reference/public-api.md`, `guides/workflow-machine.md`, `guides/code-interpreter.md`, `reference/changelog.md`. Verify with `npm run docs:build`.
- [x] 3.2 `skills/archmax-harness/references/backend-integration.md`, `references/hook-and-test-scripts.md`. Verify with a grep for `images`.

## 4. Verify

- [x] 4.1 Run `npm run typecheck`, `npm test` and `npx openspec validate images-reach-the-model --strict`. All pass.

## 1. Runtime

- [x] 1.1 `src/core/binary-read.ts`: `isTextMimeType` accepts Deep Agents' types plus `application/xml`, `+xml` and `+json`, compared by essence; keep Deep Agents' own rule as `deepAgentsReadsAsText`.
- [x] 1.2 `src/core/binary-read.ts`: `asTextRead` relabels a text result `text/plain` where Deep Agents' rule would hand it on as a block.
- [x] 1.3 `src/core/workspace-router.ts`: the text-only read returns `asTextRead(res)` for a text result.

## 2. Tests

- [x] 2.1 `src/core/binary-read.test.ts`: the text and binary types, parameters and case; `binaryReadError` keeps XML and JSON text and still refuses bytes; `asTextRead` relabels only where needed.
- [x] 2.2 `src/behaviour/binary-read.test.ts`: a session store labelling `document.xml`, a `.rels` file and a JSON file by registered type; `read_file` and `tools.readFile` return their text, with no notice and no `file` block. Fails without either half of the fix.

## 3. Docs and authoring skill

- [x] 3.1 `guides/workflow-machine.md`: XML and JSON are text whatever the backend calls them.
- [x] 3.2 `skills/archmax-harness/references/hook-and-test-scripts.md`: the same for `tools.readFile`.
- [x] 3.3 The `0.6.0` section of `reference/changelog.md`.

## 4. Verify

- [x] 4.1 `npm run typecheck`, `npm run lint`, `npm test` and `npm run docs:build` pass.
- [x] 4.2 `openspec validate xml-reads-as-text --strict` passes.

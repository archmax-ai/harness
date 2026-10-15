## 1. Runtime

- [x] 1.1 `src/machine/machine.ts`: `mountWritable` requires, for a governed mount, `mountWriteRequested(name)` (a `read_write` grant in `allow_always` or any state's `allow`, computed once); add `mountNarrowedToRead(state, name)`.
- [x] 1.2 `src/kernel/kernel.ts`: the `mount.read-only` reason says `('access: read')` or that no grant of this workflow asks for `access: read_write`.
- [x] 1.3 `src/machine/lint-spec.ts`: no redundant-grant warning for a state's `read_write` entry beside a bare root grant.
- [x] 1.4 Comments in `src/core/mount-prompt.ts` and `src/machine/mount-grants.ts` describe a bare grant as asking for no write.

## 2. Tests

- [x] 2.1 `src/machine/mounts.test.ts`: a bare grant alone reads a writable mount; a bare grant and a `read_write` grant in another state both write; a caller's `read_write` does not make its child's bare grant write.
- [x] 2.2 `src/kernel/kernel.test.ts` and `kernel.paths.test.ts`: the refusal and its two reasons; the paths test grants the `read_write` it writes through.
- [x] 2.3 `src/machine/lint-spec.test.ts`: the new lint exception.
- [x] 2.4 `src/behaviour/child-sessions.test.ts`: a caller granting `read_write` writes and its bare-granting child is refused with the prompt listing the mount read-only; and the other way round.

## 3. Docs and authoring skill

- [x] 3.1 `guides/workflow-machine.md` (mount governance) and `reference/machine-spec.md` (read or read/write; tool path rules; validate list).
- [x] 3.2 `reference/public-api.md`: the `mountWritable` reader and the `readOnly` ceiling paragraph.
- [x] 3.3 `skills/archmax-harness/references/workflow-schema.md` and `references/backend-integration.md`.
- [x] 3.4 `README.md` and the `0.6.0` section of `reference/changelog.md`, marked breaking.

## 4. Verify

- [x] 4.1 `npm run typecheck`, `npm test` and `npm run docs:build` pass.
- [x] 4.2 `npx openspec validate mount-write-needs-own-grant` passes.

# Tasks

## 1. Declarations

- [x] 1.1 `src/machine/tool-connections.ts`: `resolveToolConnections` and `ToolConnectionsError` (D-a). Verify `tool-connections.test.ts`: a built-in tool, a reserved name and an empty argument name throw.
- [x] 1.2 `createAgent`'s `toolConnections`, resolved once and passed to every machine of the assembly, root and delegated (D-a). Export `ToolConnectionsError`.

## 2. Governance

- [x] 2.1 `normalizeAllowEntry` carries an entry's `connection`; `WorkflowMachine.checkAllowed` matches it against the declared argument (D-b). Verify `machine.test.ts`: two entries of one tool, each with its own connection and guards; an entry naming none admits only a call naming none; an undeclared tool ignores `connection`.
- [x] 2.2 Forbid entries match the connection (D-b). Verify `kernel.test.ts`.
- [x] 2.3 `withConnection` and its use in `src/workflow/governance.ts` and `src/sandbox/ptc-gateway.ts`; the not-allowed reason names the state's connections (D-c). Verify the behaviour suite: a script's call without `connection` runs through the state's one connection and the tool receives it; a call without it where the state grants two is refused naming both.
- [x] 2.4 Disclosure renders the connection (D-d).

## 3. Documentation

- [x] 3.1 `docs/`: `reference/public-api.md`, `reference/machine-spec.md`, `guides/workflow-machine.md`, `reference/changelog.md`.
- [x] 3.2 README.md: the wiring section names `toolConnections`.
- [x] 3.3 `skills/archmax-harness/`: `references/backend-integration.md`, `references/workflow-schema.md`.

## 4. Wrap up

- [x] 4.1 `npm run typecheck`, `npm test`, `npx openspec validate --specs`.
- [x] 4.2 Sync the delta specs into `openspec/specs/` and archive the change.

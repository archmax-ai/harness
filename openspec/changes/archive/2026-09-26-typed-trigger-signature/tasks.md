## 1. The signature module

- [x] 1.1 Add `src/machine/signature.ts` with `SIGNATURE_TYPES`, the `SignatureEntry`, `SignatureType`, `TriggerSignature` and `SignatureValueIssue` types, and `normalizeSignature` (bare name and `{ name }` normalize to the same entry); verify with a new `signature.test.ts` covering both spellings and declaration order
- [x] 1.2 Implement `signatureJsonSchema(entries)` per the mapping in `workflow-spec` (*One mapping from a signature to JSON Schema*); verify `signature.test.ts` pins the output for every type, an untyped entry (`{}`), descriptions, and `required` in declaration order
- [x] 1.3 Implement `signatureValueIssues(entries, values)` with hand-written RFC 3339 `date`/`date-time` checks (no `Date.parse`), no coercion, and `null` refused for typed entries; verify tests cover `2026-02-30`, a date-time without offset, `2.5` for `integer`, `"4"` for `integer`, `null` typed vs untyped, and one issue per missing name
- [x] 1.4 Implement `signatureForTrigger(spec, triggerId)` over a parsed spec (description plus normalized lists) and add `WorkflowMachine.signatureForTrigger(id)` delegating to it; derive `requiresForTrigger`/`returnsForTrigger` names from the normalized lists; verify `machine.test.ts` and `triggers.test.ts` still pass unchanged plus new cases for typed entries

## 2. The schema

- [x] 2.1 Extend `signatureSchema` in `src/machine/spec-schema.ts` to accept a strict `{ name, type?, description? }` object beside a bare name, keep distinctness by name across both spellings and the `trigger`/`title` returns refusals, and reword the list error message (it no longer says a signature "names the contract only"); verify `spec-schema.test.ts` covers an unknown type, an unknown entry key, a duplicate across spellings, and that the malformed-signature messages match `archmax validate`
- [x] 2.2 Add `description` (non-empty string) to `triggerDeclarationSchema`; verify the lint no longer warns for it (TRIGGER_KEYS derives from the shape) and an empty description is a load error naming the trigger
- [x] 2.3 Update `declaredVariableNames` / guard-reference advisories to read names through `normalizeSignature`; verify `variables.warnings.test.ts` passes with a typed `requires` backing a guard

## 3. Enforcement

- [x] 3.1 Extend the start check in `src/workflow/turn-boundary.ts` to run `signatureValueIssues` over the turn trigger's `requires`, wording the refusal with the trigger, the variable, the expected type and what arrived; verify a boundary test seeds `quantity: "4"` against `integer` and asserts no model call and the message
- [x] 3.2 Extend the completion check in `src/workflow/middleware.ts` to reject non-conforming typed returns alongside unset ones; verify `middleware.test.ts` rejects `total: "12.50"` declared `number`, naming the state, the variable and the type
- [x] 3.3 Make `archmax_set_variables` (`src/workflow/control-tools.ts`) refuse, atomically, a write of a typed return of the current turn's trigger whose value does not conform; verify `control-tools.test.ts` covers the refusal, the following conforming write, and an undeclared variable written freely

## 4. Delegation

- [x] 4.1 Build `delegationToolSchema` from `signatureJsonSchema` over the target's `manual` `requires` (keeping the locked-variable wording in each description and `additionalProperties: true`), and lead `delegationToolDescription` with the `manual` trigger's `description`; carry `description` and typed entries through `DelegationTarget` and `SubWorkflowRegistry.signature`; verify `workflow-tools.test.ts` pins the typed schema and the description order, and that `instructions` never appear
- [x] 4.2 In `src/workflow/sub-workflow.ts`, refuse a non-conforming argument with the new kind `invalid-param` before composing the child, and settle a child whose typed return does not conform as `invalid-return`; verify `sub-workflow.test.ts` covers both kinds and that `missing-param`/`missing-return` still win for absent names
- [x] 4.3 Make `resolveParams` seed the referenced value itself when an argument is exactly one `${{…}}` reference, keeping text substitution for mixed strings; verify tests for `"${{count}}"` → `3` (number) and `"order ${{order_id}}"` → `"order 7"`, and that an unresolved whole reference still fails `unresolved-param`
- [x] 4.4 Apply the typed signature to mocked children (`applyMock`): a mock's `returns` are held to the declared types like a real child's; verify a mock returning a mistyped value settles `invalid-return`

## 5. Disclosure

- [x] 5.1 Render typed entries in `renderSignature` (`src/workflow/render-prompt.ts`) as `name (type) — description`, bare names unchanged, never the declaration's `description`; verify `render-prompt.test.ts` pins the rendering and `prompt-sections.test.ts` shows the block is identical across the calls of one turn

## 6. Public surface

- [x] 6.1 Export `SIGNATURE_TYPES`, `normalizeSignature`, `signatureForTrigger`, `signatureJsonSchema`, `signatureValueIssues` and their types from `src/public/spec.ts` and the root `src/index.ts` as the same bindings; verify the light-subpath browser-safety walk (`light-subpaths.test.ts`) and the one-binding test pass
- [x] 6.2 Add the new names to the public API surface test and `docs/src/content/docs/reference/public-api.md` (`@archmax-ai/harness/spec` section), with a short "Building a host schema from a signature" example; verify the both-directions documentation check (`index.test.ts`) passes

## 7. Documentation, README and authoring skill

- [x] 7.1 Update `docs/src/content/docs/reference/machine-spec.md` (entry shape, the type table with conformance rules, trigger `description`), `guides/triggers.md` (typed signatures at the boundary, the write check) and `guides/sub-workflows.md` (typed parameters, `invalid-param`/`invalid-return`, whole-reference typing); verify `npm run docs:build` succeeds
- [x] 7.2 Add a changelog entry to `docs/src/content/docs/reference/changelog.md`, noting that hosts must be on this version before specs use typed entries; verify it renders in `npm run docs:build`
- [x] 7.3 Update README.md's signature example to show a typed entry and a trigger `description`; verify the example parses with `archmax validate` on a scratch workflow
- [x] 7.4 Update `skills/archmax-harness/SKILL.md`, `references/workflow-yaml.md` and `references/workflow-schema.md` (typed entries, the type list, when to type, `description` for callers) and `references/backend-integration.md` (building an MCP/OpenAPI schema with `signatureJsonSchema` and validating with `signatureValueIssues`); verify the skill's examples validate with `archmax validate`

## 8. Verification and release

- [x] 8.1 Run `npm run typecheck`, `npm run lint`, `npm test` and `npm run build`; all pass
- [x] 8.2 Validate an example workflow with typed `requires`/`returns` and a delegation between two typed workflows with `archmax validate` and `archmax run --variables '{…}'`, confirming a mistyped variable is refused before any model call
- [x] 8.3 Open the PR labelled `release:minor`, so the release workflow tags and publishes the new minor version pangea's `mcp-trigger` change pins

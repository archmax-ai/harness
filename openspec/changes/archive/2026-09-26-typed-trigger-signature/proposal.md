## Why

A trigger's signature (`requires`/`returns`) names variables and says nothing about what they
hold. That was enough while every caller was a person or a sibling workflow in the same
workspace. A host exposing a workflow to outside callers needs more: a Model Context Protocol
(MCP) tool, a typed start form, or any other API needs a real input and output schema. Today
each host has to invent types beside the SDK's signature, and the delegation tool
`archmax_workflow_<slug>` describes every parameter as an untyped value, so the calling model
has to guess. Declaring the types once, on the signature the runtime already enforces, gives
every ingress the same contract, and the runtime can hold it at the boundary as it already
holds the names.

## What Changes

- A `requires` or `returns` entry MAY be an object `{ name, type?, description? }` beside the
  bare-name spelling, which stays valid and means "untyped". `type` is one of `string`,
  `integer`, `number`, `boolean`, `date`, `date-time`, `object`, `array`: the JSON Schema
  type, or for `date`/`date-time` the JSON Schema string format.
- A trigger declaration MAY carry `description`: what calling that entry does, written for
  a caller. The delegation tool's description leads with the `manual` trigger's `description`.
  The target's `instructions` stay private to the child, as they are today.
- The turn boundary refuses a start whose seeded value for a typed `requires` entry does not
  conform to its type, naming the trigger, the variable, the expected type and what arrived.
  An untyped entry keeps today's rule (any value, `null` included).
- `archmax_set_variables` refuses a write of a declared typed return of the current turn's
  trigger whose value does not conform, as a correctable tool refusal. The completion check
  also rejects a session whose typed return holds a non-conforming value. It already rejects
  one left unset.
- The delegation tool's input schema carries each parameter's type and description. A call
  whose argument does not conform is refused with a new kind `invalid-param` before any
  child runs. An argument that is exactly one `${{…}}` reference takes the referenced
  scalar's own type rather than its string rendering.
- The volatile "Current state" block discloses each signature variable's type and
  description beside its name, for the session's own trigger only (unchanged scope).
- New pure exports on the browser-safe `@archmax-ai/harness/spec` subpath (and the root):
  `SIGNATURE_TYPES`, `normalizeSignature`, `signatureForTrigger`, `signatureJsonSchema`, and
  `signatureValueIssues`. With these a host builds MCP schemas, start forms and request
  validation from exactly the mapping and conformance rules the runtime enforces.
- Not breaking: every existing spec loads and behaves unchanged, because an untyped entry
  keeps today's semantics, and `requiresForTrigger`/`returnsForTrigger` still return names.

## Capabilities

### New Capabilities

_None._ The typed signature extends the existing signature requirements.

### Modified Capabilities

- `workflow-spec`: the trigger declaration gains `description`; signature entries gain `type`
  and `description`; the session boundary, completion and sub-workflow crossing hold the
  types; a typed return is checked when written; one normative signature-to-JSON-Schema
  mapping.
- `delegation`: the call signature is typed and described; `invalid-param` refusal;
  whole-reference arguments keep their scalar type; a child whose typed return does not
  conform settles as `invalid-return`.
- `governance`: the disclosed trigger signature names each variable's type and description.
- `assembly`: the `@archmax-ai/harness/spec` subpath publishes the signature helpers.

## Impact

- **Code**: `src/machine/spec-schema.ts` (entry union, `description`), `src/machine/triggers.ts`
  and `src/machine/machine.ts` (normalized signature, `signatureForTrigger`), a new pure
  `src/machine/signature.ts` (types, JSON Schema mapping, conformance),
  `src/workflow/turn-boundary.ts` (start check), `src/workflow/middleware.ts` (completion
  check), `src/workflow/control-tools.ts` (`archmax_set_variables` write check),
  `src/workflow/workflow-tools.ts` and `src/workflow/sub-workflow.ts` (typed delegation schema,
  `invalid-param`, reference typing), `src/workflow/render-prompt.ts` (typed disclosure),
  `src/public/spec.ts` and `src/index.ts` (exports), `src/machine/lint-spec.ts` (duplicate
  names across both spellings).
- **Public API**: additive: new exports and new `SubWorkflowError` kinds `invalid-param` and
  `invalid-return`. Release as a minor version.
- **Hosts**: pangea adopts this in its `mcp-trigger` change (MCP tool schemas, typed start
  form, request validation) and bumps its three exact pins together.
- **docs/**: `reference/machine-spec.md` (entry shape, `description`, type table),
  `guides/triggers.md` and `guides/sub-workflows.md` (typed signatures, `invalid-param`),
  `reference/public-api.md` (the new `spec` subpath exports, checked in both directions),
  `reference/changelog.md`.
- **README.md**: the signature example shows a typed entry and a trigger `description`.
- **skills/archmax-harness/**: `SKILL.md` and `references/workflow-yaml.md` /
  `references/workflow-schema.md` (typed entries, type list, `description`, when to type),
  `references/backend-integration.md` (building a host schema with `signatureJsonSchema`).

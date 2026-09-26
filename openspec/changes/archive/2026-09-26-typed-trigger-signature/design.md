## Context

A trigger's signature is read in four places today, all by name only:

- `src/machine/spec-schema.ts` — `signatureSchema("requires" | "returns")`, a list of distinct
  variable names whose error message tells the author that "what a variable holds belongs in
  the state instructions".
- `src/workflow/turn-boundary.ts` — refuses a start whose opening variables miss a required name.
- `src/workflow/middleware.ts` — the completion check rejects a session that finishes with a
  declared return unset.
- `src/workflow/workflow-tools.ts` / `src/workflow/sub-workflow.ts` — `delegationToolSchema`
  describes every parameter as `{ description: "Required input '<name>' …" }` with no type;
  `resolveParams` substitutes `${{…}}` references with `resolveText`, which always yields a
  string.

The first host that needs types is pangea's `mcp-trigger` change, which exposes a workflow as
an MCP tool (a JSON Schema `inputSchema`/`outputSchema`), renders a typed start form, and
validates request bodies before a session opens. It has to build those from exactly what this
runtime enforces, so the mapping and the conformance rule have to live here, on the
browser-safe `spec` subpath. See proposal.md for the motivation.

## Goals / Non-Goals

**Goals:**

- One declaration per variable: name, optional type, optional description, in the list the
  runtime already enforces.
- One conformance rule and one JSON Schema mapping, pure and browser-safe, used by every check
  in the runtime and exportable to hosts.
- Every existing spec loads and behaves exactly as before.

**Non-Goals:**

- Optional parameters. `requires` stays "must be supplied". A caller-optional input needs its
  own key and its own semantics at the boundary, which is a separate change.
- Enumerated values (`enum`/options), item schemas for `array`, property schemas for `object`,
  numeric ranges and string patterns. The type list is deliberately the JSON Schema *type*
  level and nothing finer.
- Typing a **state's** `requires` (the exit gate). It guards leaving a state, not the call
  contract, and nothing outside the session reads it.
- Coercion. The runtime never turns `"4"` into `4`; a host that collects text converts it
  before it seeds.

## Decisions

### An entry is a bare name or `{ name, type?, description? }`

```yaml
states:
  intake:
    triggers:
      manual:
        description: Refund one order and report what was refunded.
        requires:
          - order_id
          - { name: due, type: date, description: The day the refund is due. }
        returns:
          - { name: total, type: number, description: Refunded amount in EUR. }
          - approved
```

The union keeps every spec valid (a bare name is the untyped entry) and attaches the type to
the one place the name is declared, in declaration order. Alternatives considered:

- A sibling `types:` map keyed by name, which keeps the lists as strings. Rejected because the
  names would be declared twice, and the two can drift apart: a typed name missing from
  `requires`, or a required name nobody typed. Validation would have to police the agreement
  forever.
- Turning the lists into mappings (`requires: { order_id: {…} }`). Rejected because it gives a
  second spelling for the whole list and breaks every list already written.

The object is **strict** (`name`, `type`, `description` only), unlike the loose declaration
around it. An unknown key inside an entry is most likely a misspelled `type` or `description`,
and it would otherwise silently mean "untyped".

### The type words are JSON Schema's

`string`, `integer`, `number`, `boolean`, `object`, `array` are JSON Schema types. `date` and
`date-time` are its string formats, promoted to types because a host renders and validates them
differently from free text. So the mapping to a JSON Schema (an MCP tool, an OpenAPI body) is the
identity for six words and `{ type: string, format }` for two. The alternative was
product-facing words (`text`, `float`, `datetime`), which read nicer to a person. It was
rejected because every consumer would carry a translation table, and hosts already relabel
tokens for people in their own UI.

### One pure module, `src/machine/signature.ts`

It holds `SIGNATURE_TYPES`, `normalizeSignature` (both spellings to `{ name, type?,
description? }[]`), `signatureForTrigger(spec, id)`, `signatureJsonSchema(entries)` and
`signatureValueIssues(entries, values)`. It depends on nothing but the spec types, so it sits on
`@archmax-ai/harness/spec` and passes the browser-safety walk. `WorkflowMachine` gains
`signatureForTrigger(id)` as a thin delegate over the compiled spec. `requiresForTrigger` and
`returnsForTrigger` keep returning names, derived from the normalized lists, so no caller of
them changes.

`signatureValueIssues` is the only place conformance is decided. It returns issues rather than
throwing, which keeps it total and lets each site word its own refusal:

| Site | Entries | On an issue |
|---|---|---|
| turn boundary | the turn trigger's `requires` | refuse the session (today's refusal, extended) |
| `archmax_set_variables` | the typed `returns` of the current turn's trigger, filtered to the names being written | correctable tool refusal, atomic |
| completion check (`middleware.ts`) | the current turn's trigger's `returns` | reject the session (today's rejection, extended) |
| delegation `check()` | the target's `manual` `requires` | `invalid-param` (missing names stay `missing-param`) |
| child settle | the target's `returns` | `invalid-return` (unset stays `missing-return`) |

Date checks are hand-written (an RFC 3339 full-date regex plus a calendar round-trip, and a
date-time regex with a mandatory offset) rather than `Date.parse`, which accepts
implementation-specific strings and rolls `2026-02-30` over into March.

### `null` does not satisfy a typed entry

Today "set, to any value, `null` included" is what `requires` means, and an untyped entry keeps
that. A typed entry says what the value *is*, and JSON Schema's `integer` does not admit
`null`. A host that validated a caller's body against the published schema would refuse `null`,
so the runtime refuses it too.

### A whole-argument reference keeps its type

`resolveParams` gains one branch: when the argument string is exactly one reference
(`^\$\{\{[^}]+\}\}$`, as `parseReferences` finds it), the resolved **value** is seeded, not its
rendering. Otherwise a typed `integer` parameter could never be supplied by reference. A string
mixing prose and references is still substituted as text, so nothing written today changes
meaning. Only scalars resolve, as the References requirement already says.

### `description` is for callers, not the agent

The trigger declaration's `description` describes the *entry* to whoever calls it: the
delegation tool's model, a host's MCP client, a start form's reader. It is not disclosed in the
session's own prompt, because the session already has its brief (`instructions`), and a
caller-facing sentence there would be a second brief that could contradict the first. Entry
descriptions (per variable) *are* disclosed with the signature, because the agent that must set
`total` benefits from knowing it is "Refunded amount in EUR".

### Disclosure stays deterministic

`renderSignature` renders `name (type) — description` per entry, or the bare name, in
declaration order. It stays in the volatile block with its current scope. Nothing new is added
to the cacheable prefix, so prompt caching is unaffected.

## Risks / Trade-offs

- [A host on an older version reads a typed entry as malformed] → A spec that uses object
  entries needs a host on this version. pangea's `packages/contracts/src/spec.ts` types
  `requires` as `string[]` and must adopt `normalizeSignature` in the same pin bump; its
  `mcp-trigger` change does this. The changelog calls out that authoring typed entries requires
  hosts on this minor version.
- [A strict start refuses a value a lenient host used to send] → Only typed entries are strict,
  and no entry is typed until an author types it.
- [The completion check rejects a session late for a mistyped return] → The write check refuses
  the mistyped value where the agent can correct it, and the typed disclosure tells the agent
  the type up front. So in practice the completion check only catches script and hook writes.
- [Hosts want enums or optional inputs next] → Both are listed non-goals. The entry object is
  strict and additive, so a later `enum` or a separate optional-input key extends it without
  reshaping anything written under this change.

## Migration Plan

Additive; no data or spec migration. Release as a minor version (PR labelled `release:minor`).
Hosts upgrade their pin and may then author typed entries. Rollback is a pin downgrade, which is
safe as long as no authored spec uses object entries yet.

## Why

An `args` guard canonicalizes every argument value as a workspace path before matching it: it
strips a leading `/`, collapses `//`, and applies `.` and `..`. That is right for `file_path` and
wrong for everything else. Probed at 0.8.0:

- **A guard on an empty value fails the turn.** `address2: ["${{p.address2}}"]` with
  `p.address2 = ""` hands picomatch an empty pattern, which throws "Expected pattern to be a
  non-empty string". A literal `[""]` does the same.
- **No URL guard can ever match.** `https://api.example.com/v1/x` becomes
  `https:/api.example.com/v1/x`, while the glob keeps its `//`. The same goes for a stored URL
  matched against itself (`url: ["${{p.url}}"]`), and for `a//b`.
- **Different text matches.** `"/abs"` passes a guard of `["abs"]`.

The canonicalization exists for paths: without it, `./secrets/x` would dodge a denial of
`secrets/**`. The runtime already knows which arguments are paths, from the tool-paths table.

## What Changes

- **An argument the tool declares as a path is matched as a path**, as today. For a tool that
  declares no path argument, that is `file_path`, the same rule `paths:` already follows.
- **Every other argument is matched as text**: its value and the glob as written, with no
  canonicalization. A grant admits a text argument only when its raw value matches. Glob syntax is
  unchanged, so `*` still stops at `/`, and `**` crosses it.
- **A denial on a text argument matches the raw value or its path form.** A denial never gets
  easier to dodge: a host tool's undeclared path argument guarded by a `forbid` still catches
  `./secrets/x`.
- **An empty pattern admits only an empty value.** It never reaches picomatch, so a guard that
  resolves to `""` no longer fails the turn.
- **Behaviour change** for text arguments only: a value whose text differs from the glob's (a
  leading `/`, `//`, a `./` prefix) is no longer admitted by a grant. Path arguments are matched
  exactly as before.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `governance`: "Allow entry shapes and argument guards" matches an argument as a path only when
  the tool declares it one, as text otherwise, and an empty pattern only against an empty value. A
  denial on a text argument matches either form.

## Impact

- **Code**: `src/machine/allow.ts` (`valueMatches` and `argsSatisfy` take which arguments are
  paths, and the empty pattern), the two callers that know the tool (`checkAllowed` in
  `src/machine/machine.ts`, `denialMatches` in `src/kernel/kernel.ts`), and a helper in
  `src/machine/tool-paths.ts` naming a tool's path arguments with their aliases. Tests: unit tests
  in `allow.test.ts`, and a kernel test for each side.
- **Public API**: none.
- **docs/**: `reference/machine-spec.md` (`args` guards: path vs text matching, the empty
  pattern), and a 0.9.0 changelog entry.
- **README.md**: no change (it does not describe guard matching; checked in tasks).
- **skills/archmax-harness/**: `references/workflow-schema.md` and `references/workflow-yaml.md`
  where they describe `args` guards.

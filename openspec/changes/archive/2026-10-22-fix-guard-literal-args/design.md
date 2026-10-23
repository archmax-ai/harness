## Context

See proposal.md for the motivation and the spec delta for the rules.

- **One matcher.** `valueMatches(value, globs)` (`src/machine/allow.ts`) canonicalizes the value
  with `canonicalizeRelPath`, strips a leading `/` from each glob, and calls picomatch with
  `dot: true`. `argsSatisfy` (same file) resolves `${{…}}` references (escaping the substituted
  value) and calls it for each `args` entry. `pathGuardMatches` does the same for `paths:` entries.
- **Two callers, both of which know the tool.** `checkAllowed` (`src/machine/machine.ts`) uses it
  for grants, and `denialMatches` (`src/kernel/kernel.ts`) for denials. Validation decides through
  the same kernel.
- **Which arguments are paths.** The tool-paths table (`src/machine/tool-paths.ts`) knows: a
  tool's declared arguments, read through the built-in aliases (`read_file`'s `path`), and
  `pathArgsOf` already turns that into "declared, else `file_path`" for `paths:`.
- **Probed.** Without canonicalization, picomatch matches a URL, `a//b`, and an escaped stored
  value against itself, and it still refuses `.` and `..` segments (`reports/../x` is not admitted
  by `reports/**`). It throws on an empty pattern.

## Goals / Non-Goals

**Goals:**

- Path arguments are matched exactly as today.
- No text argument is canonicalized in a grant, and no denial gets easier to dodge.

**Non-Goals:**

- Changing glob syntax for text. `*` keeps stopping at `/`: changing that means replacing picomatch
  for text, which changes what `{a,b}` and `[abc]` mean.
- `paths:` entries. They only ever match path arguments, so they don't change.

## Decisions

### The callers say which arguments are paths

`argsSatisfy` gains two inputs: the tool's path argument names and whether it is deciding a grant or
a denial. A small helper in `tool-paths.ts` names the path arguments: `pathArgsOf(paths)` plus the
built-in aliases of those arguments for the tool. `checkAllowed` passes the grant side, and
`denialMatches` the denial side. A dotted key (`args.file_path`) is never a path argument: the
table declares top-level arguments only.

The alternative was to guess from the value (does it contain a `/`?). Rejected: a URL contains one,
and the table already gives the true answer.

### How each kind is matched

`valueMatches` takes the argument's kind:

- **Empty patterns first.** A `""` glob matches only an empty value: the raw value for text, the
  canonical one for a path. It is dropped before picomatch, which would throw on it. A list that
  holds nothing else matches nothing else.
- **Path:** today's matching, unchanged.
- **Text, grant:** picomatch on `String(value)` against the globs as written.
- **Text, denial:** the text match, or today's path match. A denial on an undeclared path argument
  therefore still catches `./secrets/k`, and no denial matches less than it did before.

### Unchanged

Reference resolution and escaping, dotted-key traversal, `dot: true`, and the terminal block for
an unresolvable reference.

## Risks / Trade-offs

- **[A grant on a text argument narrows]** A value with a leading `/`, a `//` or a `./` no longer
  passes a grant written without one. → This only affects arguments the tool doesn't declare as
  paths. A host whose tool takes a path declares it (the documented way to get path rules), and the
  changelog says so.
- **[Prose and enforcement drift]** The model's tool descriptions render the guards. → They render
  the globs as written, which is now exactly what a text grant matches. To confirm while building:
  disclosure doesn't render a canonicalized form anywhere.

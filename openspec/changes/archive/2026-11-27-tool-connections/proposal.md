## Why

A host tool often runs through one of several accounts or APIs the host holds: a REST tool that
reaches either of two APIs, a mail tool that sends from either of two mailboxes. A `tools.allow`
entry already carries a `connection`, but the runtime preserves it without reading it, so a host
can only bind a tool to one connection for a whole workflow, and a state cannot use one tool
through two connections, each with guards of its own. A script cannot say which connection a call
means either.

The connection a call runs through is an argument of the call. Governing it is guard matching,
which the kernel owns: if a host matched it beside the kernel, a second matcher would decide part
of every grant, disclosure would not show it, and the PTC gateway would not apply it to scripts.

## What Changes

- **`toolConnections` on `createAgent`.** A host declares, by tool name, the argument through which
  a tool takes its connection: `toolConnections: { rest__request: "connection" }`. A declaration for
  a built-in or control tool, or an empty argument name, fails assembly with a new
  `ToolConnectionsError`. A tool with no declaration is governed exactly as today, `connection`
  preserved and unread.
- **An entry's `connection` guards that argument.** For a declared tool, an allow entry naming a
  connection admits a call only when the call's argument holds it, and its argument guards then
  apply; an entry naming none admits only a call that names none. A state grants one tool through
  several connections by listing it once per connection, each entry with its own guards, which the
  existing "some entry admits the call" rule already composes. A forbid entry naming a connection
  denies only calls through it.
- **The argument is optional.** A call that leaves it out runs through the one connection the state
  grants the tool through: the runtime sets the argument before governance, and the tool receives
  it. Where the state grants the tool through several connections, such a call is refused, the
  reason naming them. Where no entry names one, the call goes on without it.
- **Disclosure names the connection**: `rest__request(connection=zaepflefinder)`.
- The model's calls and a script's calls through the PTC gateway are governed and defaulted alike,
  in every machine of an assembly, root and delegated.
- Additive: no option, event or message changes shape for a host that declares nothing. Released as
  a minor version.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `governance`: a new requirement, "Tools declare the argument that carries their connection".
- `workflow-spec`: an entry's `connection` is read for a tool declared to take a connection.
- `assembly`: the extension options gain `toolConnections`.

## Impact

- **Code**: `src/machine/allow.ts` (an entry's connection), `src/machine/tool-connections.ts` (the
  declarations and `ToolConnectionsError`), `src/machine/machine.ts` (the table, the grant check,
  the default, disclosure), `src/kernel/kernel.ts` (forbid entries, the refusal's reason),
  `src/workflow/governance.ts` and `src/sandbox/ptc-gateway.ts` (the default before the verdict),
  `src/assembly/` (the option, every machine of the assembly), `src/index.ts` (the error).
- **`docs/`**: `reference/public-api.md` (the option and the error), `reference/machine-spec.md`
  (the entry's `connection`), `guides/workflow-machine.md` (one tool through several connections),
  `reference/changelog.md`.
- **README.md**: the wiring section names `toolConnections` beside `toolPaths`.
- **`skills/archmax-harness/`**: `references/backend-integration.md` (the option) and
  `references/workflow-schema.md` (an entry's `connection` for a declared tool).

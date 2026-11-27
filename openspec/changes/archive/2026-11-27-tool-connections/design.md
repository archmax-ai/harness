## Context

`AllowEntry` is `{ tool, args?, paths?, connection?, source? }`, strict. `WorkflowMachine.checkAllowed`
admits a call when some effective entry names the tool and its argument guards match, so a state
may already list one tool twice. `connection` is shape-checked and never read. Host tools declare
their path arguments through `toolPaths`, a table every machine of the assembly shares, and the
kernel, `validate` and the PTC gateway all read it.

## Decisions

### D-a. A declaration names the argument, per tool

`toolConnections: Record<string, string>`, tool name to argument name, mirrors `toolPaths`: the host
knows which of its tools take a connection and what the argument is called, and a tool whose own
input happens to be named `connection` is simply not declared. Resolved once at assembly into a
table every machine shares (`WorkflowMachine.fromSpec`, `withToolPaths`, the delegation registry).
`ToolConnectionsError` refuses a declaration for a built-in tool (the default tools, `copy_file`,
`move_file`, `remove_file`), a name with the reserved `archmax_` prefix, and an empty argument name.

Not chosen: one global argument name. It would make every host tool with an input of that name
connection-governed, whether or not it takes a connection.

### D-b. An entry's connection is part of its match

`normalizeAllowEntry` carries a non-blank `connection`. For a declared tool, an entry matches a call
only when `args[declared] === entry.connection`, or, for an entry naming none, when the argument is
absent. Argument guards are evaluated after, unchanged. The grant side composes as before (some
entry admits the call), so per-connection guards need nothing new: `{ connection: a, args: { to:
"*@acme.example" } }` beside `{ connection: b }` admits a call through `b` to anyone and a call
through `a` only to Acme.

An entry naming none admits only a call naming none, rather than any connection: an author who
names no connection has not chosen one, and closed-by-default governance does not let the call
choose instead. For an undeclared tool the connection is not read, so nothing changes for a host
that declares nothing.

Forbid entries read the same match: a denial naming a connection denies only calls through it.

### D-c. The default is applied before the verdict, where the call is made

A call that leaves the declared argument out runs through the state's one connection for the tool,
when every effective entry naming the tool names the same connection. `WorkflowMachine.withConnection
(state, tool, args)` returns the arguments with it set, or unchanged. The middleware applies it after
variable substitution and before `decide`, and writes the arguments back into the tool call, so the
tool receives them; the PTC gateway applies it before `decide` and invokes the tool with them. The
kernel therefore always judges what the tool will receive.

A call naming none where the state names several connections matches no entry and is refused as
`tool.not-allowed`; its reason adds which connections the state grants the tool through, so the
model or the script can pass one.

### D-d. Disclosure

`renderEntry` adds `connection=<slug>` beside the guards, so `describeAllowed` reads
`rest__request(connection=a), rest__request(connection=b)`, and the not-allowed reason says the
same thing.

## Risks

- A host that declares a tool and also binds it by other means (its own routing on `connection`)
  sees calls refused that it used to accept; declaring is opt-in, per tool.

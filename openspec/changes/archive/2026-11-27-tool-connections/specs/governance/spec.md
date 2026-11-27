## ADDED Requirements

### Requirement: Tools declare the argument that carries their connection

A host SHALL declare, through `createAgent`'s `toolConnections`, the argument through which one of
its tools takes the connection a call runs through, by tool name:
`toolConnections: { rest__request: "connection" }`. A declaration for a built-in tool, for a name
with the reserved `archmax_` prefix, or with an empty argument name SHALL fail assembly with
`ToolConnectionsError`. Every machine of an assembly, root and delegated, SHALL govern by the same
declarations. For a tool with no declaration, an entry's `connection` SHALL be preserved and not
read.

For a declared tool, an allow or forbid entry's `connection` SHALL be part of what it matches:

- an entry naming a connection SHALL match a call only when the call's declared argument holds that
  connection, and its argument guards SHALL then apply as for any entry;
- an entry naming none SHALL match only a call that leaves the argument out.

A call SHALL be admitted when some effective entry of the state admits it, so a state that allows
one tool once per connection grants each connection with that entry's guards. A forbid entry naming
a connection SHALL deny only calls through that connection.

The argument SHALL be optional for the call. A call that leaves it out SHALL run through the
connection the state grants the tool through when every effective entry naming the tool names that
one connection: the runtime SHALL set the argument before the call is governed, and the tool SHALL
receive it. Where the state's entries name more than one connection, a call that leaves it out SHALL
be refused with `tool.not-allowed`, the reason naming the connections the state grants the tool
through. Where no entry names one, the call SHALL be governed as it stands. The model's calls and a
script's calls through the governed tool bridge SHALL be defaulted and governed alike. Disclosure
SHALL render an entry's connection beside its guards: `rest__request(connection=zaepflefinder)`.

#### Scenario: One state, one tool, two connections

- **WHEN** the host declares `toolConnections: { rest__request: "connection" }` and a code state
  allows `{ tool: rest__request, connection: nominatim }` and `{ tool: rest__request, connection: zaepflefinder }`
- **THEN** a script call `tools.rest__request({ connection: "zaepflefinder", path: "" })` is admitted
  and the tool receives `connection: "zaepflefinder"`
- **AND** a call naming `other` is blocked with `tool.not-allowed`

#### Scenario: Each entry's guards bind its own connection

- **WHEN** a state allows `{ tool: send_email, connection: support, args: { to: "*@acme.example" } }`
  and `{ tool: send_email, connection: sales }`, and `send_email` is declared to take `connection`
- **THEN** a call through `support` to `someone@other.example` is blocked, and the same call through
  `sales` is admitted

#### Scenario: A call leaving the connection out runs through the state's one connection

- **WHEN** a state allows only `{ tool: rest__request, connection: nominatim }` and the model calls
  `rest__request` with `{ path: "search" }`
- **THEN** the call is admitted and the tool receives `{ path: "search", connection: "nominatim" }`

#### Scenario: Leaving the connection out where the state grants two

- **WHEN** a state allows `rest__request` through `nominatim` and through `zaepflefinder`, and a call
  leaves `connection` out
- **THEN** the call is blocked with `tool.not-allowed`, and the reason names `nominatim` and
  `zaepflefinder`

#### Scenario: An entry naming no connection

- **WHEN** a state allows `rest__request` with no `connection`
- **THEN** a call leaving the argument out is admitted as it stands, and a call naming `nominatim`
  is blocked with `tool.not-allowed`

#### Scenario: A denial of one connection

- **WHEN** the root declares `tools: { forbid_always: [{ tool: send_email, connection: personal }] }`
  and a state allows `send_email` through `personal` and through `sales`
- **THEN** a call through `personal` is blocked with `tool.forbidden`, and a call through `sales` is
  admitted

#### Scenario: An undeclared tool ignores the connection

- **WHEN** the host declares no connection argument for `lookup` and a state allows
  `{ tool: lookup, connection: crm }`
- **THEN** a call of `lookup` with any arguments is admitted as the entry's guards say, and the
  runtime neither reads nor sets a connection

#### Scenario: A built-in tool cannot be declared

- **WHEN** a host passes `toolConnections: { read_file: "connection" }`
- **THEN** assembly throws `ToolConnectionsError`

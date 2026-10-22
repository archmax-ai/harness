## MODIFIED Requirements

### Requirement: Allow entry shapes and argument guards

An entry in `tools.allow` or `tools.allow_always` SHALL be a bare tool name (any arguments),
`{ tool, args: { <param>: [globs] } }` matching each named parameter (dotted keys read nested
arguments), or `{ tool, paths: [...] }`, which guards **every path argument the tool declares**
(see "Tools declare their path arguments"): a grant admits a call only when each declared path the
call names matches one of the globs, and a declared path the call omits matches nothing. For a tool
that declares no path argument, `paths:` SHALL guard `file_path`. An entry without `args`/`paths`
SHALL match any arguments.

An argument SHALL be matched as a **path** when the tool declares it one (or names it through a
built-in alias, such as `path` for `read_file`), and, for a tool that declares no path argument,
when it is `file_path`. A path value SHALL be canonicalized (leading slashes stripped, `.` and empty
segments dropped, `..` applied) before it is matched, so a `./` or `..` spelling cannot dodge a
guard. Every other argument SHALL be matched as **text**: in a grant, its value as given against the
globs as written, with nothing canonicalized; in a denial (`tools.forbid`, `tools.forbid_always`),
the value as given or its canonical path form, either matching, so treating an argument as text
never makes a denial easier to dodge. Glob syntax SHALL be the same for both: `*` does not cross a
`/`, and `**` does. An empty pattern, written or resolved from a `${{…}}` reference, SHALL match
only an empty value and SHALL never fail the call.

#### Scenario: Argument glob

- **WHEN** a state allows `{ tool: alpha, args: { q: ["ok-*"] } }`
- **THEN** `alpha({ q: "ok-1" })` is permitted and `alpha({ q: "bad" })` is blocked

#### Scenario: A paths grant needs every declared path

- **WHEN** a state allows `{ tool: copy_file, paths: ["skills/**", "reports/**"] }`
- **THEN** a copy from `skills/data/t.md` to `reports/t.md` is permitted and a copy to `drafts/t.md`
  is blocked with `tool.not-allowed`

#### Scenario: A paths guard on a search tool guards its own path argument

- **WHEN** a state allows `{ tool: grep, paths: ["reports/**"] }`
- **THEN** `grep({ pattern, path: "reports/q3" })` is permitted and `grep({ pattern, path: "drafts" })`
  is blocked

#### Scenario: A URL is matched as text

- **WHEN** a state allows `{ tool: fetch, args: { url: ["https://api.example.com/**"] } }`
- **THEN** `fetch({ url: "https://api.example.com/v1/orders" })` is permitted and
  `fetch({ url: "https://evil.example.com/v1/orders" })` is blocked

#### Scenario: A stored value matches itself

- **WHEN** a state allows `{ tool: update_address, args: { line: ["${{p.line}}"] } }` and `p.line` is
  `"Unit 4//B"`
- **THEN** `update_address({ line: "Unit 4//B" })` is permitted and `update_address({ line: "Unit 4/B" })`
  is blocked

#### Scenario: An empty value is guarded, not fatal

- **WHEN** a state allows `{ tool: update_address, args: { address2: ["${{p.address2}}"] } }` and
  `p.address2` is `""`
- **THEN** `update_address({ address2: "" })` is permitted, `update_address({ address2: "Suite 4" })`
  is blocked, and the turn goes on

#### Scenario: A path argument is still canonicalized

- **WHEN** a state allows `{ tool: write_file, args: { file_path: ["reports/**"] } }`
- **THEN** `write_file({ file_path: "./reports/q3.md" })` is permitted and
  `write_file({ file_path: "reports/../secrets/k" })` is blocked

#### Scenario: A denial on a text argument catches either form

- **WHEN** the root declares `tools: { forbid_always: [{ tool: sync, args: { target: ["secrets/**"] } }] }`
  for a host tool that declares no path argument, and the state grants `sync`
- **THEN** `sync({ target: "secrets/k" })` and `sync({ target: "./secrets/k" })` are both blocked

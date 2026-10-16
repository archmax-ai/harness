## MODIFIED Requirements

### Requirement: Authored mounts are a consumer-composed route table

Authored content SHALL reach the agent only through the `workspace.mounts` route table the consumer composes — key to backend, or `{ backend, readOnly, governed, searchable }` — never through inspection of the workspace or a built-in list of directory names. A key ending in `/` SHALL be a **directory mount**, expressed as a composite route with its prefix stripped before delegation and re-applied to result paths; a key without a trailing slash (`/AGENTS.md`) SHALL be an **exact-path file mount**, routed by the workspace router so `AGENTS.md.bak` is not captured. Keys SHALL be normalized (one leading slash, collapsed separators) so equivalent spellings name one mount. A backend rooted at the mounted directory SHALL need no adaptation; the exported `mountSubtree(backend, prefix)` SHALL rebase one backend serving several mounts, mapping paths in both directions so results are never double-prefixed. Authored paths SHALL be addressed exactly as authors write them (`skills/order-data/assets/orders.json`).

A mount declared `governed: true` SHALL be visible to a state only where the spec's `mounts` lists enable it (see `governance`); a mount not so declared SHALL be visible in every state, so a consumer that marks nothing composes exactly the workspace it composes today. The consumer owns which backend serves a mount, its write posture, whether it is governed and whether it is searchable; the spec owns which states enable it, and whether each of those states may write there. Neither SHALL be inferred from the other. `readOnly` SHALL be a **ceiling** rather than a default: a governed mount the consumer serves writable SHALL be written only by a workflow whose own grants ask `access: read_write` for it, a spec grant may narrow it to reads in a state (`access: read`), and no grant SHALL open one the consumer serves read-only.

A directory mount declared `searchable: false` SHALL be a mount the runtime never searches on its own initiative (see "Search dispatch honours a mount's search posture"); a mount not so declared SHALL be searchable, which is what every table without the flag resolves to. The resolved mount SHALL carry the posture, and the names of unsearchable directory mounts SHALL arrive as `MountPrefixes.unsearchable`. On a file mount the flag SHALL be ignored — a file is never searched as a tree — and the name SHALL NOT appear in `MountPrefixes.unsearchable`. Search posture SHALL NOT be a governance concern: the kernel, the listing redaction and `archmax validate` SHALL neither read it nor report on it.

When `mounts` is omitted on the default filesystem backend, the exported `defaultMounts(rootDir)` SHALL apply: `/skills/` and `/.platform/` as filesystem backends rooted at those directories, plus the `/AGENTS.md` file served from the root, none of them governed. It SHALL be a default value only — nothing classifies or validates against those names — and SHALL include no `/workflows/` mount. A conventional directory that does not exist SHALL NOT be an error. When `mounts` is omitted with a custom `backend`, nothing authored SHALL be served.

#### Scenario: Directory mount from a rooted backend

- **WHEN** a consumer mounts `"/skills/"` to a backend rooted at the workspace's `skills` directory and the agent lists `skills/`
- **THEN** every returned path appears once, as `skills/<entry>`, matching the path a subsequent read accepts

#### Scenario: Exact-path file mount

- **WHEN** the table contains `/AGENTS.md`
- **THEN** `AGENTS.md` is served from that mount and `AGENTS.md.bak` is not

#### Scenario: Several mounts from one backend

- **WHEN** a consumer mounts `"/skills/"` and `"/data/"` through `mountSubtree(backend, "skills")` and `mountSubtree(backend, "data")`
- **THEN** each mount serves its own subtree and result paths come back in workspace form

#### Scenario: A governed mount from the same backend

- **WHEN** a consumer mounts `"/reference/"` as `{ backend: mountSubtree(store, "reference"), governed: true }` beside an ungoverned `"/skills/"`
- **THEN** `reference` appears in the resolved `MountPrefixes.governed`, `skills` does not, and both are served by their backends where the spec enables them

#### Scenario: A governed writable mount the spec may narrow

- **WHEN** a consumer mounts `"/shared/"` as `{ backend, readOnly: false, governed: true }`
- **THEN** `shared` appears in both `MountPrefixes.writable` and `MountPrefixes.governed`, a workflow granting it `{ mount: shared, access: read_write }` may write there, one granting it only by name may not, and a state enabling it as `{ mount: shared, access: read }` may not

#### Scenario: An unsearchable mount is resolved

- **WHEN** a consumer mounts `"/contracts/"` as `{ backend, governed: true, searchable: false }` beside `"/skills/"`
- **THEN** `contracts` appears in `MountPrefixes.unsearchable` and in `MountPrefixes.governed`, `skills` appears in neither, and the resolved `contracts` mount carries `searchable: false`

#### Scenario: The flag is inert on a file mount

- **WHEN** a consumer mounts `"/AGENTS.md"` as `{ backend, searchable: false }`
- **THEN** assembly succeeds, `AGENTS.md` is served exactly as before, and `MountPrefixes.unsearchable` does not contain it

#### Scenario: Extending the default

- **WHEN** a consumer spreads `defaultMounts(rootDir)` and adds `"/templates/"`
- **THEN** the conventional mounts and `templates/` are all served

#### Scenario: Custom backend serves nothing by default

- **WHEN** `createAgent({ backend, workspace: { sessionStore } })` is called with no `mounts`
- **THEN** no authored path is served to the agent until the consumer mounts one

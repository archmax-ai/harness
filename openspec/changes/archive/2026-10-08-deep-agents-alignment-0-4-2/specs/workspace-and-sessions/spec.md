## MODIFIED Requirements

### Requirement: Search dispatch honours a mount's search posture

The workspace router SHALL dispatch `grep` and `glob` by where the search is addressed, after the usual canonicalization. A search whose path is the root, an ancestor of a mount, a session path, or a path inside a **searchable** mount SHALL be served by a composite over the searchable directory routes only — the same default route, the same longest-prefix routing and the same prefix re-application as every other operation — so an unsearchable mount contributes neither matches nor an error to it. A search whose path is an **unsearchable** mount or a path inside it SHALL be delegated directly to that mount's backend with the route-relative path (`/` for the mount itself), and the backend's result SHALL be returned verbatim: matches and files re-prefixed into workspace form, an `{ error }` untouched, so the backend's own refusal reaches the caller. The routing mount of a search path SHALL be determined by longest prefix across every directory mount, so a searchable mount nested inside an unsearchable one is still searched, and vice versa. `ls`, `read`, `readRaw`, `write` and `edit` SHALL be unaffected: a listing of the root still shows an unsearchable mount, and its files read as before.

A `grep`'s match cap — the fourth argument, `maxCount`, which Deep Agents' `grep` tool passes as the call's `max_count` or its default of 1,000 — SHALL reach the backend of every route a search is served by: the session zone, a directory mount, a `mountSubtree` mount and a read-only mount alike. The total SHALL be capped and marked `truncated: true` when the cap is hit: by the composite on a search it serves, and by the router on a search delegated to an unsearchable mount, so a backend that ignores the cap still answers within it.

With no unsearchable mount in the table, the search composite SHALL be the routing composite itself, so every existing table behaves byte-identically. The behaviour SHALL hold for every caller of the workspace backend — an agent tool, a hook or sandbox script's `tools.*` bridge, and the runtime's own discovery — since all of them reach the router.

The model-facing prompt SHALL disclose the posture wherever it names the mount: the "Mounts available in this state" section for a governed unsearchable mount, and the static "Workspace zones" section for an ungoverned one, SHALL mark it browse-only — list and read it, do not search it — and SHALL be unchanged for a table with no unsearchable mount.

#### Scenario: A root-wide grep survives a refusing mount

- **WHEN** the table is `{ "/skills/": skills, "/contracts/": { backend: contracts, governed: true, searchable: false } }`, the `contracts` backend answers every `grep` with `{ error }`, and the agent greps `x` at `/`
- **THEN** the result carries the matches from the session zone and `skills/`, no error, and the `contracts` backend's `grep` is never called

#### Scenario: A root-wide glob survives a refusing mount

- **WHEN** the same table's `contracts` backend answers every `glob` with `{ error }` and the agent globs `**/*.md` at `/`
- **THEN** the result lists the session zone's and `skills/` files and the `contracts` backend's `glob` is never called

#### Scenario: A grep addressed at the mount reaches its backend

- **WHEN** the agent greps `x` at `/contracts/`
- **THEN** the `contracts` backend receives `grep("x", "/")` and its `{ error }` is returned to the agent verbatim

#### Scenario: A glob inside the mount reaches its backend

- **WHEN** the agent globs `**/*.md` at `/contracts/2026`
- **THEN** the `contracts` backend receives `glob("**/*.md", "/2026")` and its `{ error }` is returned to the agent verbatim

#### Scenario: An addressed search that succeeds comes back in workspace form

- **WHEN** the `contracts` backend answers `grep("x", "/2026")` with a match at `/2026/a.md`
- **THEN** the agent's grep at `contracts/2026` returns that match at `contracts/2026/a.md`

#### Scenario: A grep's cap reaches every route

- **WHEN** the agent greps with `max_count: 2` over five matching lines in the session zone, on a directory mount, on a `mountSubtree` mount, and on an unsearchable mount whose backend ignores the cap
- **THEN** each search returns the first two matches and Deep Agents' note that the search stopped at the cap

#### Scenario: A search under its cap is whole

- **WHEN** the agent greps with `max_count: 5` over five matching lines
- **THEN** all five matches are returned and no truncation note is added

#### Scenario: The mount still lists and reads

- **WHEN** the agent lists `/` or reads `contracts/2026/a.md`
- **THEN** `contracts/` appears in the root listing and the read is served by the `contracts` backend as before

#### Scenario: An ancestor path skips the mount

- **WHEN** the table mounts `/catalogs/eu/` as `{ backend, searchable: false }` and the agent greps `x` at `/catalogs`
- **THEN** the search is served without calling the `eu` backend

#### Scenario: Longest prefix decides the routing mount

- **WHEN** the table mounts `/data/` as `{ backend: a, searchable: false }` and `/data/public/` as `{ backend: b }`, and the agent greps `x` at `data/public/reports`
- **THEN** backend `b` serves the search with path `/reports`, and backend `a` is not called

#### Scenario: Tables without the flag are unchanged

- **WHEN** no mount in the table declares `searchable: false`
- **THEN** `grep` and `glob` at every path produce the same result they produce today, including an error a searchable mount returns on a root-wide search

#### Scenario: The prompt marks an unsearchable mount

- **WHEN** a state enables the governed mount `contracts` declared `searchable: false`
- **THEN** its line in "Mounts available in this state" says the mount is browse-only, and a table without the flag renders the section exactly as before

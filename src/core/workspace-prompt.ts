import {
  NO_MOUNTS,
  SESSION_OFFLOAD_DIRS,
  SESSION_OPEN_DIR,
  type MountPrefixes,
} from "./zones.js";

/**
 * The system prompt's account of the workspace, **rendered from the assembly's
 * resolved mount table** rather than written by hand.
 *
 * The same reason the graph section is rendered from the loaded spec: prose about
 * enforcement drifts from enforcement. A hand-maintained list of mounts in the
 * platform prompt has to be edited every time a consumer's mount table changes,
 * and when it is not, the agent is told it has directories that do not exist —
 * it then reads a missing path while faithfully quoting its own instructions.
 * Deriving the list from {@link MountPrefixes} (the very keys the composite
 * routes on and the kernel classifies against) makes that unrepresentable.
 *
 * Consumer-declared mounts are the workspace's shape, so a custom platform prompt
 * inherits an accurate description without restating one.
 */

/**
 * Mount names as the agent addresses them: directories with a trailing slash,
 * file mounts by their exact path, each in backticks and alphabetically ordered
 * so the rendered prompt is stable across assemblies of the same table.
 *
 * Dot-prefixed mounts are omitted: `.platform/` and its kind carry the runtime's
 * own inputs (the platform prompt the agent is already reading), not authored
 * content it should go looking through.
 *
 * **Governed** mounts are omitted too, and for a load-bearing reason: which of
 * them a state reaches varies, and this section is part of the cacheable prefix,
 * which does not. They are disclosed where they apply, in the volatile "Current
 * state" block (see `renderMountsSection`).
 */
function mountNames(mounts: MountPrefixes, writable: boolean): { label: string; browseOnly: boolean }[] {
  const isWritable = (name: string) => mounts.writable.includes(name);
  const pick = (names: readonly string[]) =>
    names.filter(
      (name) =>
        !name.startsWith(".") &&
        !mounts.governed.includes(name) &&
        isWritable(name) === writable,
    ).sort();
  const entry = (name: string, label: string) => ({
    label,
    // Only a directory mount is ever unsearchable (`resolveMounts` lists no file).
    browseOnly: mounts.unsearchable.includes(name),
  });
  return [
    ...pick(mounts.dirs).map((name) => entry(name, `\`${name}/\``)),
    ...pick(mounts.files).map((name) => entry(name, `\`${name}\``)),
  ];
}

/**
 * Render the "Workspace zones" section of the system prompt for one assembly's
 * resolved mounts. Every name it prints is a route the workspace actually
 * serves; a workspace with no mounts simply gets no mount bullets.
 */
export function renderWorkspaceZones(mounts: MountPrefixes = NO_MOUNTS): string {
  const offload = SESSION_OFFLOAD_DIRS.map((dir) => `\`${dir}/\``).join(", ");
  const readOnly = mountNames(mounts, false);
  const writable = mountNames(mounts, true);

  const bullets = [
    `- **\`${SESSION_OPEN_DIR}/\`** — your working area: intermediate files and the ` +
      `artifacts you produce. Always readable and writable, whatever state you are in.`,
    `- **${offload}** — where the runtime parks oversized tool results and ` +
      `history. Read them when handed a path (paginate with \`read_file\` offset/limit); ` +
      `you cannot write there.`,
  ];

  if (readOnly.length + writable.length > 0) {
    // One bullet per mount, each with its posture, rather than two prose groups:
    // the agent addresses a mount by name, so the name is what must carry whether
    // it can be written. Same vocabulary as the volatile per-state listing.
    const notes: string[] = [];
    if (readOnly.length > 0) {
      notes.push("A `read-only` mount refuses writes; read it freely.");
    }
    if (writable.length > 0) {
      notes.push(
        `A \`read/write\` mount is as open to you as \`${SESSION_OPEN_DIR}/\`: write there when ` +
          `the work belongs outside this run, and the write is checked against the active ` +
          `state's tool rules like any other. It outlives the run, so keep scratch files out.`,
      );
    }
    if ([...readOnly, ...writable].some((m) => m.browseOnly)) {
      notes.push(
        "A `browse only` mount is listed and read, never searched: a search from the root " +
          "leaves it out, and a search addressed at it is answered by the mount itself.",
      );
    }
    const line = (posture: string) => (m: { label: string; browseOnly: boolean }) =>
      `  - **${m.label}** — ${posture}${m.browseOnly ? ", browse only" : ""}`;
    bullets.push(
      `- **Mounts** — authored content beside the run, each marked with what you may do there:`,
      ...readOnly.map(line("read-only")),
      ...writable.map(line("read/write")),
      // Indented, so it reads as the rest of the bullet rather than a new one.
      `  ${notes.join(" ")}`,
    );
  }
  bullets.push(
    `- **Any other path in the root** belongs to this run and is governed by the ` +
      `active state's tool rules: write one only where the state's spec allows it.`,
  );
  if (mounts.governed.length > 0) {
    // Named nowhere here on purpose: which of them this state reaches is in the
    // volatile block, so this prefix stays byte-identical across states.
    bullets.push(
      `- **Some mounts are given per state.** The ones available where you are now are ` +
        `listed under "Mounts available in this state" in the "Current state" block; a path ` +
        `under any other is blocked here.`,
    );
  }

  return [
    "## Workspace zones",
    "",
    "Your workspace root **is this run** — writable and private to it. Authored",
    "content is mounted beside it, read-only unless a mount below says otherwise.",
    "",
    ...bullets,
  ].join("\n");
}

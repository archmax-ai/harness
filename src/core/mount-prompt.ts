import type { MountPrefixes } from "./zones.js";

/**
 * The model-facing account of the governed mounts a state may reach — the mount
 * twin of `renderSkillsSection`, and in the **volatile** system block for the
 * same reason: what varies with the state cannot live in the cacheable prefix.
 *
 * The static "Workspace zones" section therefore names ungoverned mounts only
 * (see {@link renderWorkspaceZones}), and this names what this state was given.
 * A state that reaches none gets no heading rather than an empty one, and
 * therefore no invitation to go looking.
 */

/** Heading of the rendered section, also the marker tests assert on. */
export const MOUNTS_SECTION_HEADING = "Mounts available in this state";

/**
 * Render the section for one state's enabled governed mounts, or `null` when the
 * set is empty.
 *
 * `enabled` is the resolved name order (see `WorkflowMachine.enabledMounts`),
 * sorted here so the text is stable under a spec edit that only reorders a
 * list — a prompt section that reordered itself would churn the transcript for
 * no reason. Each name is printed as the agent addresses it: a directory mount
 * with a trailing slash, a file mount by its exact path, read-only or read/write
 * per `writable` — the state's own posture (`WorkflowMachine.mountWritable`),
 * which a grant's `access: read` may have narrowed below the host's. A mount the
 * host declared unsearchable gets a browse-only note, so the model lists and
 * reads it rather than searching it; every other line is unchanged.
 */
export function renderMountsSection(
  enabled: readonly string[],
  mounts: MountPrefixes,
  writable: (name: string) => boolean,
): string | null {
  const files = new Set(mounts.files);
  const bullets = [...enabled].sort().map((name) => {
    const address = files.has(name) ? name : `${name}/`;
    // The state's own posture, not the table's: a grant may narrow a writable
    // mount to reads here, and the prompt has to say what this state can do.
    const posture = writable(name)
      ? "read/write — write there directly when the work belongs there, no less " +
        "freely than in your own working area; the write is checked against this " +
        "state's tool rules like any other"
      : "read-only — read it freely, writes there are blocked";
    const browse = mounts.unsearchable.includes(name)
      ? " Browse only: list and read it directly. Searches from the root leave it out, " +
        "and a search addressed at it is answered by the mount itself."
      : "";
    return `- **\`${address}\`** — ${posture}.${browse}`;
  });
  if (bullets.length === 0) return null;
  return [
    `## ${MOUNTS_SECTION_HEADING}`,
    "",
    ...bullets,
    "",
    `Only these mounts are reachable from this state: every other mount's files are blocked ` +
      `here, whatever an earlier state could read.`,
  ].join("\n");
}

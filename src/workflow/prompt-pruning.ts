/**
 * Pruning of upstream Deep Agents prompt guidance for built-in tools an
 * assembly withholds: guidance for a tool the model cannot call only teaches it
 * to try.
 */

/**
 * Upstream section headings owned by a built-in tool's guidance.
 *
 * `task`'s guidance is two sections, and both must be named: the spawner
 * overview carries the bulk of it, and the notes section follows. A partial
 * match counts as a successful prune, so listing only one of them silently ships
 * the other.
 */
const SECTIONS_BY_TOOL: Record<string, readonly string[]> = {
  task: ["## `task` (subagent spawner)", "## Important Task Tool Usage Notes to Remember"],
};

/** The upstream headings that document `tool`'s guidance (empty when unknown). */
export function upstreamSectionsFor(tool: string): readonly string[] {
  return SECTIONS_BY_TOOL[tool] ?? [];
}

export interface PruneResult {
  /** The prompt text with matched sections removed. */
  text: string;
  /** Headings that were found and removed. */
  removed: string[];
  /**
   * Tools whose guidance was found nowhere. A partial match is a successful
   * prune (upstream may carry only some of a tool's sections).
   */
  missingTools?: string[];
}

/** A section spans its heading line to the next heading of the same or higher level. */
function sectionEnd(lines: string[], start: number, level: number): number {
  for (let i = start + 1; i < lines.length; i++) {
    const match = /^(#{1,6})\s/.exec(lines[i]!);
    if (match && match[1]!.length <= level) return i;
  }
  return lines.length;
}

function headingLevel(heading: string): number {
  return /^(#{1,6})\s/.exec(heading)?.[1]!.length ?? 2;
}

/**
 * Put a target heading on its own line when composition glued it to the end of
 * the previous one.
 *
 * Upstream concatenates its prompt fragments without a separating newline, so a
 * section can arrive as `…within files## \`task\` (subagent spawner)`. Matching is
 * line-anchored (a `##` mid-sentence is prose, not a heading), so without this
 * the section is silently kept and billed on every call. Narrow by construction:
 * only a heading we were asked to remove is ever split out.
 */
function unglueHeadings(text: string, headings: readonly string[]): string {
  let out = text;
  for (const heading of headings) {
    let at = out.indexOf(heading);
    while (at > 0) {
      if (out[at - 1] !== "\n") {
        out = `${out.slice(0, at)}\n${out.slice(at)}`;
        at += 1;
      }
      at = out.indexOf(heading, at + heading.length);
    }
  }
  return out;
}

/** Remove each heading's section. Matching is exact on the trimmed heading line. */
function pruneSections(text: string, headings: readonly string[]): PruneResult {
  if (!text || headings.length === 0) return { text, removed: [] };
  const removed: string[] = [];
  let lines = unglueHeadings(text, headings).split("\n");
  for (const heading of headings) {
    const index = lines.findIndex((line) => line.trim() === heading);
    if (index === -1) continue;
    const end = sectionEnd(lines, index, headingLevel(heading));
    lines = [...lines.slice(0, index), ...lines.slice(end)];
    removed.push(heading);
  }
  // Collapse the blank runs left behind so the result is byte-stable however many sections were cut.
  return { text: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(), removed };
}

/** Prune the upstream guidance for every tool in `undisclosed`; tools with no known sections are ignored. */
export function pruneUndisclosedToolSections(
  text: string,
  undisclosed: readonly string[],
): PruneResult {
  const result = pruneSections(text, undisclosed.flatMap((tool) => [...upstreamSectionsFor(tool)]));
  const missingTools = undisclosed.filter((tool) => {
    const owned = upstreamSectionsFor(tool);
    return owned.length > 0 && !owned.some((heading) => result.removed.includes(heading));
  });
  return { ...result, ...(missingTools.length > 0 ? { missingTools } : {}) };
}

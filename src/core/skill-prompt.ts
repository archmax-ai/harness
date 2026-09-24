import type { SkillDefinition, SkillRegistry } from "./skills.js";

/**
 * The model-facing account of the skills a state may use — rendered by the
 * runtime rather than delegated to the upstream skills middleware.
 *
 * Upstream renders one section, once, from a whole source directory: its
 * `sources` are fixed at construction and its result is cached in a closure, so
 * nothing about it can vary per state. Under a governed workflow that is exactly
 * the wrong shape — a state that may use one capability would be told about
 * three, two of which the kernel refuses. So the runtime renders this instead,
 * from the same resolved set the kernel enforces, into the **volatile** system
 * block (see `workflow/middleware.ts`), which is where anything that changes
 * with the state belongs.
 *
 * What it says is the Agent Skills progressive-disclosure contract itself and
 * nothing more: the slug, what the skill is for, and where to read the rest.
 */

/** Heading of the rendered section, also the marker tests assert on. */
export const SKILLS_SECTION_HEADING = "Skills available in this state";

/**
 * Render the section for one state's enabled skills, or `null` when the set is
 * empty — a state that may use no skill gets no heading rather than an empty
 * one, and therefore no invitation to go looking.
 *
 * `enabled` is the resolved slug order (see `WorkflowMachine.enabledSkills`), so
 * the text is byte-identical on every model call of a turn and on every
 * re-entry: a prompt section that reordered itself would churn the transcript
 * for no reason. A slug with no registry entry is skipped rather than rendered
 * as a bare name — the description is the whole value of disclosing it.
 */
export function renderSkillsSection(
  enabled: readonly string[],
  registry: SkillRegistry,
): string | null {
  const skills = enabled
    .map((slug) => registry.get(slug))
    .filter((skill): skill is SkillDefinition => skill !== undefined);
  if (skills.length === 0) return null;

  const bullets = skills.map(
    (skill) => `- **\`${skill.slug}\`** — ${oneLine(skill.description)} Read \`${skill.skillFile}\` first.`,
  );
  return [
    `## ${SKILLS_SECTION_HEADING}`,
    "",
    ...bullets,
    "",
    `Only these skills are reachable from this state: every other skill's files are blocked here, ` +
      `whatever an earlier state could read.`,
  ].join("\n");
}

/**
 * Collapse a description to one line and end it with a sentence terminator, so a
 * multi-line `description:` cannot break the bullet list it is rendered into.
 */
function oneLine(description: string): string {
  const text = description.replace(/\s+/g, " ").trim();
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

import { redactListing } from "./listing-redact.js";
import { skillOfPath, type SkillPrefixes } from "./skills.js";

/**
 * Keep a disabled skill out of a *listing*, not just out of a read — the skills
 * half of the shared listing filter (`core/listing-redact.ts`, which carries the
 * reasoning and the line shapes).
 */

/**
 * Drop from `text` every line about a skill bundle absent from `enabled`.
 *
 * Returns the text unchanged when nothing was hidden — including the whole
 * no-skills and no-hidden-bundle cases — so a result the filter has no opinion
 * about is passed through by identity rather than rebuilt.
 */
export function redactDisabledSkills(
  text: string,
  enabled: readonly string[],
  skills: SkillPrefixes,
): string {
  if (skills.length === 0 || !text) return text;
  const allowed = new Set(enabled);
  // Nothing to hide: every discovered bundle is enabled here.
  if (skills.every((skill) => allowed.has(skill.slug))) return text;
  return redactListing(
    text,
    (path) => skillOfPath(path, skills),
    (slug) => !allowed.has(slug),
  );
}

// The filtered tools are a property of the listing shapes, not of skills;
// re-exported here so existing callers reach it from either module.
export { REDACTED_TOOLS } from "./listing-redact.js";

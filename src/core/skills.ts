import { MAX_SKILL_DESCRIPTION_LENGTH, MAX_SKILL_NAME_LENGTH } from "deepagents";
import {
  createWorkflowEventEmitter,
  type WorkflowEventHandler,
} from "./events.js";
import { parseFrontmatter } from "./frontmatter.js";
import { Workspace, canonicalizeRelPath, dirName, normalizeRelPath } from "./workspace.js";
import { isSlug } from "../machine/slug.js";

/**
 * The skill registry: what skills a workspace provides, resolved **once per
 * assembly** from the declared skill sources and read through the backend like
 * every other authored input.
 *
 * It exists because three components have to agree about the same three facts —
 * which slugs exist, where each bundle lives, and what to say about it:
 *
 * - **disclosure** names the active state's skills in the prompt,
 * - the **decision kernel** refuses a path inside a bundle the state does not
 *   enable,
 * - **`archmax validate`** reports a `skills.allow` entry no bundle provides.
 *
 * Deriving all three from one resolved table is the same move the mount table
 * makes (`core/mounts.ts` → {@link MountPrefixes}): a prompt cannot advertise a
 * skill the kernel would refuse, and the validator cannot accept a slug the
 * runtime would not find, because there is only one answer to look up.
 *
 * The framework therefore never names `skills/`. The **sources** are an
 * assembly input, and what governance consumes is this table.
 */

/** A discovered skill: its slug, what it is for, and where its bundle lives. */
export interface SkillDefinition {
  /**
   * The bundle's directory name — the token authors govern by, and the only one
   * `skills.allow` accepts. Kept even when the bundle's `SKILL.md` `name:`
   * disagrees: the path is what governance decides against, so the directory
   * has the final say and the mismatch is reported instead of resolved.
   */
  slug: string;
  /** The `description:` frontmatter field, as disclosed to the model. */
  description: string;
  /**
   * Canonical, workspace-relative bundle path with no trailing slash
   * (`skills/order-data`) — the prefix a governed path is matched against.
   */
  prefix: string;
  /** Path of the bundle's `SKILL.md`, as the agent addresses it. */
  skillFile: string;
}

/** Discovered skills by slug, in discovery order. */
export type SkillRegistry = ReadonlyMap<string, SkillDefinition>;

/**
 * One skill's identity for path classification: the pair the kernel and the
 * validator need, and nothing else. Prompt-facing fields are deliberately
 * absent — a governance decision must not be able to depend on a description.
 */
export interface SkillLocation {
  readonly slug: string;
  /** Canonical bundle prefix, no trailing slash. */
  readonly prefix: string;
}

/**
 * The resolved skill table governance classifies against — the {@link
 * MountPrefixes} of skills. Ordered longest-prefix-first so a nested bundle
 * (were a source ever to serve one) resolves to the innermost skill.
 */
export type SkillPrefixes = readonly SkillLocation[];

/** No skills: no path lands inside a bundle, so the skill rule never fires. */
export const NO_SKILLS: SkillPrefixes = [];

/**
 * The conventional skill source, matching the `skills/` key in
 * {@link defaultMounts}. A **default value only**: it is the runtime option's
 * default, never a name any governance module refers to.
 */
export const DEFAULT_SKILL_SOURCES: readonly string[] = ["skills/"];

/** The Agent Skills bundle manifest, at the root of a skill directory. */
export const SKILL_FILE = "SKILL.md";

/** Structural inspection of a `SKILL.md`, for the loader and the validator. */
export interface SkillInspection {
  /** The parsed definition, or null when a fatal problem was found. */
  definition: Omit<SkillDefinition, "prefix" | "skillFile"> | null;
  /** Problems that make the bundle unloadable — the runtime skips it. */
  errors: string[];
  /** Non-fatal advisories (e.g. `name:`/directory mismatch). */
  warnings: string[];
}

/**
 * Inspect a `SKILL.md` (YAML frontmatter + markdown body) without emitting
 * events, so the runtime loader and the static validator agree about what is
 * unloadable. `expectedDir` is the containing directory name — the slug.
 *
 * Deep Agents' own `parseSkillMetadata` is not reused: it takes a filesystem
 * path and reads it with `fs`, while every authored input here arrives through
 * the backend. What is shared instead are its Agent Skills limits
 * (`MAX_SKILL_NAME_LENGTH`, `MAX_SKILL_DESCRIPTION_LENGTH`), so a bundle this
 * loader accepts is one upstream's skills middleware would accept too.
 *
 * A `name:` that disagrees with the directory is a **warning, not an error**:
 * the bundle still governs correctly (its path is unambiguous), and refusing to
 * load it would take a capability away over a label. `validate` reports the same
 * mismatch as an error, where an author is asking to be told.
 */
export function inspectSkillMarkdown(raw: string, expectedDir: string): SkillInspection {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fail = (message: string): SkillInspection => {
    errors.push(message);
    return { definition: null, errors, warnings };
  };

  if (raw.trim() === "") return fail("file is empty");

  const parsed = parseFrontmatter(raw);
  if (!parsed) return fail("no valid YAML frontmatter found");
  if (!parsed.data || typeof parsed.data !== "object") return fail("invalid YAML frontmatter");

  const meta = parsed.data as Record<string, unknown>;
  const description = meta.description;
  if (description === undefined || description === null || String(description).trim() === "") {
    return fail("missing required 'description'");
  }
  if (String(description).length > MAX_SKILL_DESCRIPTION_LENGTH) {
    return fail(`'description' exceeds ${MAX_SKILL_DESCRIPTION_LENGTH} characters (Agent Skills limit)`);
  }
  if (meta.name !== undefined && String(meta.name).length > MAX_SKILL_NAME_LENGTH) {
    return fail(`'name' exceeds ${MAX_SKILL_NAME_LENGTH} characters (Agent Skills limit)`);
  }
  if (meta.name !== undefined && String(meta.name) !== expectedDir) {
    warnings.push(
      `Skill '${String(meta.name)}' should match directory name '${expectedDir}' — ` +
        `'${expectedDir}' is the slug governance uses`,
    );
  }
  if (!isSlug(expectedDir)) {
    warnings.push(
      `Skill directory '${expectedDir}' is not a kebab-case slug, so no 'skills.allow' entry can name it`,
    );
  }

  return {
    definition: { slug: expectedDir, description: String(description).trim() },
    errors,
    warnings,
  };
}

/** A source path, canonicalized: no leading slash, no trailing slash. */
function normalizeSource(source: string): string {
  return canonicalizeRelPath(source).path;
}

/**
 * One problem found while discovering skills. Carries the severity a **static**
 * check should report, which is not always the severity the runtime acts on: a
 * bundle whose `name:` disagrees with its directory still loads and governs
 * correctly (the path is unambiguous), so the runtime warns and keeps the
 * capability — while `validate`, asked precisely to find that, errors.
 *
 * Structured rather than pre-formatted so the validator classifies by `kind`
 * instead of matching on message text, and both paths report the same sentence.
 */
export interface SkillIssue {
  kind: "unloadable" | "name-mismatch" | "non-slug-dir" | "shadowed";
  /** Severity for a static check; the runtime treats every issue as a warning. */
  severity: "error" | "warning";
  /** The bundle directory name the issue is about. */
  slug: string;
  message: string;
}

/**
 * Read the skills served by `sources`, in order, through the workspace backend —
 * never `fs`, and never upstream's filesystem-only `listSkills`, so a store or
 * sandbox backend serves skills exactly as it serves everything else.
 *
 * Each source is accepted in either Agent Skills form, distinguished the way
 * upstream distinguishes them — by whether the directory itself holds a
 * `SKILL.md`:
 *
 * - a **parent directory** (`skills/`), whose every child bundle is loaded;
 * - a **direct bundle** (`skills/order-data/`), loaded as one skill.
 *
 * A later source providing an already-discovered slug **shadows** it (upstream's
 * documented last-one-wins precedence), reported as an issue: silently serving
 * one of two bundles under one governed name is exactly the ambiguity a governed
 * runtime should not keep to itself. A source that serves nothing is not a
 * problem — it is a workspace without that kind of capability.
 *
 * The one discovery path, shared by the runtime ({@link discoverSkills}) and
 * `archmax validate`, so the two cannot disagree about which skills exist.
 */
export async function inspectSkillSources(
  workspace: Workspace,
  sources: readonly string[] = DEFAULT_SKILL_SOURCES,
): Promise<{ registry: SkillRegistry; issues: SkillIssue[] }> {
  const registry = new Map<string, SkillDefinition>();
  const issues: SkillIssue[] = [];

  const load = async (prefix: string) => {
    const slug = dirName(prefix);
    if (!slug) return;
    const skillFile = `${prefix}/${SKILL_FILE}`;
    const raw = await workspace.readText(skillFile);
    if (raw == null) return;
    const { definition, errors, warnings } = inspectSkillMarkdown(raw, slug);
    for (const message of errors) {
      issues.push({
        kind: "unloadable",
        severity: "warning",
        slug,
        message: `Skipping skill '${slug}' at ${prefix}: ${message}`,
      });
    }
    for (const message of warnings) {
      issues.push({
        kind: message.includes("kebab-case") ? "non-slug-dir" : "name-mismatch",
        severity: "error",
        slug,
        message,
      });
    }
    if (!definition) return;
    const shadowed = registry.get(slug);
    if (shadowed && shadowed.prefix !== prefix) {
      issues.push({
        kind: "shadowed",
        severity: "warning",
        slug,
        message: `Skill '${slug}' at ${prefix} shadows the one at ${shadowed.prefix}`,
      });
    }
    registry.set(slug, { ...definition, prefix, skillFile });
  };

  for (const source of sources) {
    const root = normalizeSource(source);
    if (!root) continue;
    if (await workspace.exists(`${root}/${SKILL_FILE}`)) {
      await load(root);
      continue;
    }
    for (const entry of await workspace.listDir(root)) {
      if (entry.is_dir === false) continue;
      const name = dirName(entry.path);
      if (!name) continue;
      await load(`${root}/${name}`);
    }
  }

  return { registry, issues };
}

/**
 * The runtime's discovery: {@link inspectSkillSources}, with every issue emitted
 * as a warning on the event stream. Nothing here fails an assembly — a workspace
 * with one malformed bundle still runs, with that capability missing and said so.
 */
export async function discoverSkills(
  workspace: Workspace,
  sources: readonly string[] = DEFAULT_SKILL_SOURCES,
  onEvent?: WorkflowEventHandler,
): Promise<SkillRegistry> {
  const emit = createWorkflowEventEmitter(onEvent);
  const { registry, issues } = await inspectSkillSources(workspace, sources);
  for (const issue of issues) {
    emit({ type: "warning", scope: "skills", message: issue.message });
  }
  return registry;
}

/**
 * Reduce a registry to the table governance classifies against, ordered so the
 * longest prefix matches first.
 */
export function skillPrefixes(registry: SkillRegistry): SkillPrefixes {
  return [...registry.values()]
    .map(({ slug, prefix }) => ({ slug, prefix }))
    .sort((a, b) => b.prefix.length - a.prefix.length || a.slug.localeCompare(b.slug));
}

/**
 * The slug of the skill bundle a path lands inside, or null when it lands in
 * none — a path elsewhere in the workspace, *or* a path under a skill source
 * that belongs to no bundle (a stray file beside the bundles). The latter is
 * deliberately not this rule's business: it governs bundles, and the zone rules
 * already govern the authored directory holding them.
 *
 * Canonicalizes first, so `./skills//order-data/x`, `skills/order-data/./x`, and
 * `skills/other/../order-data/x` are all the one path the backend would resolve.
 * A path that escapes the workspace root belongs to no bundle (and is refused
 * elsewhere on its own terms).
 */
export function skillOfPath(path: string, skills: SkillPrefixes = NO_SKILLS): string | null {
  if (skills.length === 0) return null;
  const { path: rel, escapes } = canonicalizeRelPath(path);
  if (escapes || rel === "") return null;
  for (const { slug, prefix } of skills) {
    if (rel === prefix || rel.startsWith(`${prefix}/`)) return slug;
  }
  return null;
}

/**
 * Whether a glob or path pattern can only ever match inside one skill bundle —
 * the shape `validate` needs to spot a `tools.allow` entry that contradicts the
 * state's enabled set. Returns the slug when the pattern's literal prefix
 * (everything before its first wildcard) is already inside a bundle, else null:
 * a broader pattern (`skills/**`) matches several bundles and is left to the
 * runtime rule, which refuses the disabled ones call by call.
 */
export function skillOfPattern(pattern: string, skills: SkillPrefixes = NO_SKILLS): string | null {
  const literal = normalizeRelPath(pattern).split(/[*?[{]/, 1)[0] ?? "";
  const upToSegment = literal.slice(0, literal.lastIndexOf("/") + 1);
  return skillOfPath(upToSegment, skills);
}

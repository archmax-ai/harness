import matter from "gray-matter";
import { parse as parseYaml } from "yaml";

/**
 * gray-matter engine that reuses this project's `yaml` package (YAML 1.2)
 * instead of gray-matter's bundled `js-yaml` (YAML 1.1), so frontmatter parses
 * with the same semantics as the rest of the runtime. gray-matter hands the
 * block over with CRLF line endings intact, and a trailing `\r` would otherwise
 * end up inside parsed string values, so normalize before parsing.
 */
const YAML_ENGINE = {
  yaml: (input: string): object =>
    (parseYaml(input.replace(/\r(?=\n|$)/g, "")) ?? {}) as object,
};

export interface ParsedFrontmatter {
  /** Parsed YAML frontmatter block (whatever shape the caller expects). */
  data: unknown;
  /** Markdown content after the closing `---` delimiter. */
  body: string;
}

/**
 * Parse a `---`-delimited YAML frontmatter block followed by a Markdown body,
 * the convention shared by `SUBAGENT.md` and `WORKFLOW.md`. Returns `null` when
 * the input has no frontmatter delimiters or the YAML block fails to parse.
 *
 * Delegates delimiter handling (CRLF/LF, trailing-newline, BOM) to gray-matter
 * while parsing the YAML with the project's `yaml` engine.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter | null {
  if (!matter.test(raw)) return null;

  try {
    const parsed = matter(raw, { engines: YAML_ENGINE });
    return { data: parsed.data, body: parsed.content };
  } catch {
    return null;
  }
}

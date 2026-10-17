import matter from "gray-matter";
import { parse as parseYaml } from "yaml";

/**
 * gray-matter engine that reuses this project's `yaml` package (YAML 1.2)
 * instead of gray-matter's bundled `js-yaml` (YAML 1.1), so frontmatter parses
 * with the same semantics as the rest of the runtime. gray-matter hands the
 * block over with CRLF line endings intact, and a trailing `\r` would otherwise
 * end up inside parsed string values, so normalize before parsing.
 */
const yamlEngine = (input: string): object =>
  (parseYaml(input.replace(/\r(?=\n|$)/g, "")) ?? {}) as object;

/**
 * gray-matter picks a parser from the language tag on the opening fence, so
 * `---js` would hand the block to its bundled `javascript` engine, which runs
 * the block through `eval` in the host process. We parse only YAML, so refuse
 * any fence that names a language, and point the `js`/`javascript` engines at a
 * thrower in case a tag ever reaches gray-matter.
 */
const throwEngine = {
  parse: (): never => {
    throw new Error("frontmatter: only a plain `---` YAML fence is supported");
  },
  stringify: (): never => {
    throw new Error("frontmatter: only a plain `---` YAML fence is supported");
  },
};

export const ENGINES = { yaml: yamlEngine, js: throwEngine, javascript: throwEngine };

/**
 * Whether the opening `---` fence carries a language tag (e.g. `---js` or
 * `--- javascript`). `matter.test` has already confirmed the input opens with
 * `---`, so the tag is whatever follows on that first line.
 */
function hasLanguageTag(raw: string): boolean {
  const newline = raw.search(/\r?\n/);
  const firstLine = newline === -1 ? raw : raw.slice(0, newline);
  return firstLine.replace(/^-+/, "").trim().length > 0;
}

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
  if (hasLanguageTag(raw)) return null;

  try {
    const parsed = matter(raw, { engines: ENGINES, language: "yaml" });
    return { data: parsed.data, body: parsed.content };
  } catch {
    return null;
  }
}

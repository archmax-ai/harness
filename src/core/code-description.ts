/**
 * `archmax_run` scripts carry their human-facing contract as a leading JSDoc
 * block comment — the code-file analogue of a case file's `description`. Admin
 * UIs display only that description. Lifecycle hook scripts are NOT covered by this convention:
 * they are hand-authored files whose only validation is that the referenced
 * file exists. This module is the canonical extractor so consumers never
 * scrape comments themselves. It operates on source strings only (callers read
 * the file through their configured backend) and never touches the filesystem.
 */

/** Description frontmatter extracted from a code file's leading JSDoc block. */
export interface CodeDescription {
  /** Human-language prose of the block, with comment decorations removed. */
  description: string;
}

/**
 * A JSDoc block comment as the first non-whitespace content of the file. The
 * negative lookahead rejects the degenerate empty comment (slash-star-star-
 * slash), which opens with the same three characters but has no body.
 */
const LEADING_JSDOC = /^\/\*\*(?!\/)([\s\S]*?)\*\//;

/**
 * Extract the description frontmatter from a code file's source. Returns the
 * prose of a leading JSDoc block — BOM/CRLF normalized, `*` gutters stripped,
 * and truncated at the first `@tag` line (tags are permitted but not part of
 * the description) — or `null` when the source does not begin with a JSDoc
 * block or the block contains no prose.
 */
export function parseCodeDescription(source: string): CodeDescription | null {
  const normalized = String(source).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const match = LEADING_JSDOC.exec(normalized.trimStart());
  if (!match) return null;

  const proseLines: string[] = [];
  for (const rawLine of match[1].split("\n")) {
    const line = rawLine.replace(/^\s*\** ?/, "").trimEnd();
    if (line.startsWith("@")) break;
    proseLines.push(line);
  }

  const description = proseLines.join("\n").trim();
  return description === "" ? null : { description };
}

/**
 * The line-oriented listing filter both governed-capability redactions run on.
 *
 * The kernel refuses a path the state may not reach, which is enforcement — but
 * a scoped tool asks about a *directory*, not a file: `ls skills/`, `glob
 * catalogs/**\/*.csv`, and `grep` over the root all name a scope the state may
 * legitimately reach and would hand back everything in it. Blocking those calls
 * outright is the wrong trade (a state with one enabled capability could then
 * not list it), so the result is filtered instead.
 *
 * This is the only place governance touches a tool **result** rather than a
 * call, and it exists because invisibility is a requirement of governance in its
 * own right: a name the model never sees is a capability it never tries.
 *
 * Filtering is line-oriented because the upstream filesystem tools render
 * line-oriented text: `ls` one entry per line, `glob` one path per line, `grep`
 * a `<path>:` header followed by indented `  <line>: <text>` matches. A header
 * for a hidden owner therefore suppresses its continuation lines too —
 * otherwise the matched *content* would survive its filename.
 */

/** Whether a line carries no path of its own (a grep match under a header). */
function isContinuation(line: string): boolean {
  return /^\s/.test(line) && line.trim() !== "";
}

/**
 * The path a result line is about, or null when it names none. Takes the leading
 * token up to the first whitespace or `:` — enough for every shape the upstream
 * tools emit (`/skills/x (directory)`, `/skills/x/SKILL.md`,
 * `/skills/x/SKILL.md:`) without trying to parse arbitrary prose.
 */
function pathOfLine(line: string): string | null {
  const token = line.trim().split(/[\s:]/, 1)[0] ?? "";
  return token === "" ? null : token;
}

/**
 * Drop from `text` every line about an owner `isHidden` refuses.
 *
 * `ownerOf` maps a result line's path to the governed thing that owns it (a
 * skill slug, a mount name) or `null` when it owns none — a line no owner claims
 * is always kept, since the state's other rules govern it.
 *
 * Returns the text unchanged when nothing was hidden, so a result the filter has
 * no opinion about is passed through by identity rather than rebuilt.
 */
export function redactListing(
  text: string,
  ownerOf: (path: string) => string | null,
  isHidden: (owner: string) => boolean,
): string {
  const out: string[] = [];
  let suppressing = false;
  let hid = false;

  for (const line of text.split("\n")) {
    if (isContinuation(line)) {
      // A grep match line belongs to whichever header preceded it.
      if (!suppressing) out.push(line);
      continue;
    }
    if (line.trim() === "") {
      // A blank line separates grep's file groups; keep it only outside a
      // suppressed group, so a hidden owner leaves no gap where it was.
      if (!suppressing) out.push(line);
      continue;
    }
    const path = pathOfLine(line);
    const owner = path == null ? null : ownerOf(path);
    if (owner == null) {
      suppressing = false;
      out.push(line);
      continue;
    }
    suppressing = isHidden(owner);
    if (suppressing) {
      hid = true;
      // Drop the blank separator this group's header would have followed.
      if (out.length > 0 && out[out.length - 1]?.trim() === "") out.pop();
      continue;
    }
    out.push(line);
  }

  return hid ? out.join("\n") : text;
}

/**
 * The scoped file tools whose results are filtered. `read_file` is absent on
 * purpose: it names one path, which the kernel already refuses, and filtering a
 * file's *contents* would hand the model a silently truncated document.
 */
export const REDACTED_TOOLS: ReadonlySet<string> = new Set(["ls", "glob", "grep"]);

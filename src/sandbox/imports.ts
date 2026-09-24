/**
 * Source preparation for lifecycle hook scripts.
 *
 * `@langchain/quickjs`'s `transformForEval` (which `ReplSession.eval` applies to
 * everything it runs) silently **drops** `import` and `export` statements and
 * rejects nothing — so a hook's `export default async function hook(...)`
 * would vanish and a foreign import would pass unnoticed. This module does the
 * three things the transform will not:
 *
 * - **reject** any import that is not a `@archmax-ai/harness/*` type carrier (sandbox
 *   scripts are self-contained — inline the logic or use `tools.*`);
 * - **strip** the `@archmax-ai/harness/*` imports, preserving line count so sandbox
 *   stack traces keep pointing at the right source lines;
 * - **rewrite** `export default <expr>` to `globalThis.__hookDef = <expr>`, so
 *   the hook function survives evaluation as a script and the executor can call
 *   it with the hook input.
 */

/** Import specifiers the sandbox accepts (and strips) in script sources. */
const ALLOWED_SPECIFIER_PREFIX = "@archmax-ai/harness";

/**
 * Static import statements, single- or multi-line:
 * `import { a, b } from "spec";`, `import x from 'spec'`, `import "spec";`.
 */
const IMPORT_RE = /(^|\n)[ \t]*import\s+(?:[^"'()]*?from\s+)?["']([^"']+)["'][ \t]*;?/g;

/** `export default` at statement position. */
const EXPORT_DEFAULT_RE = /(^|\n)([ \t]*)export[ \t]+default[ \t]+/g;

/** Thrown (host-side) when a sandbox script imports a non-`@archmax-ai/harness/*` specifier. */
export class ForbiddenSandboxImportError extends Error {
  constructor(
    readonly specifier: string,
    readonly file?: string,
  ) {
    super(
      `sandbox scripts may import only from '@archmax-ai/harness/*' type-carrier entry points; ` +
        `found 'import ... from "${specifier}"'${file ? ` in ${file}` : ""}. ` +
        `Sandbox scripts are self-contained — inline the logic or use the tools bridge.`,
    );
    this.name = "ForbiddenSandboxImportError";
  }
}

function specifierAllowed(specifier: string): boolean {
  return (
    specifier === ALLOWED_SPECIFIER_PREFIX ||
    specifier.startsWith(`${ALLOWED_SPECIFIER_PREFIX}/`)
  );
}

/** All import specifiers in a source that are NOT `@archmax-ai/harness/*` (for validation). */
export function findForeignImports(source: string): string[] {
  const foreign: string[] = [];
  for (const match of String(source).matchAll(IMPORT_RE)) {
    const specifier = match[2];
    if (!specifierAllowed(specifier)) foreign.push(specifier);
  }
  return foreign;
}


/**
 * Prepare a hook source for evaluation: strip `@archmax-ai/harness/*` imports, rewrite
 * `export default` to the `__hookDef` registration, and throw
 * {@link ForbiddenSandboxImportError} on any other import specifier.
 */
export function prepareHookSource(source: string, opts: { file?: string } = {}): string {
  const stripped = String(source).replace(IMPORT_RE, (whole, _lead: string, specifier: string) => {
    if (!specifierAllowed(specifier)) throw new ForbiddenSandboxImportError(specifier, opts.file);
    return "\n".repeat(whole.split("\n").length - 1);
  });
  return stripped.replace(EXPORT_DEFAULT_RE, "$1$2globalThis.__hookDef = ");
}

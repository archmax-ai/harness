import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as root from "./index.js";
import * as testing from "./public/testing.js";
import * as cli from "./public/cli.js";
import * as sandbox from "./public/sandbox.js";

/**
 * The barrel is the supported surface, so it is pinned like one.
 *
 * Before this change it carried 216 exports, which is why every internal
 * refactor was a breaking change. The point of a small surface is lost the moment
 * something drifts back into it unnoticed — a `export *` added in passing, a
 * symbol re-exported "just for a test" — so growth has to be a deliberate edit
 * here rather than a side effect somewhere else.
 */
/**
 * Every type name the barrel re-exports, read from its source.
 *
 * A type export leaves no runtime trace, so it cannot be enumerated from the
 * module — and a type that is reachable from a public signature but not exported
 * is a real defect: a consumer can call the function and cannot name what it
 * returns.
 */
function exportedTypeNames(): string[] {
  const source = readFileSync(resolve(import.meta.dirname, "index.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*/g, "");
  const names = new Set<string>();
  for (const block of source.matchAll(/export type \{([^}]*)\} from/g)) {
    for (const raw of (block[1] ?? "").split(",")) {
      const name = raw.trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names.add(name);
    }
  }
  return [...names];
}

describe("the public surface", () => {
  it("stays small, and every addition is a deliberate edit to this test", () => {
    // 45 before the session/resume errors a host catches were added, 56 before
    // the park readers and session-id helpers a host restated were, 60 before
    // the five trigger-signature helpers (`SIGNATURE_TYPES`, `normalizeSignature`,
    // `signatureForTrigger`, `signatureJsonSchema`, `signatureValueIssues`); each
    // new runtime export is a deliberate edit here.
    expect(Object.keys(root).length).toBeLessThanOrEqual(68);
  });

  // Each heavy subpath exists so a production import does not pull in what it
  // does not need. A symbol on two of them would defeat that. (The light
  // subpaths `spec` and `messages` deliberately mirror root names as the same
  // bindings; `public/light-subpaths.test.ts` pins that instead.)
  it("keeps the heavy subpaths disjoint from the root", () => {
    const rootNames = new Set(Object.keys(root));
    for (const [name, mod] of [
      ["testing", testing],
      ["cli", cli],
      ["sandbox", sandbox],
    ] as const) {
      const overlap = Object.keys(mod).filter((k) => rootNames.has(k));
      expect(`${name}: ${overlap.join(", ")}`).toBe(`${name}: `);
    }
  });

  // A subpath that is declared but not built is a broken import for a consumer,
  // and nothing else in the suite would catch it.
  it("declares every subpath entry module in package.json exports", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
    ) as { exports: Record<string, { import?: string }> };
    for (const sub of ["./sandbox", "./testing", "./cli", "./spec", "./messages"]) {
      expect(pkg.exports[sub]?.import).toBe(`./dist/public/${sub.slice(2)}.js`);
    }
  });

  /**
   * The reference page and the barrel have to agree, because the page is where
   * the boundary is now *stated* rather than implied by the module graph. A
   * symbol the docs promise and the barrel does not export is a broken promise;
   * the reverse is undocumented API. Checked in **both** directions, over the
   * page's export list — the section between "The complete public surface" and
   * the next `##` heading — so a name mentioned in passing further down does not
   * count as documented.
   *
   * **Types are checked too, and that is the point.** `Object.keys` sees only
   * runtime exports, so a type-only export is invisible to it — which is exactly
   * how types reachable from public signatures were once left off the barrel and
   * only found by typechecking a real consumer. Reading the barrel's source
   * catches them here instead.
   */
  const page = readFileSync(
    resolve(import.meta.dirname, "../docs/src/content/docs/reference/public-api.md"),
    "utf8",
  );
  const exportList = page.slice(
    page.indexOf("## The complete public surface"),
    page.indexOf("\n## ", page.indexOf("## The complete public surface") + 1),
  );
  const documented = new Set([...exportList.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)].map((m) => m[1]));

  it("documents every root export in the page's export list, type exports included", () => {
    const undocumented = [...Object.keys(root), ...exportedTypeNames()].filter(
      (name) => !documented.has(name),
    );
    expect(undocumented).toEqual([]);
  });

  it("exports every name the page's export list promises", () => {
    const exported = new Set([...Object.keys(root), ...exportedTypeNames()]);
    const promised = [...documented].filter((name) => !exported.has(name));
    expect(promised).toEqual([]);
  });
});

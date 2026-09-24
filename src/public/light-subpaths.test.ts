import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import * as root from "../index.js";
import * as spec from "./spec.js";
import * as messages from "./messages.js";

/**
 * `@archmax-ai/harness/spec` and `@archmax-ai/harness/messages` exist so a browser bundle
 * and a runtime-free request path can import the vocabulary without LangGraph,
 * Deep Agents, the sandbox or `node:*`. That is a property of each barrel's
 * **transitive import graph**, so it is pinned here by walking the graph rather
 * than by trusting a comment: a runtime import of anything but the two pure
 * libraries the schema needs fails this test, naming the file and the specifier.
 *
 * The graph does not stop at the package boundary. An allowed library is only
 * allowed because it is *itself* browser-safe, so its own transitive files are
 * walked too, for `node:*` imports and for a `process`/`Buffer`/`__dirname`
 * read that no `typeof` guard covers. Allowlisting a library without checking
 * inside it is what once put `micromatch` on this subpath: its `picomatch@2`
 * reads `process.platform` at module scope, which is not a bundling failure but
 * a `ReferenceError` on the first evaluation in a browser.
 */
const SRC = resolve(import.meta.dirname, "..");

/** The bare specifiers a light subpath may reach at runtime. Everything else is refused. */
const ALLOWED_BARE_SPECIFIERS = new Set(["zod", "picomatch"]);

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Runtime import specifiers of one module: `import`/`export … from`, minus `import type` / `export type`, plus dynamic `import()`. */
function runtimeSpecifiers(file: string): string[] {
  const source = stripComments(readFileSync(file, "utf8"));
  const out: string[] = [];
  // An import clause holds no quotes or semicolons, which keeps a `from` inside a
  // string literal from being read as one.
  for (const m of source.matchAll(/^\s*(import|export)\s+(type\s+)?[^"';]*?\sfrom\s*["']([^"']+)["']/gm)) {
    if (m[2]) continue;
    out.push(m[3]!);
  }
  for (const m of source.matchAll(/\bimport\s*["']([^"']+)["']/g)) out.push(m[1]!);
  for (const m of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]!);
  return out;
}

function resolveRelative(from: string, specifier: string): string {
  const target = resolve(dirname(from), specifier.replace(/\.js$/, ".ts"));
  if (existsSync(target)) return target;
  throw new Error(`${from} imports ${specifier}, which does not resolve under src/`);
}

/** Every module reachable from `entry` at runtime, with the bare specifiers each reaches. */
function walk(entry: string): { modules: string[]; foreign: { file: string; specifier: string }[] } {
  const seen = new Set<string>();
  const foreign: { file: string; specifier: string }[] = [];
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of runtimeSpecifiers(file)) {
      if (specifier.startsWith(".")) queue.push(resolveRelative(file, specifier));
      else if (!ALLOWED_BARE_SPECIFIERS.has(specifier)) foreign.push({ file: file.slice(SRC.length + 1), specifier });
    }
  }
  return { modules: [...seen].map((f) => f.slice(SRC.length + 1)), foreign };
}

/**
 * Node builtins by every spelling a dependency may use. A browser bundler either
 * fails on these or silently substitutes a stub, and a stub is how a governance
 * glob quietly stops matching, so they are refused rather than shimmed.
 */
const NODE_BUILTINS = new Set([
  "assert",
  "buffer",
  "child_process",
  "crypto",
  "events",
  "fs",
  "http",
  "https",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "stream",
  "string_decoder",
  "tty",
  "url",
  "util",
  "worker_threads",
  "zlib",
]);

/** Globals a browser does not define. Reading one unguarded throws on evaluation, not on bundling. */
const NODE_GLOBALS = ["process", "Buffer", "__dirname", "__filename"] as const;

/**
 * What makes one file unusable in a browser: a builtin import, or a read of a
 * node-only global that no nearby `typeof` guard covers. `picomatch@4` reads
 * `process.platform` behind `typeof process !== "undefined"` and is fine;
 * `picomatch@2` reads it bare at module scope and is not.
 */
function impurities(label: string, rawSource: string): string[] {
  const source = stripComments(rawSource);
  const found: string[] = [];
  for (const specifier of packageSpecifiers(source)) {
    if (specifier.startsWith("node:") || NODE_BUILTINS.has(specifier)) {
      found.push(`${label} imports ${specifier}`);
    }
  }
  for (const name of NODE_GLOBALS) {
    // A property read (`process.platform`), not a bare mention, and not `foo.process`.
    for (const m of source.matchAll(new RegExp(`(^|[^\\w.$])${name}\\s*\\.`, "g"))) {
      const nearby = source.slice(Math.max(0, m.index - 160), m.index + 220);
      if (new RegExp(`typeof\\s+${name}\\s*[!=]==?\\s*["'](un)?defined["']`).test(nearby)) continue;
      found.push(`${label}:${source.slice(0, m.index).split("\n").length} reads ${name} unguarded`);
    }
  }
  return found;
}

/** Every specifier a dependency file reaches, `require()` included — dependencies ship CJS as often as ESM. */
function packageSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(
    /(?:^|[^\w.])(?:import|export)[^"';]*?\sfrom\s*["']([^"']+)["']/gm,
  ))
    out.push(m[1]!);
  for (const m of source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]!);
  for (const m of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]!);
  return out;
}

/** The entry a bundler would take for a package, preferring the browser and ESM fields. */
function packageEntry(fromFile: string, specifier: string): string {
  const pkgPath = createRequire(fromFile).resolve(`${specifier}/package.json`);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
  const pick = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      const e = value as Record<string, unknown>;
      return pick(e.browser ?? e.import ?? e.default ?? e.require);
    }
    return undefined;
  };
  const exported = pkg.exports
    ? pick((pkg.exports as Record<string, unknown>)["."] ?? pkg.exports)
    : undefined;
  const rel = exported ?? (pkg.module as string) ?? (pkg.main as string) ?? "index.js";
  return resolve(dirname(pkgPath), rel);
}

function resolveDependencyFile(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    join(base, "index.js"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Walk one dependency's own transitive files — across nested packages, so a
 * library's dependency is judged by the copy it actually resolves — and report
 * everything that would break in a browser.
 */
function scanDependency(specifier: string, fromFile: string): string[] {
  const seen = new Set<string>();
  const queue = [packageEntry(fromFile, specifier)];
  const found: string[] = [];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    const label = file.includes("node_modules/") ? file.split("node_modules/").pop()! : file;
    found.push(...impurities(label, source));
    for (const next of packageSpecifiers(stripComments(source))) {
      if (next.startsWith(".")) {
        const target = resolveDependencyFile(file, next);
        if (target) queue.push(target);
      } else if (!next.startsWith("node:") && !NODE_BUILTINS.has(next)) {
        try {
          queue.push(packageEntry(file, next));
        } catch {
          // A package with no resolvable entry reaches no code, so it cannot be impure.
        }
      }
    }
  }
  return found;
}

const LIGHT = [
  ["spec", spec, "public/spec.ts"],
  ["messages", messages, "public/messages.ts"],
] as const;

describe("the light subpaths", () => {
  for (const [name, , entry] of LIGHT) {
    it(`${name}: reaches no runtime, filesystem or node import`, () => {
      const { foreign } = walk(resolve(SRC, entry));
      expect(foreign).toEqual([]);
    });
  }

  // The parser above is what the property rests on, so it is checked against
  // modules known to be impure.
  it("would catch a runtime import of the framework or of node", () => {
    const { foreign } = walk(resolve(SRC, "core/messages.ts"));
    expect(foreign.map((f) => f.specifier)).toEqual(
      expect.arrayContaining(["node:crypto", "@langchain/core/messages"]),
    );
    const store = walk(resolve(SRC, "core/session-store.ts")).foreign.map((f) => f.specifier);
    expect(store).toEqual(expect.arrayContaining(["node:fs", "deepagents"]));
  });

  /**
   * The allowlist above is the whole of the trust placed in a third party, so
   * each entry is checked rather than assumed: a library that reaches a node
   * builtin or an unguarded node global is not browser-safe, however well it
   * bundles.
   */
  for (const specifier of ALLOWED_BARE_SPECIFIERS) {
    it(`${specifier}: the library itself is browser-safe`, () => {
      expect(scanDependency(specifier, resolve(SRC, "machine/allow.ts"))).toEqual([]);
    });
  }

  // The dependency scan rests on `impurities`, so it is checked against the shape
  // that caused this rule — `picomatch@2`'s module scope — and its guarded fix.
  it("would catch a dependency that reaches process or a node builtin", () => {
    const picomatch2 = `const path = require('path');\nconst win32 = process.platform === 'win32';`;
    expect(impurities("utils.js", picomatch2)).toEqual([
      "utils.js imports path",
      "utils.js:2 reads process unguarded",
    ]);
    expect(impurities("m.js", `import { readFile } from "node:fs";`)).toEqual([
      "m.js imports node:fs",
    ]);
    expect(impurities("m.js", `const b = Buffer.from(x);`)).toEqual([
      "m.js:1 reads Buffer unguarded",
    ]);
  });

  it("accepts a node global read behind a typeof guard, as picomatch@4 reads it", () => {
    const guarded = `if (typeof process !== 'undefined' && process.platform) {\n  return process.platform === 'win32';\n}`;
    expect(impurities("utils.js", guarded)).toEqual([]);
    // A bare mention is not a read, and neither is a property of something else.
    expect(impurities("m.js", `const x = opts.process.env;`)).toEqual([]);
  });

  it("skips type-only imports, which the compiler erases", () => {
    // `core/workspace.ts` imports Deep Agents' types and nothing at runtime.
    expect(walk(resolve(SRC, "core/workspace.ts")).foreign).toEqual([]);
  });

  /**
   * A name on both the root and a light subpath is the **same binding**: the
   * subpath exists for the weight of the import, never to fork a symbol. (The
   * heavy subpaths — testing, cli, sandbox — stay disjoint from the root instead;
   * `index.test.ts` pins that.)
   */
  for (const [name, mod] of LIGHT) {
    it(`${name}: every name shared with the root is the root's own binding`, () => {
      const shared = Object.keys(mod).filter((k) => k in root);
      expect(shared.length).toBeGreaterThan(0);
      for (const key of shared) {
        expect((mod as Record<string, unknown>)[key], key).toBe((root as Record<string, unknown>)[key]);
      }
    });
  }

  /**
   * Each light subpath is documented on the public API page in its own section,
   * checked in both directions like the root: the export list runs from the
   * section heading to its first sub-heading, so the prose under `###` may name
   * whatever it needs to. Type exports are read from the barrel's source, since
   * they leave no runtime trace.
   */
  const page = readFileSync(resolve(SRC, "../docs/src/content/docs/reference/public-api.md"), "utf8");
  function documentedUnder(heading: string): Set<string> {
    const start = page.indexOf(heading);
    expect(start, `heading ${JSON.stringify(heading)} on the public API page`).toBeGreaterThan(-1);
    const end = page.indexOf("\n##", start + 1);
    const section = page.slice(start, end === -1 ? undefined : end);
    return new Set([...section.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)].map((m) => m[1]!));
  }
  function exportedTypeNames(entry: string): string[] {
    const source = stripComments(readFileSync(resolve(SRC, entry), "utf8"));
    const names = new Set<string>();
    for (const block of source.matchAll(/export type \{([^}]*)\} from/g)) {
      for (const raw of (block[1] ?? "").split(",")) {
        const name = raw.trim();
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names.add(name);
      }
    }
    return [...names];
  }
  for (const [name, mod, entry] of LIGHT) {
    const heading = `## \`@archmax-ai/harness/${name}\``;
    it(`${name}: is documented in both directions`, () => {
      const documented = documentedUnder(heading);
      const exported = new Set([...Object.keys(mod), ...exportedTypeNames(entry)]);
      expect([...exported].filter((n) => !documented.has(n)), "undocumented").toEqual([]);
      // The section names the subpath itself in backticks; that is not an export.
      const promised = [...documented].filter((n) => !exported.has(n) && !n.startsWith("archmax"));
      expect(promised, "documented but not exported").toEqual([]);
    });
  }
});

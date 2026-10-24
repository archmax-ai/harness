import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SANDBOX_VERSION, type SandboxContext } from "../runtime/contract.js";

const partsCache = new Map<string, string>();
const assembledCache = new Map<string, string>();

function partsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "assets", "parts");
}

function readPart(name: string): string {
  const cached = partsCache.get(name);
  if (cached !== undefined) return cached;
  const content = readFileSync(join(partsDir(), `${name}.js`), "utf8");
  partsCache.set(name, content);
  return content;
}

/**
 * The scoped `tools` view, shared by both contexts. The session injects every
 * tool it was handed once, at its first evaluation, and keeps that object for
 * its lifetime — for the agent's REPL, across every state the session moves
 * through. So the scoping happens in here: one Proxy, installed once, whose
 * listing *and* lookup are the surface the executor names per evaluation
 * (`__archmaxScope`). A name outside the surface is `undefined`, exactly as it
 * is absent from `Object.keys(tools)` and from `in`: a script reaches the
 * state's tools and nothing else. Its identity never changes, so a reference an
 * earlier evaluation kept reads the current state. The session keys each tool by
 * its camelCase name, but a model writes the name it calls the tool by
 * (`tools.read_file`), so the executor also hands over each tool's own name →
 * its key, and every lookup resolves through that; the listing stays the keys.
 * An IIFE: the evaluation hoists top-level declarations onto `globalThis`.
 */
const SCOPED_TOOLS_VIEW = `(() => {
  if (globalThis.__archmaxScope) return;
  const all = globalThis.tools != null && typeof globalThis.tools === "object" ? globalThis.tools : {};
  const injected = (name) => typeof name === "string" && Object.prototype.hasOwnProperty.call(all, name);
  let surface = null;
  let keys = {};
  const keyOf = (name) =>
    !injected(name) && typeof name === "string" && Object.prototype.hasOwnProperty.call(keys, name) ? keys[name] : name;
  const visible = (name) => injected(name) && (surface === null || surface.has(name));
  const view = new Proxy({}, {
    get: (_target, name) => {
      const key = keyOf(name);
      return visible(key) ? all[key] : undefined;
    },
    has: (_target, name) => visible(keyOf(name)),
    ownKeys: () => Object.keys(all).filter(visible),
    getOwnPropertyDescriptor: (_target, name) => {
      const key = keyOf(name);
      return visible(key) ? { value: all[key], writable: false, enumerable: true, configurable: true } : undefined;
    },
  });
  Object.defineProperty(globalThis, "__archmaxScope", {
    value: (names, ownNames) => {
      surface = new Set(names);
      keys = ownNames ?? {};
      globalThis.tools = view;
    },
  });
})();`;

/**
 * The PTC context's prelude: the versioned contract marker and the scoped
 * `tools` view. The agent's own code (`archmax_eval`, `archmax_run`) gets no
 * code-state vocabulary — `tools` and `args` are injected separately by the
 * executor and the QuickJS session.
 */
const PTC_PRELUDE = [
  `globalThis.SANDBOX_CONTRACT = { context: "ptc", version: globalThis.__SANDBOX_VERSION };`,
  SCOPED_TOOLS_VIEW,
].join("\n");

/**
 * Assemble the QuickJS prelude for a sandbox context: `ptc` is the contract
 * marker and the scoped `tools` view; `code` adds the code-state part — its own
 * marker and the `defineCodeState` alias — to the same view. Cached per
 * `(context, version)`.
 *
 * There are exactly two preludes and no compatibility prelude for a superseded
 * vocabulary, so a source using one throws in the sandbox and fails closed.
 */
export function readPrelude(
  context: SandboxContext = "ptc",
  version: number = DEFAULT_SANDBOX_VERSION,
): string {
  const key = `${context}@${version}`;
  const cached = assembledCache.get(key);
  if (cached !== undefined) return cached;
  const header = `globalThis.__SANDBOX_VERSION = ${JSON.stringify(version)};`;
  const parts = context === "ptc" ? [PTC_PRELUDE] : [SCOPED_TOOLS_VIEW, readPart("code-state")];
  const assembled = [header, ...parts].join("\n");
  assembledCache.set(key, assembled);
  return assembled;
}

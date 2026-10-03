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
 * The PTC context's whole prelude: the versioned contract marker and the view
 * that scopes `tools` to the active state. The model's own code (`archmax_eval`,
 * `archmax_run`) gets no hook vocabulary — `tools` and `args` are injected
 * separately by the executor and the QuickJS session.
 */
const PTC_PRELUDE = [
  `globalThis.SANDBOX_CONTRACT = { context: "ptc", version: globalThis.__SANDBOX_VERSION };`,
  // The session injects every PTC tool once, at its first evaluation, and keeps
  // that object for its lifetime — across every state the run moves through. So
  // the scoping happens in here: one Proxy, installed once, whose listing is the
  // surface the executor names per evaluation (`__archmaxScope`). Its identity
  // never changes, so a reference an earlier evaluation kept reads the current
  // state. `get` still resolves a registered name outside the view, so calling
  // one reaches governance and its refusal, not a TypeError. An IIFE: the
  // evaluation hoists top-level declarations onto `globalThis`.
  `(() => {
  if (globalThis.__archmaxScope) return;
  const all = globalThis.tools != null && typeof globalThis.tools === "object" ? globalThis.tools : {};
  const injected = (name) => typeof name === "string" && Object.prototype.hasOwnProperty.call(all, name);
  let surface = null;
  const visible = (name) => injected(name) && (surface === null || surface.has(name));
  const view = new Proxy({}, {
    get: (_target, name) => (injected(name) ? all[name] : undefined),
    has: (_target, name) => visible(name),
    ownKeys: () => Object.keys(all).filter(visible),
    getOwnPropertyDescriptor: (_target, name) =>
      visible(name) ? { value: all[name], writable: false, enumerable: true, configurable: true } : undefined,
  });
  Object.defineProperty(globalThis, "__archmaxScope", {
    value: (names) => {
      surface = new Set(names);
      globalThis.tools = view;
    },
  });
})();`,
].join("\n");

/**
 * Assemble the QuickJS prelude for a sandbox context. The lifecycle-hook context
 * is the verdict helpers (`ok`/`veto`/`correct`), `defineHook`, and the verdict
 * reducer; the PTC context is the contract marker alone. Cached per
 * `(context, version)`.
 *
 * There are exactly two preludes: no compatibility prelude exists for a
 * superseded vocabulary, so a hook source using one throws in the sandbox and
 * the phase vetoes fail-closed.
 */
export function readPrelude(
  context: SandboxContext = "lifecycle-hook",
  version: number = DEFAULT_SANDBOX_VERSION,
): string {
  const key = `${context}@${version}`;
  const cached = assembledCache.get(key);
  if (cached !== undefined) return cached;
  const header = `globalThis.__SANDBOX_VERSION = ${JSON.stringify(version)};`;
  const parts =
    context === "ptc"
      ? [PTC_PRELUDE]
      : [
          readPart("core"),
          readPart("lifecycle-hook"),
        ];
  const assembled = [header, ...parts].join("\n");
  assembledCache.set(key, assembled);
  return assembled;
}

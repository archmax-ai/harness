// Lifecycle-hook context: the contract marker, the `defineHook` authoring
// alias, and the reducer that turns whatever a hook produced into a verdict.
// These globals are absent from the PTC context.

globalThis.SANDBOX_CONTRACT = { context: "lifecycle-hook", version: globalThis.__SANDBOX_VERSION };

// `export default defineHook(fn)` and `export default async function hook(...)`
// both register the hook; the executor rewrites `export default` to an
// assignment of `__hookDef`, so `defineHook` is an identity that also registers.
globalThis.defineHook = (fn) => {
  globalThis.__hookDef = fn;
  return fn;
};

// How an object that is not a verdict is named back to its author: by its keys,
// never its values, so a diagnostic cannot leak what the hook was inspecting.
globalThis.__hookShape = (value) => {
  if (Array.isArray(value)) return "an array";
  try {
    const keys = Object.keys(value);
    if (keys.length === 0) return "an object with no keys";
    const shown = keys.slice(0, 6).map((key) => `'${key}'`).join(", ");
    return `an object with ${keys.length > 6 ? "keys including " : "keys "}${shown}`;
  } catch {
    return "an object";
  }
};

// The verdict of a hook run. A verdict object is taken as is, a bare `false`
// vetoes, and returning nothing is `ok`.
//
// Any *other* object fails closed. A hook's return value is its verdict and
// nothing else, so an object that is not one is a verdict its author got wrong
// — a misspelled `verdict`, a retired shape like `{ ok: false, reason }`. Read
// as `ok` it would silently permit precisely what the hook meant to block, and
// the author would have no way to notice: the run just proceeds.
globalThis.__hookVerdict = (value) => {
  if (globalThis.__isVerdict(value)) return value;
  if (value === false) return globalThis.veto("precondition not met");
  if (value !== null && typeof value === "object") {
    throw new Error(
      `hook returned ${globalThis.__hookShape(value)}, which is not a verdict — ` +
        "return ok(), veto(reason), correct(reason), false, or nothing at all",
    );
  }
  return globalThis.ok();
};

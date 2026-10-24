// Code-state context: the contract marker and the `defineCodeState` authoring
// alias. These globals are absent from the PTC context.
//
// A code state's script moves the session itself — `tools.archmax_advance` — or
// ends it — `tools.archmax_raise`; nothing it returns is read, so there is no
// verdict vocabulary here.

globalThis.SANDBOX_CONTRACT = { context: "code", version: globalThis.__SANDBOX_VERSION };

// `export default defineCodeState(fn)` and `export default async function (...)`
// both register the state's function: the executor rewrites `export default` to
// an assignment of `__stateDef`, so `defineCodeState` is an identity that also
// registers.
globalThis.defineCodeState = (fn) => {
  globalThis.__stateDef = fn;
  return fn;
};

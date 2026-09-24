import type { RunnableConfig } from "@langchain/core/runnables";

/** The runnable config a hook's or request's runtime stands for. */
export function buildRunnableConfig(runtime: {
  configurable?: Record<string, unknown>;
  signal?: AbortSignal;
  store?: unknown;
}): RunnableConfig {
  return {
    configurable: runtime?.configurable ?? {},
    signal: runtime?.signal,
    ...(runtime?.store !== undefined ? { store: runtime.store } : {}),
  };
}

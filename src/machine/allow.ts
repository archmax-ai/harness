import picomatch from "picomatch";
import { canonicalizeRelPath, normalizeRelPath } from "../core/workspace.js";
import type { AllowEntry, MachineSpec } from "./types.js";
import {
  hasVariableReference,
  parseReferences,
  resolveGlob,
  resolvePath,
  type VariableReference,
  type VariableStore,
} from "./variables.js";

/** Conventional path argument for file tools and `archmax_run`. */
export const DEFAULT_PATH_ARG = "file_path";

export interface NormalizedAllowEntry {
  tool: string | undefined;
  /** Per-argument glob matchers, or null to allow the tool with any arguments. */
  argMatchers: Record<string, string[]> | null;
}

/**
 * Whether a value matches any of the given globs. The value is canonicalized
 * (`.`/`..`/`//` resolved) so a `./` or `.//` prefix cannot dodge a
 * `forbid_paths` glob — the matcher sees the same path the backend resolves.
 * Globs are leading-slash-normalized only, preserving their wildcards.
 *
 * `dot: true`: a workspace path is not a shell glob, and a governance glob that
 * skipped dot-prefixed segments would read the same either way — `secrets/**`
 * would miss `secrets/.env` on the deny side while `scratchpad/**` would refuse
 * `scratchpad/.cache` on the allow side.
 */
export function valueMatches(value: unknown, globs: string[]): boolean {
  if (value == null || globs.length === 0) return false;
  return picomatch.isMatch(canonicalizeRelPath(String(value)).path, globs.map(normalizeRelPath), {
    dot: true,
  });
}

/**
 * Normalize an `allow` entry into a tool name plus optional argument matchers.
 * One shared derivation for the kernel, disclosure, and `validate`, so they
 * cannot disagree about what an entry covers.
 */
export function normalizeAllowEntry(entry: AllowEntry): NormalizedAllowEntry {
  if (typeof entry === "string") return { tool: entry, argMatchers: null };
  if (!entry || typeof entry !== "object") return { tool: undefined, argMatchers: null };

  const tool = entry.tool;
  if (entry.args && typeof entry.args === "object") {
    const argMatchers: Record<string, string[]> = {};
    for (const [name, globs] of Object.entries(entry.args)) {
      argMatchers[name] = Array.isArray(globs) ? globs : [globs];
    }
    return { tool, argMatchers };
  }
  if (entry.paths !== undefined) {
    const globs = Array.isArray(entry.paths) ? entry.paths : [entry.paths];
    return { tool, argMatchers: { [DEFAULT_PATH_ARG]: globs } };
  }
  return { tool, argMatchers: null };
}

/**
 * An unresolvable `${{…}}` reference in a guard. Not a mismatch: the harness
 * could not evaluate the governance the author declared, so the caller turns
 * this into a terminal run failure rather than a retryable block.
 */
export interface GuardResolutionFailure {
  reference: string;
  detail: string;
}

/**
 * Whether a tool call's arguments satisfy a normalized allow entry's matchers.
 *
 * `${{…}}` references are resolved against the run's variables per call, never
 * cached: a `set_variables` later in the same turn must take effect on the very
 * next call. An unresolvable reference makes the entry match nothing and reports
 * why through `onUnresolved` — never the literal `${{…}}` text or a permissive
 * pattern. A dotted argument key (`args.file_path`) is read with the same
 * own-property traversal `${{…}}` paths use, never the prototype chain.
 */
export function argsSatisfy(
  argMatchers: Record<string, string[]> | null,
  args: Record<string, unknown>,
  variables?: VariableStore,
  onUnresolved?: (failure: GuardResolutionFailure) => void,
): boolean {
  if (!argMatchers) return true;
  return Object.entries(argMatchers).every(([name, globs]) => {
    const resolved: string[] = [];
    for (const glob of globs) {
      if (!hasVariableReference(glob)) {
        resolved.push(glob);
        continue;
      }
      const result = resolveGlob(glob, variables ?? {});
      if (!result.ok) {
        onUnresolved?.({ reference: result.reference, detail: result.detail });
        return false;
      }
      resolved.push(result.pattern);
    }
    return valueMatches(resolvePath(args, name.split(".")), resolved);
  });
}

/**
 * One `${{…}}` reference found in a tool-argument guard, with enough context to
 * name it in a diagnostic: which state (null for an `allow_always` entry, which
 * binds in every state), which tool, and which argument.
 */
export interface GuardVariableReference {
  state: string | null;
  tool: string | undefined;
  arg: string;
  glob: string;
  reference: VariableReference;
}

/**
 * Every `${{…}}` reference in the spec's tool-argument guards, with where it was
 * found. Used at assembly to warn about a reference nothing guarantees, and by
 * the spec lint for the same check minus the host's seeds.
 */
export function guardReferences(spec: MachineSpec): GuardVariableReference[] {
  const found: GuardVariableReference[] = [];
  const collect = (entries: AllowEntry[] | undefined, state: string | null) => {
    for (const entry of entries ?? []) {
      const { tool, argMatchers } = normalizeAllowEntry(entry);
      if (!argMatchers) continue;
      for (const [arg, globs] of Object.entries(argMatchers)) {
        for (const glob of globs) {
          for (const ref of parseReferences(glob)) {
            found.push({ state, tool, arg, glob, reference: ref });
          }
        }
      }
    }
  };
  collect(spec.tools?.allow_always, null);
  collect(spec.tools?.forbid_always, null);
  for (const [slug, state] of Object.entries(spec.states)) {
    collect(state.tools?.allow, slug);
    collect(state.tools?.forbid, slug);
  }
  return found;
}

/**
 * Run-variable references — `${{name}}` and `${{name.dotted.path}}` — in guards,
 * prompts and the arguments the agent writes. One resolver serves the kernel,
 * disclosure, validation and substitution, so a reference means one thing.
 *
 * Three invariants carry the feature's safety: a substituted value is
 * glob-escaped where the output is a *pattern* and verbatim where it is a
 * *value*; resolution fails closed (never the literal `${{…}}` text, never `*`);
 * and traversal reads own properties only (`resolvePath`), so `tags.length` and
 * `constructor` never resolve.
 */

import { guardReferences } from "./allow.js";
import type { WorkflowMachine } from "./machine.js";
import { SET_VARIABLES_TOOL } from "./tool-names.js";
import { declaredVariableNames } from "./triggers.js";

/** The shape a run-variable name must take: a snake_case identifier, never dotted. */
export const VARIABLE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * The built-in variable holding the run's trigger id. Reserved: it is set by the
 * harness at run start, locked, and needs no seed — so a guard may reference
 * `${{trigger}}` without anything supplying it.
 */
export const TRIGGER_VARIABLE = "trigger";

/**
 * The built-in variable holding a short label for the task the run is doing.
 * Agent-owned, unlike `trigger`: nothing sets it until the agent does. Two rules
 * follow it everywhere it is written — it is **never locked** (a seed stores it
 * unlocked; `set_variables` refuses `lock: true`), and it is **shape-checked on
 * write** ({@link titleWriteError}). Unrelated to the spec's static `title`
 * fields.
 */
export const TITLE_VARIABLE = "title";

/**
 * The longest a title may be. A bound, not a style guide — the system prompt asks
 * for something short, and this only stops something unusable from being stored.
 */
export const TITLE_MAX_LENGTH = 200;

/**
 * Check a value destined for {@link TITLE_VARIABLE}, returning the refusal reason
 * or `undefined` when it passes. Shared by both write routes (a seed throws, the
 * agent's `set_variables` is refused). Refuses rather than coerces; trimming is
 * the one coercion allowed.
 */
export function titleWriteError(value: unknown): string | undefined {
  const shape =
    `'${TITLE_VARIABLE}' is reserved for a short label naming the task this run is doing. ` +
    `It must be a non-empty single-line string of at most ${TITLE_MAX_LENGTH} characters`;
  if (typeof value !== "string") {
    return `${shape}, but a ${value === null ? "null" : typeof value} was given.`;
  }
  if (/[\r\n]/.test(value)) return `${shape}; this one spans more than one line.`;
  const trimmed = value.trim();
  if (trimmed === "") return `${shape}; this one is empty.`;
  if (trimmed.length > TITLE_MAX_LENGTH) {
    return `${shape}; this one is ${trimmed.length}. Shorten it and retry.`;
  }
  return undefined;
}

/**
 * The value to store for a title that has passed {@link titleWriteError} — the
 * trimmed string. Separate from the check so a caller cannot store the untrimmed
 * original by forgetting to.
 */
export function normalizeTitle(value: string): string {
  return value.trim();
}

/** Thrown when a seeded (or written) variable name is not a valid identifier. */
export class InvalidVariableNameError extends Error {
  constructor(
    readonly variable: string,
    /** Where the name came from, for a message that points at the fix. */
    readonly source = "seeded",
  ) {
    super(
      `'${variable}' is not a valid variable name (${source}). Use lowercase letters, digits ` +
        `and underscores, starting with a letter (e.g. 'from_email').`,
    );
    this.name = "InvalidVariableNameError";
  }
}

/**
 * Thrown when a seeded `title` is not a usable label — a throw rather than the
 * agent's string refusal, because a bad seed is a host defect that should
 * surface at assembly.
 */
export class InvalidTitleError extends Error {
  constructor(
    /** The shape problem, in the same words the agent's refusal uses. */
    readonly detail: string,
    /** Where the value came from, for a message that points at the fix. */
    readonly source = "seeded",
  ) {
    super(`${detail} (${source})`);
    this.name = "InvalidTitleError";
  }
}

/** A run variable as stored in checkpointed state. */
export interface VariableEntry {
  value: unknown;
  locked: boolean;
  /**
   * Set only by a **host seeding boundary** (a delivery into a wait-parked
   * session, the start of a turn): the host is re-establishing the session's
   * facts, so this replaces even a settled *locked* value. Everywhere else the
   * merge is first-lock-wins. The variable tools never set it, so no
   * agent-reachable path can bypass a lock.
   */
  reseed?: boolean;
}

/** The checkpointed variable store, keyed by name. */
export type VariableStore = Record<string, VariableEntry>;

/** A store as the plain `name → value` map a signature is checked against. */
export function storeValues(store: VariableStore): Record<string, unknown> {
  return Object.fromEntries(Object.entries(store).map(([name, entry]) => [name, entry.value]));
}

/**
 * Turn a caller's seeds into locked variable entries — the one way a run's
 * opening facts are established, whether by a host's `variables` option, a
 * delivery's seeds, or the arguments a delegation hands a sub-run. Locked because
 * a `${{name}}` guard bound to a seed is worthless if the agent can rewrite it.
 */
export function buildSeededVariables(
  seeds: Record<string, unknown> | undefined,
  /** Where the names came from, for a message that points at the fix. */
  source = "seeded",
): VariableStore {
  const store: VariableStore = {};
  for (const [name, value] of Object.entries(seeds ?? {})) {
    if (!VARIABLE_NAME_PATTERN.test(name)) throw new InvalidVariableNameError(name, source);
    // `title` is the one seed stored unlocked: a seeded title is an *opening*
    // label the agent may refine (see TITLE_VARIABLE).
    if (name === TITLE_VARIABLE) {
      const problem = titleWriteError(value);
      if (problem) throw new InvalidTitleError(problem, source);
      store[name] = { value: normalizeTitle(value as string), locked: false };
      continue;
    }
    store[name] = { value, locked: true };
  }
  return store;
}

/** One `${{…}}` reference found in a glob, with its span for substitution. */
export interface VariableReference {
  /** The full matched text, e.g. `${{order.items.0.sku}}`. */
  raw: string;
  /** The variable name (first segment). */
  name: string;
  /** Path segments after the name; empty for a whole-variable reference. */
  path: string[];
  /** Index of `raw` within the glob it was found in. */
  index: number;
}

/** Why a reference could not be resolved. Each is a fail-closed outcome. */
export type UnresolvedReason =
  | "malformed"
  | "invalid-name"
  | "unset"
  | "path-missing"
  | "non-scalar";

export interface ResolvedGlob {
  ok: true;
  /** The glob with every reference substituted and glob-escaped. */
  pattern: string;
}

export interface UnresolvedGlob {
  ok: false;
  reason: UnresolvedReason;
  /** The reference that could not be resolved (its raw `${{…}}` text). */
  reference: string;
  /** Human-readable explanation, suitable for a governance block reason. */
  detail: string;
}

export type GlobResolution = ResolvedGlob | UnresolvedGlob;

/**
 * Matches a `${{…}}` reference, or the **escaped** form `$${{…}}` that writes the
 * braces as text (`$$` rather than a backslash, which would not survive JSON
 * encoding on the model's side). The inner text is captured loosely and
 * validated separately so a malformed reference is reported, never ignored.
 */
const REFERENCE_RE = /(\$?)\$\{\{([^}]*)\}\}/g;

/**
 * One span the scan found: a reference to resolve, or an escaped literal to
 * unescape. `escaped` spans are not references — they are text that merely looks
 * like one — so nothing but {@link substitute} needs to see them.
 */
interface ReferenceSpan extends VariableReference {
  /** `$${{…}}`: emit the braces as text, resolve nothing. */
  escaped: boolean;
}

/**
 * Every `${{…}}` and `$${{…}}` span in a string, in order. One scan so a
 * reference and its escaped twin can never be found by different rules.
 */
function scan(glob: string): ReferenceSpan[] {
  const spans: ReferenceSpan[] = [];
  REFERENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REFERENCE_RE.exec(glob)) !== null) {
    const inner = (match[2] ?? "").trim();
    const segments = inner.split(".");
    spans.push({
      raw: match[0],
      name: segments[0] ?? "",
      path: segments.slice(1),
      index: match.index,
      escaped: match[1] === "$",
    });
  }
  return spans;
}

/**
 * Whether a glob contains reference **syntax** — a `${{…}}` reference or an
 * escaped `$${{…}}` literal. Callers use this to skip resolution entirely for the
 * common reference-free glob, so an escape has to answer `true` here: it resolves
 * nothing, but it still needs the pass that turns `$${{x}}` into `${{x}}`.
 */
export function hasVariableReference(glob: string): boolean {
  return scan(glob).length > 0;
}

/**
 * Every `${{…}}` reference in a glob, in order. A syntactically malformed
 * reference still appears here (with an empty `name`), so callers can report it
 * rather than skip it. An escaped `$${{…}}` is omitted — it is literal text, and
 * reporting it as a reference would make `validate` warn about a variable the
 * author deliberately spelled out.
 */
export function parseReferences(glob: string): VariableReference[] {
  return scan(glob)
    .filter((span) => !span.escaped)
    // Drop `escaped`: it is this module's discriminator, not part of a reference.
    .map(({ raw, name, path, index }) => ({ raw, name, path, index }));
}

/** Whether a reference is structurally usable (name shape, no empty segments). */
export function referenceError(ref: VariableReference): UnresolvedReason | undefined {
  if (ref.name === "") return "malformed";
  if (ref.path.some((segment) => segment === "")) return "malformed";
  if (!VARIABLE_NAME_PATTERN.test(ref.name)) return "invalid-name";
  return undefined;
}

/**
 * A path segment that addresses an array element from the end (`-1` last, `-2`
 * second-to-last). Deliberately canonical-only: `-0` and `-01` do not match, so
 * there is exactly one spelling of each index and any other `-`-prefixed segment
 * stays an ordinary key.
 */
const FROM_END_RE = /^-[1-9][0-9]*$/;

/** A canonical non-negative index — no leading zeros, so one spelling per index. */
const INDEX_RE = /^(0|[1-9][0-9]*)$/;

/**
 * Descend one level. An **array** is addressed by index only — canonical
 * non-negative, or negative from the end; `Object.hasOwn` alone would let
 * `${{tags.length}}` resolve, since `length` is an own property. Any other
 * object is an own-property lookup, so `constructor`, `toString` and `__proto__`
 * stay unreachable while a data key of the same name still resolves.
 */
function step(container: unknown, segment: string): unknown {
  if (container === null || typeof container !== "object") return undefined;
  if (Array.isArray(container)) {
    if (FROM_END_RE.test(segment)) {
      const fromEnd = container.length + Number(segment);
      return fromEnd >= 0 ? container[fromEnd] : undefined;
    }
    return INDEX_RE.test(segment) ? container[Number(segment)] : undefined;
  }
  return Object.hasOwn(container as object, segment)
    ? (container as Record<string, unknown>)[segment]
    : undefined;
}

/**
 * Resolve a dotted path against a value, reading own properties only. Returns
 * `undefined` when any segment misses — indistinguishable from a stored
 * `undefined`, which is fine: both are unresolvable for a guard.
 */
export function resolvePath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    current = step(current, segment);
    if (current === undefined) return undefined;
  }
  return current;
}

/** Values a guard may substitute: exactly the scalars a glob can match against. */
function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/**
 * Escape every picomatch metacharacter so a substituted value is matched as
 * literal text; without it a variable holding `*` or `{a,b}` widens the guard.
 */
export function escapeGlobLiteral(value: string): string {
  return value.replace(/[\\*?[\]{}()!+@|^$]/g, (char) => `\\${char}`);
}

/** Explain an unresolved reference in the words a block reason should use. */
function explain(reason: UnresolvedReason, ref: VariableReference): string {
  const target = ref.path.length > 0 ? `'${ref.name}' at path '${ref.path.join(".")}'` : `'${ref.name}'`;
  switch (reason) {
    case "malformed":
      return `${ref.raw} is not a valid reference — use \${{name}} or \${{name.path.to.value}}`;
    case "invalid-name":
      return `${ref.raw} names '${ref.name}', which is not a valid variable name (lowercase letters, digits and underscores, starting with a letter)`;
    case "unset":
      return `variable '${ref.name}' is not set`;
    case "path-missing":
      return `${target} does not resolve — the value has no such path`;
    case "non-scalar":
      return `${target} resolves to a non-scalar value; only strings, numbers and booleans can be substituted into a guard`;
  }
}

/**
 * Substitute every reference in a glob against the run's variables. Returns the
 * resolved pattern, or the first unresolved reference and why — a glob with an
 * unresolved reference matches nothing at all, so the caller must not fall back
 * to the original text.
 */
export function resolveGlob(glob: string, variables: VariableStore): GlobResolution {
  return substitute(glob, variables, escapeGlobLiteral);
}

/**
 * Shared substitution. `render` decides how a resolved value enters the output:
 * glob-escaped for enforcement (where the result is a *pattern*), verbatim for
 * disclosure (where the result is *prose the model reads*) — showing an author's
 * email as `a\@b.c` would teach the model to pass the backslash.
 */
function substitute(
  glob: string,
  variables: VariableStore,
  render: (value: string) => string,
): GlobResolution {
  const refs = scan(glob);
  if (refs.length === 0) return { ok: true, pattern: glob };

  let out = "";
  let cursor = 0;
  for (const ref of refs) {
    // `$${{…}}`: the braces are meant as text. Emit the span with one `$`
    // dropped and resolve nothing.
    if (ref.escaped) {
      out += glob.slice(cursor, ref.index) + ref.raw.slice(1);
      cursor = ref.index + ref.raw.length;
      continue;
    }
    const structural = referenceError(ref);
    if (structural) {
      return { ok: false, reason: structural, reference: ref.raw, detail: explain(structural, ref) };
    }
    const entry = variables[ref.name];
    if (entry === undefined) {
      return { ok: false, reason: "unset", reference: ref.raw, detail: explain("unset", ref) };
    }
    const resolved = resolvePath(entry.value, ref.path);
    if (resolved === undefined) {
      const reason = ref.path.length === 0 ? "unset" : "path-missing";
      return { ok: false, reason, reference: ref.raw, detail: explain(reason, ref) };
    }
    if (!isScalar(resolved)) {
      return {
        ok: false,
        reason: "non-scalar",
        reference: ref.raw,
        detail: explain("non-scalar", ref),
      };
    }
    out += glob.slice(cursor, ref.index) + render(String(resolved));
    cursor = ref.index + ref.raw.length;
  }
  return { ok: true, pattern: out + glob.slice(cursor) };
}

/**
 * Substitute every reference in a piece of **prose** (a sub-workflow prompt)
 * verbatim: a prompt is text a model reads, where glob-escaping would teach it
 * to emit backslashes. Failure is still closed — a literal `${{…}}` reaching a
 * model is an instruction it cannot follow.
 */
export function resolveText(text: string, variables: VariableStore): GlobResolution {
  return substitute(text, variables, (value) => value);
}

/**
 * A resolved tool-call argument structure, or the first reference that stopped
 * it. The failure side is the same `UnresolvedGlob` every other consumer reports.
 */
export type ArgumentResolution = { ok: true; args: Record<string, unknown> } | UnresolvedGlob;

/**
 * Whether a value is a plain JSON object this walk may rebuild. Anything with its
 * own prototype (`Date`, `Map`, a class instance) is left alone rather than
 * flattened into `{}`.
 */
function isDataObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Substitute every reference in the **arguments the agent wrote**, verbatim.
 * Walks deep (non-string leaves pass through), fails first-wins and totally (the
 * tool never receives a half-resolved structure), and only reports. Objects are
 * rebuilt with `Object.fromEntries`, which *defines* each key, so a model-emitted
 * `__proto__` becomes a property rather than a prototype.
 */
export function resolveArguments(
  args: Record<string, unknown>,
  variables: VariableStore,
): ArgumentResolution {
  let failure: UnresolvedGlob | undefined;

  const walk = (value: unknown): unknown => {
    if (failure) return value;
    if (typeof value === "string") {
      // The same verbatim rendering a prompt gets — an argument is a value too.
      const result = resolveText(value, variables);
      if (result.ok) return result.pattern;
      failure = result;
      return value;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (isDataObject(value)) {
      const entries: [string, unknown][] = [];
      for (const [key, member] of Object.entries(value)) {
        entries.push([key, walk(member)]);
        if (failure) break;
      }
      return Object.fromEntries(entries);
    }
    return value;
  };

  const resolved = walk(args) as Record<string, unknown>;
  return failure ?? { ok: true, args: resolved };
}

/**
 * Render a guard glob for the model: the resolved pattern when it resolves, or a
 * short unresolved marker naming the reference. The model is told a constraint
 * exists and what it is waiting on, rather than being shown a placeholder it
 * might try to pass literally into a call that would end the run.
 */
export function describeGlob(glob: string, variables: VariableStore): string {
  const result = substitute(glob, variables, (value) => value);
  return result.ok ? result.pattern : `${glob} (unresolved: ${result.detail})`;
}

// --- What the assembly can guarantee a guard reference resolves ----------------

/**
 * Warn about every `${{…}}` guard reference the assembly cannot *guarantee* is
 * set — named by neither the host's seeds, any state's `requires`, nor the
 * built-in `trigger`. A warning, not a throw: `archmax_set_variables` can create
 * any name at runtime, so an upstream state may legitimately establish it; the
 * enforcement is the runtime failure when the guard cannot resolve.
 */
export function unguaranteedReferenceWarnings(
  machine: Pick<WorkflowMachine, "spec">,
  seededVariables: VariableStore,
): string[] {
  const guaranteed = new Set<string>([
    TRIGGER_VARIABLE,
    ...Object.keys(seededVariables),
    ...declaredVariableNames(machine.spec),
  ]);
  const messages: string[] = [];
  const seen = new Set<string>();
  for (const ref of guardReferences(machine.spec)) {
    const name = ref.reference.name;
    if (name === "" || guaranteed.has(name)) continue;
    const where = ref.state ? `state '${ref.state}'` : "tools.allow_always";
    const key = `${where}|${ref.tool}|${ref.arg}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    messages.push(
      `${where} guards '${ref.tool ?? "?"}' on '${ref.reference.raw}' (argument ` +
        `'${ref.arg}'), but nothing guarantees '${name}' is set: it is not seeded ` +
        `as a seeded variable and no state requires it. The guard then depends on ` +
        `the agent having called ${SET_VARIABLES_TOOL} first — if it has not, the session fails ` +
        `at that call. Name '${name}' in the 'requires' of a state that runs first, ` +
        `or seed it.` +
        (ref.state
          ? ""
          : " An allow_always entry is evaluated in every state, including states reached before anything sets it."),
    );
  }
  return messages;
}

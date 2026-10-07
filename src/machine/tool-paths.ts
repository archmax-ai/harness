/**
 * Which arguments of a tool name workspace paths, and how the call uses each.
 *
 * Every path rule of the kernel — the zones, the mount and skill rules, the
 * inherited denials, the always-open scratchpad — reads this table rather than a
 * list of tool names and one argument, so a tool is governed by the paths it
 * declares, whoever registered it: a Deep Agents built-in, the runtime's own
 * file operations, or a host tool. A `paths:` guard in an allow or forbid entry
 * matches the same declared arguments.
 *
 * A tool with no declaration has no path rules, as a host tool had none before
 * this table existed; a `paths:` guard on it still matches `file_path`.
 */
import { DEFAULT_PATH_ARG } from "./allow.js";
import { COPY_FILE_TOOL, MOVE_FILE_TOOL, REMOVE_FILE_TOOL, RUN_TOOL } from "./tool-names.js";

/** How a call uses one of its path arguments. */
export type PathAccess = "read" | "list" | "search" | "write" | "remove" | "execute";

/** A tool's path arguments, by argument name. */
export type ToolPaths = Readonly<Record<string, PathAccess>>;

/** Every access a declaration may name. */
export const PATH_ACCESSES: readonly PathAccess[] = ["read", "list", "search", "write", "remove", "execute"];

/** The accesses that change what is stored: refused wherever a write is. */
export const MUTATING_ACCESSES: ReadonlySet<PathAccess> = new Set(["write", "remove"]);

/**
 * The accesses the always-open `scratchpad/` permits an essential tool in every
 * state, whatever the state's `allow` list says. Searching and executing are not
 * among them, and a tool a state must grant gets nothing from it.
 */
export const SCRATCHPAD_ACCESSES: ReadonlySet<PathAccess> = new Set(["read", "list", "write", "remove"]);

/** The accesses the context-offload areas permit: readable, never writable. */
export const OFFLOAD_ACCESSES: ReadonlySet<PathAccess> = new Set(["read", "list"]);

/** The path declarations of the tools every assembly registers. */
export const BUILT_IN_TOOL_PATHS: Readonly<Record<string, ToolPaths>> = {
  read_file: { file_path: "read" },
  write_file: { file_path: "write" },
  edit_file: { file_path: "write" },
  ls: { path: "list" },
  glob: { path: "search" },
  grep: { path: "search" },
  [RUN_TOOL]: { file_path: "execute" },
  [COPY_FILE_TOOL]: { source: "read", destination: "write" },
  [MOVE_FILE_TOOL]: { source: "remove", destination: "write" },
  [REMOVE_FILE_TOOL]: { file_path: "remove" },
};

/**
 * Second spellings the built-in file tools accept for their one path argument.
 * Deep Agents' `read_file`, `write_file` and `edit_file` take `path` when
 * `file_path` is absent, so a path rule that read only the declared name would
 * let the other spelling through ungoverned. The kernel reads the declared name
 * first and the alias when it is absent — the tool's own precedence — for every
 * single-path built-in, as it always has.
 */
const BUILT_IN_PATH_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  read_file: { file_path: "path" },
  write_file: { file_path: "path" },
  edit_file: { file_path: "path" },
  ls: { path: "file_path" },
  glob: { path: "file_path" },
  grep: { path: "file_path" },
  [RUN_TOOL]: { file_path: "path" },
};

/** Thrown at assembly for a path declaration the runtime cannot honour. */
export class ToolPathsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolPathsError";
  }
}

/** The resolved table: the built-ins plus a host's declarations. */
export type ToolPathTable = ReadonlyMap<string, ToolPaths>;

/** The table with no host declarations. */
export const BUILT_IN_TOOL_PATH_TABLE: ToolPathTable = new Map(Object.entries(BUILT_IN_TOOL_PATHS));

/**
 * Merge a host's declarations into the built-in table. A declaration for a
 * built-in tool is refused — its paths are the runtime's to govern — as is an
 * access the kernel does not know, so a typo cannot leave an argument ungoverned.
 */
export function resolveToolPaths(host: Readonly<Record<string, ToolPaths>> | undefined): ToolPathTable {
  const table = new Map(BUILT_IN_TOOL_PATH_TABLE);
  for (const [tool, paths] of Object.entries(host ?? {})) {
    if (Object.hasOwn(BUILT_IN_TOOL_PATHS, tool)) {
      throw new ToolPathsError(
        `Tool '${tool}' is a built-in tool; its path arguments are declared by the runtime and ` +
          `cannot be redeclared.`,
      );
    }
    const entries = Object.entries(paths ?? {});
    if (entries.length === 0) {
      throw new ToolPathsError(`Tool '${tool}' declares no path argument; omit its declaration instead.`);
    }
    for (const [arg, access] of entries) {
      if (!PATH_ACCESSES.includes(access)) {
        throw new ToolPathsError(
          `Tool '${tool}' declares argument '${arg}' with access '${String(access)}'; the accesses ` +
            `are ${PATH_ACCESSES.map((a) => `'${a}'`).join(", ")}.`,
        );
      }
    }
    table.set(tool, Object.freeze({ ...paths }));
  }
  return table;
}

/** One path a call names, with the argument it came from and how the call uses it. */
export interface DeclaredPath {
  arg: string;
  access: PathAccess;
  path: string;
}

/** A declared argument's value, read through the built-in alias as the tool itself reads it. */
function declaredValue(tool: string, arg: string, args: Record<string, unknown>): unknown {
  const alias = BUILT_IN_PATH_ALIASES[tool]?.[arg];
  return args[arg] ?? (alias === undefined ? undefined : args[alias]);
}

/**
 * The declared path arguments a call actually carries, in declaration order. An
 * argument holds one path or a list of paths; each path of a list is governed
 * with the argument's access. An argument the call omits names no path, and
 * neither does an empty list. A value of any other shape names no path here
 * either: {@link malformedPathArgs} is how the kernel refuses it.
 */
export function declaredPathsOf(
  tool: string,
  paths: ToolPaths | undefined,
  args: Record<string, unknown>,
): DeclaredPath[] {
  if (!paths) return [];
  const found: DeclaredPath[] = [];
  for (const [arg, access] of Object.entries(paths)) {
    const value = declaredValue(tool, arg, args);
    const list = Array.isArray(value) ? value : [value];
    for (const path of list) if (typeof path === "string") found.push({ arg, access, path });
  }
  return found;
}

/**
 * The declared path arguments a call passes as something other than a path or
 * a list of paths — a number, an object, a list holding one. A path rule cannot
 * read such a value, so the kernel refuses the call rather than let a path
 * inside it through ungoverned.
 */
export function malformedPathArgs(tool: string, paths: ToolPaths | undefined, args: Record<string, unknown>): string[] {
  if (!paths) return [];
  return Object.keys(paths).filter((arg) => {
    const value = declaredValue(tool, arg, args);
    if (value == null || typeof value === "string") return false;
    return !Array.isArray(value) || value.some((path) => typeof path !== "string");
  });
}

/** The arguments a `paths:` guard matches for `tool`: its declared ones, else `file_path`. */
export function pathArgsOf(paths: ToolPaths | undefined): string[] {
  const declared = Object.keys(paths ?? {});
  return declared.length > 0 ? declared : [DEFAULT_PATH_ARG];
}

/**
 * The values a `paths:` guard on `tool` tests: every path of every argument it
 * matches ({@link pathArgsOf}), read through the built-in aliases as the path
 * rules read them — one value for an argument holding a path, one per element
 * for a list, so a grant needs each element to match and a denial any. An
 * argument the call omits, or passes as an empty list, is `undefined`, which no
 * glob matches.
 */
export function pathValuesOf(tool: string, paths: ToolPaths | undefined, args: Record<string, unknown>): unknown[] {
  return pathArgsOf(paths).flatMap((arg) => {
    const value = declaredValue(tool, arg, args);
    if (!Array.isArray(value)) return [value];
    return value.length > 0 ? value : [undefined];
  });
}

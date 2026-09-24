/**
 * A run's record of the spec it executed: the content hash identifying a
 * machine spec, and the snapshot store that resolves one back.
 */
import { createHash } from "node:crypto";
import type { MachineSpec } from "../machine/types.js";
import { createWorkflowEventEmitter, type WorkflowEventHandler } from "../core/events.js";
import type { Workspace } from "../core/workspace.js";
import { specSnapshotPath } from "./paths.js";

/** Serialize with object keys sorted at every level; arrays keep their order (sequence is semantic). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

/** Drop a `metadata` block from one object, returning it unchanged when it has none. */
function withoutMetadata<T extends { metadata?: unknown }>(value: T): T {
  if (value.metadata === undefined) return value;
  const { metadata: _metadata, ...rest } = value;
  return rest as T;
}

/**
 * Strip `metadata` from every inline rubric in one `before`/`after` field,
 * preserving the field's own shape (a single hook stays a single hook).
 */
function hooksWithoutMetadata(field: unknown): unknown {
  const strip = (hook: unknown): unknown => {
    const declaration = (hook as { rubric?: { metadata?: unknown } } | null)?.rubric;
    if (!declaration || typeof declaration !== "object" || declaration.metadata === undefined) {
      return hook;
    }
    return { ...(hook as object), rubric: withoutMetadata(declaration) };
  };
  return Array.isArray(field) ? field.map(strip) : strip(field);
}

/**
 * The spec as a machine: every runtime-inert `metadata` block removed — at the
 * root, on each state, and on each rubric inlined in a state's hooks — so a
 * canvas edit does not mint a new spec version. Returns the spec itself when
 * there is nothing to drop, so specs without the block hash unchanged.
 */
function governingSpec(spec: MachineSpec): MachineSpec {
  const stateHasMetadata = ([, state]: [string, MachineSpec["states"][string]]) =>
    state?.metadata !== undefined ||
    (["before", "after"] as const).some(
      (phase) => hooksWithoutMetadata(state?.[phase]) !== state?.[phase],
    );
  const states = Object.entries(spec.states ?? {});
  if (spec.metadata === undefined && !states.some(stateHasMetadata)) return spec;

  return {
    ...withoutMetadata(spec),
    states: Object.fromEntries(
      states.map(([slug, state]) => {
        const governed = withoutMetadata(state ?? {}) as Record<string, unknown>;
        for (const phase of ["before", "after"] as const) {
          if (governed[phase] === undefined) continue;
          governed[phase] = hooksWithoutMetadata(governed[phase]);
        }
        return [slug, governed];
      }),
    ) as MachineSpec["states"],
  };
}

/** A stable content hash of the machine spec, normalized so cosmetic edits do not change it. */
export function computeSpecHash(spec: MachineSpec): string {
  return createHash("sha256").update(stableStringify(governingSpec(spec))).digest("hex").slice(0, 32);
}

/**
 * Persist the spec for `hash` unless a snapshot already exists. Idempotent: a
 * hit or a lost write race are both success, since the content is determined by
 * the hash. What is written is the hashed document (without presentation
 * metadata), so two specs sharing a hash cannot differ in bytes.
 */
export async function writeSpecSnapshotIfAbsent(
  workspace: Workspace,
  hash: string,
  spec: MachineSpec,
  onEvent?: WorkflowEventHandler,
): Promise<void> {
  const path = specSnapshotPath(hash);
  if (await workspace.exists(path)) return;
  try {
    await workspace.writeJson(path, governingSpec(spec));
  } catch (err) {
    if (await workspace.exists(path)) return;
    createWorkflowEventEmitter(onEvent)({
      type: "warning",
      scope: "spec-snapshot",
      message: `failed to persist spec snapshot for hash '${hash}': ${(err as Error).message}`,
    });
  }
}

/** The persisted spec for `specHash`, or `null` when no snapshot exists for it. */
export async function readSpecSnapshot(
  workspace: Workspace,
  hash: string,
): Promise<MachineSpec | null> {
  return workspace.readJson<MachineSpec>(specSnapshotPath(hash));
}

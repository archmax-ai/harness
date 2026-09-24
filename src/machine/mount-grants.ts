import type { MountAccess, MountGrantEntry } from "./types.js";

/**
 * One mounts grant, in the one shape every reader consults: the mount's name and
 * the access this level asked for, `undefined` meaning "whatever posture the
 * host declared".
 *
 * The two spellings a grant list accepts — a bare name and
 * `{ mount, access }` — normalize here rather than at each reader, the way
 * `normalizeAllowEntry` normalizes the two spellings of a tool entry: the
 * resolution on {@link WorkflowMachine} and `validate` then read one shape and
 * cannot disagree about what the document said.
 */
export interface NormalizedMountGrant {
  readonly mount: string;
  readonly access: MountAccess | undefined;
}

/**
 * Normalize a mounts grant list, dropping entries no well-formed spelling
 * covers.
 *
 * Tolerant of a malformed value on purpose: `validate` builds a machine from a
 * spec whose schema may have failed, so a key can hold anything here, and a
 * non-list is nothing rather than a crash.
 */
export function normalizeMountGrants(
  entries: readonly MountGrantEntry[] | undefined,
): NormalizedMountGrant[] {
  if (!Array.isArray(entries)) return [];
  const grants: NormalizedMountGrant[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      grants.push({ mount: entry, access: undefined });
      continue;
    }
    if (entry !== null && typeof entry === "object" && typeof entry.mount === "string") {
      grants.push({ mount: entry.mount, access: entry.access });
    }
  }
  return grants;
}

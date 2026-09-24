import { redactListing } from "./listing-redact.js";
import { mountNameOf, type MountPrefixes } from "./zones.js";

/**
 * Keep a mount the state cannot reach out of a *listing* — the mounts half of
 * the shared listing filter (`core/listing-redact.ts`, which carries the
 * reasoning and the line shapes), and the twin of `redactDisabledSkills`.
 *
 * The workspace root listing is the case that matters most: a governed mount the
 * state does not have would otherwise appear at the root as a directory the
 * agent then cannot read, which reads to a model as a broken workspace rather
 * than as a capability it was not given.
 */

/** What a state may see of the mount table: the kernel's decision, as data. */
export interface MountVisibility {
  /** The **governed** mounts this state enables (`WorkflowMachine.enabledMounts`). */
  readonly enabled: readonly string[];
  /** Every mount name denied here, governed or not (`forbiddenMounts`). */
  readonly forbidden: readonly string[];
}

/**
 * Drop from `text` every line under a mount this state cannot see: a governed
 * mount no list enabled, or any mount a `forbid` names. A path under no mount,
 * and a path under an ungoverned mount nothing denies, is kept — that mount is
 * visible in every state.
 *
 * Returns the text unchanged when nothing was hidden, so a result the filter has
 * no opinion about is passed through by identity rather than rebuilt.
 */
export function redactHiddenMounts(
  text: string,
  visibility: MountVisibility,
  mounts: MountPrefixes,
): string {
  if (!text) return text;
  const enabled = new Set(visibility.enabled);
  const forbidden = new Set(visibility.forbidden);
  const hidden = (name: string) =>
    forbidden.has(name) || (mounts.governed.includes(name) && !enabled.has(name));
  // Nothing to hide: every mount the table serves is reachable from here.
  const names = [...mounts.dirs, ...mounts.files];
  if (!names.some(hidden)) return text;
  return redactListing(text, (path) => mountNameOf(canonical(path), mounts), hidden);
}

/**
 * A result line's path in the form `mountNameOf` classifies: leading slashes
 * stripped, the shape the tools print (`/catalogs/eu/skus.csv`) reduced to the
 * shape the mount table holds.
 */
function canonical(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/+$/, "");
}

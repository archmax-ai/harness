/**
 * A pinned clock: the instant a governed agent's prompt states as "now" in place
 * of the real time, so a case or an evaluation reads the same date on every run.
 * Set by the host's `clock` option or, per turn, by a case's `clock:` key, which
 * the case driver writes into the run configuration under {@link CLOCK_CONFIG_KEY}.
 * Only the prompt line reads it; every recorded timestamp stays real.
 */

/** The forms a pin takes, as an error message names them. */
export const CLOCK_FORMS =
  "an ISO 8601 date (2026-03-20) or a date-time with Z or an offset (2026-03-20T14:30:00Z)";

/** Where a turn's pin rides in `configurable`, beside the case's tool mocks. */
export const CLOCK_CONFIG_KEY = "__clock";

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * The instant `value` pins, or `undefined` for an empty string (no pin). Throws
 * for anything else, naming the accepted forms. A date-time without a zone is
 * refused, because JavaScript would read it in the machine's own zone and a case
 * would render differently on each machine; so is a date or time that does not
 * exist (`2026-02-30`, `25:00`), which `Date` would silently roll over.
 */
export function parseClock(value: string): Date | undefined {
  if (value === "") return undefined;
  const date = DATE.exec(value);
  const dateTime = date ? null : DATE_TIME.exec(value);
  const m = date ?? dateTime;
  if (!m) throw new Error(`'${value}' is not ${CLOCK_FORMS}`);
  const [y, mo, d, h, mi, s, ms] = [1, 2, 3, 4, 5, 6, 7].map((i) => Number(m[i] ?? 0)) as number[];
  const offsetMinutes =
    dateTime?.[9] === undefined
      ? 0
      : (dateTime[9] === "-" ? -1 : 1) * (Number(dateTime[10]) * 60 + Number(dateTime[11]));
  const written = new Date(Date.UTC(y!, mo! - 1, d!, h!, mi!, s!, ms!));
  // Date.UTC rolls an impossible field over; reading the same fields back catches it.
  const exists =
    written.getUTCFullYear() === y &&
    written.getUTCMonth() === mo! - 1 &&
    written.getUTCDate() === d &&
    written.getUTCHours() === h &&
    written.getUTCMinutes() === mi &&
    written.getUTCSeconds() === s &&
    Number(dateTime?.[11] ?? 0) < 60 &&
    Number(dateTime?.[10] ?? 0) < 24;
  if (!exists) throw new Error(`'${value}' names a date or time that does not exist; use ${CLOCK_FORMS}`);
  return new Date(written.getTime() - offsetMinutes * 60_000);
}

/**
 * The pin a turn's run configuration carries, or `undefined`. A value that is
 * not a string reads as unset; a string that is not a pin throws, because only a
 * host writing the key by hand can produce one, and showing the real time
 * instead would hide the mistake.
 */
export function readClockPin(configurable: Record<string, unknown> | undefined): Date | undefined {
  const value = configurable?.[CLOCK_CONFIG_KEY];
  if (typeof value !== "string") return undefined;
  try {
    return parseClock(value);
  } catch (err) {
    throw new Error(`The run configuration's '${CLOCK_CONFIG_KEY}': ${(err as Error).message}`, { cause: err });
  }
}

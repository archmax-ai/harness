import { afterEach, describe, expect, it, vi } from "vitest";
import { CLOCK_CONFIG_KEY, parseClock, readClockPin } from "./clock.js";

// Every case runs under a non-UTC zone: a pin must mean the same instant on any machine.
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseClock", () => {
  const iso = (value: string) => {
    vi.stubEnv("TZ", "Europe/Berlin");
    return parseClock(value)?.toISOString();
  };

  it("reads a date as midnight UTC and a zoned date-time as its instant", () => {
    expect(iso("2026-03-20")).toBe("2026-03-20T00:00:00.000Z");
    expect(iso("2026-03-20T14:30:00Z")).toBe("2026-03-20T14:30:00.000Z");
    expect(iso("2026-03-20T16:37+02:00")).toBe("2026-03-20T14:37:00.000Z");
    expect(iso("2026-03-20T09:15:30.250-05:00")).toBe("2026-03-20T14:15:30.250Z");
  });

  it("accepts a local date-time that falls on the day before in UTC", () => {
    expect(iso("2026-03-20T01:00+02:00")).toBe("2026-03-19T23:00:00.000Z");
  });

  it("reads an empty string as no pin", () => {
    expect(parseClock("")).toBeUndefined();
  });

  it.each(["2026-03-20T10:00", "2026-02-30", "2026-03-20T25:00Z", "2026-03-20T10:00+25:00", "next tuesday", "20260320"])(
    "refuses %s",
    (value) => {
      vi.stubEnv("TZ", "Europe/Berlin");
      expect(() => parseClock(value)).toThrow(/ISO 8601 date/);
    },
  );
});

describe("readClockPin", () => {
  it("reads a pinned instant and treats a missing or non-string value as unset", () => {
    expect(readClockPin({ [CLOCK_CONFIG_KEY]: "2026-03-20" })?.toISOString()).toBe("2026-03-20T00:00:00.000Z");
    expect(readClockPin(undefined)).toBeUndefined();
    expect(readClockPin({ [CLOCK_CONFIG_KEY]: 1_700_000_000_000 })).toBeUndefined();
    expect(readClockPin({ [CLOCK_CONFIG_KEY]: "" })).toBeUndefined();
  });

  it("throws naming the key for a string that is not a pin", () => {
    expect(() => readClockPin({ [CLOCK_CONFIG_KEY]: "soon" })).toThrow(/'__clock'/);
  });
});

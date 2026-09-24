import { describe, expect, it } from "vitest";
import { BANNER_TEXT, shouldShowBanner } from "./banner.js";

describe("shouldShowBanner", () => {
  it("is true on a TTY with no suppression", () => {
    expect(shouldShowBanner({ env: {}, isTTY: true })).toBe(true);
  });

  it("is false when stderr is not a TTY", () => {
    expect(shouldShowBanner({ env: {}, isTTY: false })).toBe(false);
  });

  it("is false when ARCHMAX_CLI_NO_BANNER is set to a non-empty value", () => {
    expect(shouldShowBanner({ env: { ARCHMAX_CLI_NO_BANNER: "1" }, isTTY: true })).toBe(false);
  });

  it("is true when the suppression variable is an empty string", () => {
    expect(shouldShowBanner({ env: { ARCHMAX_CLI_NO_BANNER: "" }, isTTY: true })).toBe(true);
  });
});

describe("BANNER_TEXT", () => {
  it("fits an 80-column terminal", () => {
    const widest = Math.max(...BANNER_TEXT.split("\n").map((line) => line.length));
    expect(widest).toBeLessThanOrEqual(80);
  });
});

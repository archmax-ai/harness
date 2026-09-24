import { describe, expect, it } from "vitest";
import { createStyle, shouldUseColor } from "./style.js";

describe("shouldUseColor", () => {
  it("is true on a TTY with no suppression", () => {
    expect(shouldUseColor({ env: {}, isTTY: true })).toBe(true);
  });

  it("is false when not a TTY", () => {
    expect(shouldUseColor({ env: {}, isTTY: false })).toBe(false);
  });

  it("is false when NO_COLOR is set to a non-empty value", () => {
    expect(shouldUseColor({ env: { NO_COLOR: "1" }, isTTY: true })).toBe(false);
  });

  it("is true when NO_COLOR is set to an empty string", () => {
    expect(shouldUseColor({ env: { NO_COLOR: "" }, isTTY: true })).toBe(true);
  });
});

describe("createStyle", () => {
  it("wraps text in ANSI codes when color is enabled", () => {
    const s = createStyle({ env: {}, isTTY: true });
    expect(s.bold("hi")).toBe("\x1b[1mhi\x1b[0m");
    expect(s.green("ok")).toBe("\x1b[32mok\x1b[0m");
  });

  it("passes text through unchanged when color is suppressed", () => {
    const s = createStyle({ env: {}, isTTY: false });
    expect(s.bold("hi")).toBe("hi");
    expect(s.green("ok")).toBe("ok");
  });
});

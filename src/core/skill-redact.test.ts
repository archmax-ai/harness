import { describe, expect, it } from "vitest";
import { REDACTED_TOOLS, redactDisabledSkills } from "./skill-redact.js";
import type { SkillPrefixes } from "./skills.js";

const SKILLS: SkillPrefixes = [
  { slug: "order-data", prefix: "skills/order-data" },
  { slug: "order-enrichment", prefix: "skills/order-enrichment" },
  { slug: "refund-policy", prefix: "skills/refund-policy" },
];

const redact = (text: string, enabled: string[]) => redactDisabledSkills(text, enabled, SKILLS);

describe("redactDisabledSkills", () => {
  it("keeps only enabled bundles in an ls listing", () => {
    const listing = [
      "/skills/order-data (directory)",
      "/skills/order-enrichment (directory)",
      "/skills/refund-policy (directory)",
      "/skills/README.md (120 bytes)",
    ].join("\n");
    expect(redact(listing, ["order-data"])).toBe(
      ["/skills/order-data (directory)", "/skills/README.md (120 bytes)"].join("\n"),
    );
  });

  it("keeps only enabled bundles in a glob result", () => {
    const globbed = [
      "/skills/order-data/SKILL.md",
      "/skills/order-enrichment/SKILL.md",
      "/skills/refund-policy/SKILL.md",
    ].join("\n");
    expect(redact(globbed, ["refund-policy"])).toBe("/skills/refund-policy/SKILL.md");
  });

  it("drops a grep file group with its match lines and its separator", () => {
    const grepped = [
      "",
      "/skills/order-data/assets/orders.json:",
      "  3: ACME-1",
      "  7: ACME-2",
      "",
      "/skills/refund-policy/rules.json:",
      "  1: refundWindowDays",
      "  4: escalate",
    ].join("\n");
    expect(redact(grepped, ["order-data"])).toBe(
      ["", "/skills/order-data/assets/orders.json:", "  3: ACME-1", "  7: ACME-2"].join("\n"),
    );
  });

  it("drops a hidden group that comes first, separator and all", () => {
    const grepped = [
      "",
      "/skills/refund-policy/rules.json:",
      "  1: refundWindowDays",
      "",
      "/skills/order-data/assets/orders.json:",
      "  3: ACME-1",
    ].join("\n");
    expect(redact(grepped, ["order-data"])).toBe(
      ["/skills/order-data/assets/orders.json:", "  3: ACME-1"].join("\n"),
    );
  });

  it("keeps match lines that follow a non-skill file", () => {
    const grepped = [
      "/scratchpad/report.md:",
      "  2: ACME-1",
      "",
      "/skills/refund-policy/rules.json:",
      "  1: refundWindowDays",
    ].join("\n");
    expect(redact(grepped, ["order-data"])).toBe(["/scratchpad/report.md:", "  2: ACME-1"].join("\n"));
  });

  it("returns the text unchanged when every discovered skill is enabled", () => {
    const listing = "/skills/order-data (directory)\n/skills/refund-policy (directory)";
    const enabled = ["order-data", "order-enrichment", "refund-policy"];
    expect(redactDisabledSkills(listing, enabled, SKILLS)).toBe(listing);
  });

  it("returns the text unchanged when it mentions no hidden bundle", () => {
    const listing = "/scratchpad/a.md (10 bytes)\n/AGENTS.md (20 bytes)";
    expect(redact(listing, [])).toBe(listing);
  });

  it("hides everything when the state enables no skill", () => {
    const listing = "/skills/order-data (directory)\n/skills/refund-policy (directory)";
    expect(redact(listing, [])).toBe("");
  });

  it("leaves an enabled bundle's own listing complete", () => {
    const listing = [
      "/skills/order-data/SKILL.md (400 bytes)",
      "/skills/order-data/assets (directory)",
      "/skills/order-data/scripts (directory)",
    ].join("\n");
    expect(redact(listing, ["order-data"])).toBe(listing);
  });

  it("is not fooled by a `..` spelling inside a result line", () => {
    const listing = "/skills/order-data/../refund-policy/SKILL.md";
    expect(redact(listing, ["order-data"])).toBe("");
  });

  it("passes through an empty table, an empty string, and a no-match message", () => {
    expect(redactDisabledSkills("/skills/x (directory)", [], [])).toBe("/skills/x (directory)");
    expect(redact("", [])).toBe("");
    expect(redact("No files found in /skills/", [])).toBe("No files found in /skills/");
  });

  it("filters exactly the scoped listing tools", () => {
    expect([...REDACTED_TOOLS].sort()).toEqual(["glob", "grep", "ls"]);
    expect(REDACTED_TOOLS.has("read_file")).toBe(false);
  });
});

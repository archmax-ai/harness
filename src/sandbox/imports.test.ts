import { describe, expect, it } from "vitest";
import {
  findForeignImports,
  ForbiddenSandboxImportError,
  prepareHookSource,
} from "./imports.js";

describe("prepareHookSource", () => {
  it("strips @archmax-ai/harness imports while preserving line count", () => {
    const source = `import { veto } from "@archmax-ai/harness/sandbox";\nconst x = 1;\nx;`;
    const prepared = prepareHookSource(source);
    expect(prepared).not.toContain("import");
    expect(prepared.split("\n").length).toBe(source.split("\n").length);
    expect(prepared).toContain("const x = 1;");
  });

  it("strips multi-line @archmax-ai/harness imports", () => {
    const source = `import {\n  ok,\n  veto,\n} from "@archmax-ai/harness/sandbox";\nok();`;
    const prepared = prepareHookSource(source);
    expect(prepared).not.toContain("from");
    expect(prepared.split("\n").length).toBe(source.split("\n").length);
    expect(prepared).toContain("ok();");
  });

  it("rewrites export default into the hook registration", () => {
    expect(prepareHookSource(`export default async function hook() {}`)).toBe(
      `globalThis.__hookDef = async function hook() {}`,
    );
    expect(prepareHookSource(`export default defineHook(() => {});`)).toBe(
      `globalThis.__hookDef = defineHook(() => {});`,
    );
  });

  it("throws a typed error naming a foreign specifier and file", () => {
    const source = `import fs from "node:fs";`;
    expect(() => prepareHookSource(source, { file: "hooks/x.js" })).toThrow(ForbiddenSandboxImportError);
    try {
      prepareHookSource(source, { file: "hooks/x.js" });
    } catch (err) {
      expect((err as ForbiddenSandboxImportError).specifier).toBe("node:fs");
      expect((err as Error).message).toContain("hooks/x.js");
    }
  });

  it("leaves import-free sources untouched", () => {
    const source = `const a = "import-like string";\na;`;
    expect(prepareHookSource(source)).toBe(source);
  });
});

describe("findForeignImports", () => {
  it("lists non-@archmax-ai/harness specifiers only", () => {
    const source = [
      `import { veto } from "@archmax-ai/harness/sandbox";`,
      `import _ from "lodash";`,
      `import "side-effect";`,
    ].join("\n");
    expect(findForeignImports(source)).toEqual(["lodash", "side-effect"]);
  });

  it("returns empty for clean sources", () => {
    expect(findForeignImports(`import { veto } from "@archmax-ai/harness/sandbox";`)).toEqual([]);
    expect(findForeignImports("const x = 1;")).toEqual([]);
  });
});


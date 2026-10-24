import { describe, expect, it } from "vitest";
import {
  findForeignImports,
  ForbiddenSandboxImportError,
  prepareScriptSource,
} from "./imports.js";

describe("prepareScriptSource", () => {
  it("strips @archmax-ai/harness imports while preserving line count", () => {
    const source = `import { defineCodeState } from "@archmax-ai/harness/sandbox";\nconst x = 1;\nx;`;
    const prepared = prepareScriptSource(source);
    expect(prepared).not.toContain("import");
    expect(prepared.split("\n").length).toBe(source.split("\n").length);
    expect(prepared).toContain("const x = 1;");
  });

  it("strips multi-line @archmax-ai/harness imports", () => {
    const source = `import {\n  defineCodeState,\n  type CodeStateInput,\n} from "@archmax-ai/harness/sandbox";\nrun();`;
    const prepared = prepareScriptSource(source);
    expect(prepared).not.toContain("from");
    expect(prepared.split("\n").length).toBe(source.split("\n").length);
    expect(prepared).toContain("run();");
  });

  it("rewrites export default into the state's registration", () => {
    expect(prepareScriptSource(`export default async function screen() {}`)).toBe(
      `globalThis.__stateDef = async function screen() {}`,
    );
    expect(prepareScriptSource(`export default defineCodeState(() => {});`)).toBe(
      `globalThis.__stateDef = defineCodeState(() => {});`,
    );
  });

  it("throws a typed error naming a foreign specifier and file", () => {
    const source = `import fs from "node:fs";`;
    expect(() => prepareScriptSource(source, { file: "scripts/x.js" })).toThrow(ForbiddenSandboxImportError);
    try {
      prepareScriptSource(source, { file: "scripts/x.js" });
    } catch (err) {
      expect((err as ForbiddenSandboxImportError).specifier).toBe("node:fs");
      expect((err as Error).message).toContain("scripts/x.js");
    }
  });

  it("leaves import-free sources untouched", () => {
    const source = `const a = "import-like string";\na;`;
    expect(prepareScriptSource(source)).toBe(source);
  });
});

describe("findForeignImports", () => {
  it("lists non-@archmax-ai/harness specifiers only", () => {
    const source = [
      `import { defineCodeState } from "@archmax-ai/harness/sandbox";`,
      `import _ from "lodash";`,
      `import "side-effect";`,
    ].join("\n");
    expect(findForeignImports(source)).toEqual(["lodash", "side-effect"]);
  });

  it("returns empty for clean sources", () => {
    expect(findForeignImports(`import { defineCodeState } from "@archmax-ai/harness/sandbox";`)).toEqual([]);
    expect(findForeignImports("const x = 1;")).toEqual([]);
  });
});

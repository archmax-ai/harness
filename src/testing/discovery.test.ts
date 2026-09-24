import { describe, expect, it } from "vitest";
import type { Workspace } from "../core/workspace.js";
import { listCaseFiles } from "./discovery.js";

const TESTS_DIR = "workflows/w/tests";

/** In-memory workspace over a flat path -> content map (dirs derived). */
function fakeWorkspace(files: Record<string, string>): Workspace {
  const paths = Object.keys(files);
  const childrenOf = (dir: string) => {
    const seen = new Map<string, boolean>();
    for (const p of paths) {
      if (!p.startsWith(`${dir}/`)) continue;
      const rest = p.slice(dir.length + 1);
      const head = rest.split("/")[0] as string;
      seen.set(`${dir}/${head}`, rest.includes("/"));
    }
    return [...seen.entries()].map(([path, is_dir]) => ({ path, is_dir }));
  };
  return {
    async listDir(dir: string) {
      const children = childrenOf(dir);
      if (children.length === 0 && !paths.some((p) => p.startsWith(`${dir}/`))) {
        throw new Error(`no such directory: ${dir}`);
      }
      return children;
    },
    async readText(path: string) {
      return files[path] ?? null;
    },
    async exists(path: string) {
      return path in files;
    },
  } as unknown as Workspace;
}

describe("listCaseFiles", () => {
  it("collects yaml cases recursively, sorted, ignoring everything else", async () => {
    const ws = fakeWorkspace({
      [`${TESTS_DIR}/beta.test.yml`]: "",
      [`${TESTS_DIR}/alpha.test.yaml`]: "",
      [`${TESTS_DIR}/legacy.test.js`]: "",
      [`${TESTS_DIR}/nested/gamma.test.yaml`]: "",
      [`${TESTS_DIR}/shared/fixture.json`]: "{}",
      [`${TESTS_DIR}/README.md`]: "not a case",
    });
    expect(await listCaseFiles(ws, TESTS_DIR)).toEqual([
      `${TESTS_DIR}/alpha.test.yaml`,
      `${TESTS_DIR}/beta.test.yml`,
      `${TESTS_DIR}/nested/gamma.test.yaml`,
    ]);
  });

  it("treats a missing tests directory as an empty suite", async () => {
    expect(await listCaseFiles(fakeWorkspace({}), TESTS_DIR)).toEqual([]);
  });
});

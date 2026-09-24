/**
 * Case discovery, shared by the runner and `validateWorkflow` so both see the
 * same suite: every `*.test.yaml` / `*.test.yml` file beneath
 * `workflows/<slug>/tests/`, recursively, sorted by path. Anything else in the
 * directory — fixture files reached through `workspace: { from: … }`, notes, a
 * leftover `*.test.js` — is not a case and is ignored without a diagnostic.
 */
import type { Workspace } from "../core/workspace.js";
import { isTestFile } from "./case-schema.js";

/** List a suite's case files (workspace-relative). A missing directory is an empty suite. */
export async function listCaseFiles(workspace: Workspace, testsDir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await workspace.listDir(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = entry.path.replace(/^\/+/, "").replace(/\/+$/, "");
      if (entry.is_dir) await walk(rel);
      else if (isTestFile(rel)) files.push(rel);
    }
  }

  await walk(testsDir);
  return files.sort();
}

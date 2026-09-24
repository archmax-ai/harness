/**
 * The case document model: the parsed shape a case file yields, the error a
 * malformed one raises, and the path conventions that name a case and its
 * fixtures. The grammar that produces it lives in `case-schema.ts`.
 */
import type { ToolMockSpec } from "../core/tool-mocks.js";

/** A validation failure in a case document, addressed by file and location. */
export class CaseSchemaError extends Error {
  readonly file: string;

  constructor(file: string, at: string | null, detail: string) {
    super(`${file}: ${at ? `${at}: ` : ""}${detail}`);
    this.name = "CaseSchemaError";
    this.file = file;
  }
}

export interface CaseTriggerDecl {
  id: string;
}

/** A workspace seed entry: inline content, or content copied from a file. */
export type CaseWorkspaceEntry =
  { source: "inline"; content: unknown } | { source: "file"; from: string };

/** A reply-content token: a plain substring or a compiled `/pattern/flags`. */
export interface ReplyToken {
  raw: string;
  regex?: RegExp;
}

export type CaseExpectation =
  | { assert: "succeeded" }
  | { assert: "parked"; channel?: "decision" | "input"; state?: string }
  | { assert: "reachedState"; state: string }
  | { assert: "reply"; includes: ReplyToken[]; excludes: ReplyToken[] }
  | { assert: "calledTool"; name: string; input?: Record<string, unknown> }
  | { assert: "notCalledTool"; name: string; input?: Record<string, unknown> }
  /** A call governance **refused** — the agent tried and was blocked. */
  | { assert: "blockedTool"; name: string; input?: Record<string, unknown> }
  | { assert: "usedNoTools" }
  | { assert: "ranWorkflow"; workflow: string; status: "ok" | "error"; count?: number }
  | { assert: "trail"; to?: string; stepKind?: string; reason?: string; count: number }
  | { assert: "noTraversal" }
  | { assert: "triggerArrival"; trigger: string }
  | {
      assert: "variables";
      expect: Record<string, unknown>;
      path?: Record<string, string>;
      locked?: Record<string, boolean>;
    }
  /** A model-scored assertion: the declared `atLeast` is the bar. */
  | { assert: "grade"; closedQA: string; atLeast: number };

export type CaseAction =
  | { action: "send"; message: string }
  | { action: "decide"; to: string; comment?: string }
  | { action: "deliver"; trigger: string; variables?: Record<string, unknown> };

/** One entry of the flat `steps` list: an action, or an assertion bound to the nearest action above it. */
export type CaseStep =
  { kind: "action"; action: CaseAction } | { kind: "assert"; expect: CaseExpectation };

export interface CaseDocument {
  /** Workspace-relative case file path (the case id source). */
  file: string;
  /** The case id: the file path relative to the tests dir, minus the extension. */
  id: string;
  /** Short one-line label for the case — what the CLI prints beside its verdict. */
  title: string;
  /** One or two sentences: the scenario driven and what is asserted. */
  description: string;
  skip?: string;
  trigger?: CaseTriggerDecl;
  /** Variables seeded for every driven turn — the case's own seeds. */
  variables?: Record<string, unknown>;
  workspace: Record<string, CaseWorkspaceEntry>;
  mocks: ToolMockSpec[];
  steps: CaseStep[];
}

export const TEST_FILE_EXTENSIONS = [".test.yaml", ".test.yml"] as const;

/** Whether a path names a YAML case file. */
export function isTestFile(path: string): boolean {
  return TEST_FILE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** Strip the `.test.yaml`/`.test.yml` extension from a case file path. */
export function stripTestExtension(path: string): string {
  for (const ext of TEST_FILE_EXTENSIONS) {
    if (path.endsWith(ext)) return path.slice(0, -ext.length);
  }
  return path;
}

/** The case id for a file: its path relative to the tests dir, minus extension. */
export function caseIdForFile(file: string, testsDir: string): string {
  const rel = file.startsWith(`${testsDir}/`) ? file.slice(testsDir.length + 1) : file;
  return stripTestExtension(rel);
}

/** Every `from:` reference a case declares, for fixture-existence checks. */
export function collectFileReferences(doc: CaseDocument): string[] {
  return Object.values(doc.workspace).flatMap((entry) =>
    entry.source === "file" ? [entry.from] : [],
  );
}

/**
 * Reject a `from:` path that escapes the tests directory. Returns the
 * normalized tests/-relative path.
 */
export function normalizeFixturePath(from: string, file: string): string {
  const out: string[] = [];
  for (const segment of from.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      throw new CaseSchemaError(file, null, `'from: ${from}' escapes the tests directory`);
    }
    out.push(segment);
  }
  if (from.startsWith("/") || out.length === 0) {
    throw new CaseSchemaError(file, null, `'from: ${from}' must be a tests/-relative file path`);
  }
  return out.join("/");
}

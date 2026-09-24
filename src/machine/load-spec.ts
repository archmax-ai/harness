import { parse as parseYaml } from "yaml";
import { parseFrontmatter } from "../core/frontmatter.js";
import type { Workspace } from "../core/workspace.js";
import type { MachineSpec } from "./types.js";
import { validateSpec } from "./validate-spec.js";

/**
 * The distinct ways loading a machine spec can fall short of a usable machine.
 * Each consumer maps these to its own reporting surface (runtime warning events
 * vs. static validator diagnostics), so both agree on *why* a spec is unusable.
 */
export type LoadIssueKind = "missing" | "not-a-mapping" | "schema" | "competing-machines" | "lint";

export interface LoadIssue {
  kind: LoadIssueKind;
  /**
   * `error` issues make the spec unusable (fail-closed), except `lint` errors,
   * which the runtime tolerates and `validate` fails on; `warning` issues are
   * surfaced but the machine still loads.
   */
  severity: "error" | "warning";
  /** Self-describing message, naming the file, for the runtime's warning events. */
  message: string;
  /** Dotted spec field the issue relates to, when the schema or lint named one. */
  field?: string;
}

export interface LoadSpecResult {
  /**
   * The parsed machine spec when a spec file exists and parses to a mapping —
   * even if it later fails the schema, so the static validator can keep
   * inspecting it. `null` only when there is nothing parseable to inspect.
   */
  spec: MachineSpec | null;
  /** Structured problems found while loading; empty when the spec is pristine. */
  issues: LoadIssue[];
  /**
   * Advisory findings from `lintSpec` (kind `lint`): never load-blocking; the
   * runtime emits them as warnings and `archmax validate` reports them (an
   * error-severity lint finding fails validation, not the load).
   */
  lint: LoadIssue[];
  /** Prose addendum: the sibling `WORKFLOW.md` content (empty when absent). */
  body: string;
  /** Workspace-relative path the machine spec was loaded from (for diagnostics). */
  specFile: string;
  /**
   * Whether the loaded spec is a usable machine: it passed the schema and has
   * no error-severity issues. The runtime builds a `WorkflowMachine` only when
   * this is true.
   */
  usable: boolean;
}

/** The two files a workflow is authored in. */
export interface WorkflowSpecPaths {
  /** The machine spec: `workflows/<slug>/workflow.yaml`. */
  workflowYaml: string;
  /** Optional prose addendum: `workflows/<slug>/WORKFLOW.md` (never a spec source). */
  workflow: string;
}

/**
 * Single implementation of machine-spec loading, shared by runtime assembly and
 * the static validator. `workflow.yaml` is the sole spec source: a sibling
 * `WORKFLOW.md` is prose only, and frontmatter there is a `competing-machines`
 * error. Shape, document rules and advisories come from `validateSpec`.
 */
export async function loadMachineSpec(
  workspace: Workspace,
  paths: WorkflowSpecPaths,
): Promise<LoadSpecResult> {
  const specFile = paths.workflowYaml;
  const yamlRaw = await workspace.readText(specFile);
  if (yamlRaw == null) {
    return {
      spec: null,
      issues: [{ kind: "missing", severity: "error", message: `${specFile} not found` }],
      body: "",
      specFile,
      usable: false,
      lint: [],
    };
  }

  const issues: LoadIssue[] = [];
  let data: unknown;
  try {
    data = parseYaml(yamlRaw.replace(/\r(?=\n|$)/g, "")) ?? null;
  } catch {
    data = null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    issues.push({
      kind: "not-a-mapping",
      severity: "error",
      message: `invalid machine spec at ${specFile} (expected a YAML mapping)`,
    });
    return { spec: null, issues, lint: [], body: "", specFile, usable: false };
  }

  // One validator for the loader and the editor-facing `validateSpec`: the
  // shape and document rules here are exactly what it reports.
  const checked = validateSpec(data);
  for (const finding of checked.schema) {
    issues.push({
      kind: "schema",
      severity: "error",
      message: `${specFile}: ${finding.field ? `'${finding.field}': ` : ""}${finding.message}`,
      ...(finding.field ? { field: finding.field } : {}),
    });
  }
  // The lint reads typed fields, so it runs whenever the shape held — including
  // beside a document-level error, so one dangling target does not hide every
  // advisory behind it.
  const lint: LoadIssue[] = checked.lint.map((finding) => ({
    kind: "lint",
    severity: finding.severity,
    message: `${specFile}: ${finding.message}`,
    ...(finding.field ? { field: finding.field } : {}),
  }));
  // The unvalidated mapping is carried forward when the schema rejects it, so the
  // validator's cross-file passes still run; `usable` is false, so nothing runs it.
  const spec = checked.ok && checked.spec ? checked.spec : (data as MachineSpec);

  let body = "";
  const proseRaw = await workspace.readText(paths.workflow);
  if (proseRaw != null) {
    if (parseFrontmatter(proseRaw)) {
      issues.push({
        kind: "competing-machines",
        severity: "error",
        message:
          `${paths.workflow} declares YAML frontmatter but ${specFile} is the ` +
          `machine spec; remove the frontmatter from ${paths.workflow} (it is prose only).`,
      });
    }
    body = proseRaw;
  }

  // A lint error fails `validate`, not the load: the runtime tolerates what it
  // reports, so a run is not refused over a missing button label. Lint lives in
  // its own list so `issues` keeps meaning "what stands between this file and a
  // usable machine" — a host asserting `issues` is empty for a valid spec is right.
  const usable = !issues.some((i) => i.severity === "error");
  return { spec, issues, lint, body, specFile, usable };
}

/**
 * Thrown by `createAgent` when a requested workflow cannot be loaded: its
 * `workflow.yaml` is missing, or exists but has no valid machine spec. Assembly
 * fails closed rather than silently degrading to an ungoverned plain agent.
 */
export class WorkflowLoadError extends Error {
  constructor(
    /** Workflow slug the load was attempted for. */
    readonly workflow: string,
    /** Workspace-relative path of the workflow definition. */
    readonly workflowPath: string,
    /** What went wrong (missing file vs invalid machine spec). */
    readonly problem: string,
  ) {
    super(
      `Cannot load workflow '${workflow}' (${workflowPath}): ${problem}. ` +
        `Run 'archmax validate ${workflow}' for details.`,
    );
    this.name = "WorkflowLoadError";
  }
}

/**
 * Thrown when a turn would start a session on a workflow that declares
 * `disabled: true`. Parked sessions can still be decided, replied to and
 * delivered to; only a new turn is refused.
 */
export class WorkflowDisabledError extends Error {
  constructor(readonly workflow: string) {
    super(
      `workflow '${workflow}' is disabled ('disabled: true' in its workflow.yaml); no session started. ` +
        `Remove that flag to re-enable it. Parked sessions can still be decided, replied to and delivered to.`,
    );
    this.name = "WorkflowDisabledError";
  }
}

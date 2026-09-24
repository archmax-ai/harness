/** Severity of a finding about an authored workspace. */
export type DiagnosticSeverity = "error" | "warning";

/**
 * One finding about a workflow, produced by the spec lint and by
 * `validateWorkflow`, identifying the offending file and/or spec field.
 */
export interface Diagnostic {
  severity: DiagnosticSeverity;
  message: string;
  /** Workspace-relative file the finding relates to, when applicable. */
  file?: string;
  /** Dotted spec field the finding relates to (`states.review.transitions.0.to`). */
  field?: string;
}

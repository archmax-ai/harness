/**
 * Everything that can be said about a `workflow.yaml` **from the document
 * alone**: the shape (`machineSpecSchema`), the document-level cross-references
 * (`refineSpec`) and the advisories (`lintSpec`), as one list of diagnostics.
 *
 * Pure — no workspace, no backend, no machine — so an editor can show the same
 * findings inline that `archmax validate` prints, and the loader reports exactly
 * these. What needs more than the document (hook scripts on disk, sibling
 * workflows, the skill registry, kernel probes) is `validate/validate.ts`.
 */
import type { Diagnostic } from "./diagnostic.js";
import { lintSpec } from "./lint-spec.js";
import { parseMachineSpec, type SpecSchemaIssue } from "./spec-schema.js";
import type { MachineSpec } from "./types.js";

/** What {@link validateSpec} found. */
export interface SpecValidation {
  /**
   * Whether the shape and the document rules held — the spec can be compiled
   * into a machine. An advisory (`lint`) never clears this, even at severity
   * `error`: the runtime tolerates what the lint reports and `validate` fails on it.
   */
  ok: boolean;
  /**
   * The typed spec, when the shape held — also beside a document-level error
   * (a dangling target), so the lint could read it and a caller can too.
   */
  spec?: MachineSpec;
  /** The shape and document-rule findings, each an `error` addressed by its `field`. */
  schema: Diagnostic[];
  /** The advisory findings, warnings and the errors the runtime tolerates. */
  lint: Diagnostic[];
  /** `schema` then `lint`, for a caller that wants one list. */
  diagnostics: Diagnostic[];
}

/** A structural issue as a diagnostic: an error at the key an author has to find. */
export function schemaIssueDiagnostic(issue: SpecSchemaIssue): Diagnostic {
  return {
    severity: "error",
    message: issue.message,
    ...(issue.path ? { field: issue.path } : {}),
  };
}

/**
 * Validate a parsed `workflow.yaml` mapping. Total: never throws, and a document
 * the schema refuses still yields every issue the schema found, so an editor
 * can show a blank transition `description` or a misspelled state key inline
 * rather than as one refusal. `file` is left to the caller.
 */
export function validateSpec(value: unknown): SpecValidation {
  const parsed = parseMachineSpec(value);
  const schema = parsed.ok ? [] : parsed.issues.map(schemaIssueDiagnostic);
  const lint = parsed.spec ? lintSpec(parsed.spec) : [];
  return {
    ok: parsed.ok,
    ...(parsed.spec ? { spec: parsed.spec } : {}),
    schema,
    lint,
    diagnostics: [...schema, ...lint],
  };
}

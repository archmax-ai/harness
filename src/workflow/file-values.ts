/**
 * The governance half of the `file` signature type: whether a session may read
 * the file a `file` value names. Decided by the kernel as a `read_file` of the
 * path on **runtime authority** (`origin: "lifecycle"`) — the authority a hook
 * runs on: the state's allow list and the mount and skill grants do not bind it,
 * but the zone rules and every workflow-wide denial do, a child's inherited ones
 * included. So a host cannot hand a session a path the session could never read,
 * and a child cannot return a file one of its ancestors denied: the runtime
 * copies nothing a caller's own denials put out of reach.
 */
import type { MountPrefixes } from "../core/mounts.js";
import type { SkillPrefixes } from "../core/skills.js";
import { decide, workflowDenials, type GovernanceRule } from "../kernel/kernel.js";
import type { WorkflowMachine } from "../machine/machine.js";
import type { VariableStore } from "../machine/variables.js";
import type { FileValueCheck } from "./signature-checks.js";

/** What one machine's file check is decided with: its kernel inputs and a probe of the bound workspace. */
export interface FileGovernance {
  machine: WorkflowMachine;
  policyRules: GovernanceRule[];
  mountPrefixes: MountPrefixes;
  skills: SkillPrefixes;
  /** What a path names in the workspace of the session the check runs for. */
  kind(path: string): Promise<"file" | "directory" | "missing">;
}

/**
 * The {@link FileGovernance} of one machine: the rules it is governed by (an
 * ancestor's denials among them) plus its **own** workflow-wide denials as
 * rules, which is what binds them on runtime authority — the kernel applies a
 * machine's own `forbid_always` lists to a hook only through a descendant.
 */
export function fileGovernance(opts: {
  machine: WorkflowMachine;
  /** The machine's slug, named by a denial. */
  workflow: string;
  policyRules: GovernanceRule[];
  mountPrefixes: MountPrefixes;
  skills: SkillPrefixes;
  kind: FileGovernance["kind"];
}): FileGovernance {
  return {
    machine: opts.machine,
    policyRules: [...opts.policyRules, ...workflowDenials(opts.machine, opts.workflow)],
    mountPrefixes: opts.mountPrefixes,
    skills: opts.skills,
    kind: opts.kind,
  };
}

/** Why `state` may not read `path` on runtime authority, or `undefined` when it may. */
export function runtimeReadDenial(
  gov: Omit<FileGovernance, "kind">,
  state: string,
  path: string,
  variables: VariableStore,
): string | undefined {
  const verdict = decide(
    gov.machine,
    { kind: "tool-call", state, tool: "read_file", args: { file_path: path }, origin: "lifecycle" },
    gov.policyRules,
    gov.mountPrefixes,
    variables,
    gov.skills,
  );
  return verdict.decision === "block" ? (verdict.reason ?? "the read is denied") : undefined;
}

/** The {@link FileValueCheck} for a session in `state` holding `variables`. */
export function fileValueCheck(gov: FileGovernance, state: string, variables: VariableStore): FileValueCheck {
  return {
    kind: (path) => gov.kind(path),
    denied: (path) => runtimeReadDenial(gov, state, path, variables),
  };
}

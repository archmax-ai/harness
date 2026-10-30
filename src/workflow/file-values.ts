/**
 * The governance half of the `file` signature type: whether a session may read
 * the file a `file` value names. Decided by the kernel as a `read_file` of the
 * path on **runtime authority** (`origin: "runtime"`): the state's surface (its
 * allow list, its skill and mount grants) does not bind it, but the zone rules,
 * the workflow's own mount grants (in any state) and every workflow-wide denial
 * do, a child's inherited ones included. So a host
 * cannot hand a session a path the session could never read, and a child cannot
 * return a file one of its ancestors denied: the runtime copies nothing a
 * caller's own denials put out of reach.
 */
import type { MountPrefixes } from "../core/mounts.js";
import type { SkillPrefixes } from "../core/skills.js";
import { decide, type GovernanceRule } from "../kernel/kernel.js";
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
  /** How many bytes a file there holds; without it, a `maxSize` cannot be met. */
  size?(path: string): Promise<number | undefined>;
}

/**
 * The {@link FileGovernance} of one machine: the rules it is governed by (an
 * ancestor's denials among them). The kernel holds a runtime-authority call to
 * the machine's own grants and `forbid_always` lists itself.
 */
export function fileGovernance(opts: {
  machine: WorkflowMachine;
  policyRules: GovernanceRule[];
  mountPrefixes: MountPrefixes;
  skills: SkillPrefixes;
  kind: FileGovernance["kind"];
  size?: FileGovernance["size"];
}): FileGovernance {
  return {
    machine: opts.machine,
    policyRules: opts.policyRules,
    mountPrefixes: opts.mountPrefixes,
    skills: opts.skills,
    kind: opts.kind,
    ...(opts.size ? { size: opts.size } : {}),
  };
}

/** Why `state` may not read `path` on runtime authority, or `undefined` when it may. */
export function runtimeReadDenial(
  gov: Omit<FileGovernance, "kind" | "size">,
  state: string,
  path: string,
  variables: VariableStore,
): string | undefined {
  const verdict = decide(
    gov.machine,
    { kind: "tool-call", state, tool: "read_file", args: { file_path: path }, origin: "runtime" },
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
    size: (path) => (gov.size ? gov.size(path) : Promise.resolve(undefined)),
    denied: (path) => runtimeReadDenial(gov, state, path, variables),
  };
}

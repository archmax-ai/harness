import type { WorkflowMachine } from "../machine/machine.js";
import { redactHiddenMounts } from "./mount-redact.js";
import type { MountPrefixes } from "./mounts.js";
import { redactDisabledSkills } from "./skill-redact.js";
import type { SkillPrefixes } from "./skills.js";

/**
 * Filter a scoped listing (`ls`, `glob`, `grep`) to what `state` can reach:
 * lines under a skill bundle the state does not enable, then lines under a mount
 * it cannot see. One function for every door to those tools, the model's own
 * calls and a script's or a grader's through the PTC gateway, so the two cannot
 * hide different things.
 *
 * The two filters are independent (a bundle lives inside the `skills/` mount),
 * and both return the text unchanged when they hide nothing.
 */
export function redactStateListing(
  text: string,
  state: string,
  machine: WorkflowMachine,
  skills: SkillPrefixes,
  mounts: MountPrefixes,
): string {
  let out = text;
  if (skills.length > 0) {
    out = redactDisabledSkills(out, machine.enabledSkills(state, skills.map((skill) => skill.slug)), skills);
  }
  if (mounts.governed.length > 0 || machine.workflowForbiddenMounts().length > 0) {
    out = redactHiddenMounts(
      out,
      { enabled: machine.enabledMounts(state, mounts.governed), forbidden: machine.forbiddenMounts(state) },
      mounts,
    );
  }
  return out;
}

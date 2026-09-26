/**
 * Child compositions, composed lazily and memoized by workflow slug **and
 * delegation chain**: the denials a child inherits are every ancestor's, so the
 * same slug reached through two different callers is two compositions.
 *
 * Lazy so a workflow nothing delegates to costs nothing; memoized on the
 * **promise** so concurrent dispatches of one slug under one chain compose it
 * once. Every failure here is a *dispatch* failure, never an assembly failure: a
 * parent must still assemble when a workflow it might delegate to is broken.
 */
import { loadMachineSpec } from "../machine/load-spec.js";
import { WorkflowMachine } from "../machine/machine.js";
import { MANUAL_TRIGGER } from "../machine/triggers.js";
import { workflowPaths } from "../workflow/paths.js";
import {
  SubWorkflowError,
  type DelegationCaller,
  type SubWorkflowRegistry,
  type SubWorkflowRuntime,
} from "../workflow/sub-workflow.js";
import { rubricsAsSubagents, rubricsFromSpec } from "../rubrics/rubrics.js";
import { composeGoverned, inheritedDenials, renderSystemPrompt, type AssemblyContext } from "./compose.js";

interface LoadedSubWorkflow {
  body: string;
  machine: WorkflowMachine;
}

/** Build the registry the root composition and every child dispatch through. */
export function createDelegationRegistry(ctx: AssemblyContext, root: WorkflowMachine): SubWorkflowRegistry {
  const composed = new Map<string, Promise<SubWorkflowRuntime>>();
  /**
   * The child's *machine*, without its agent, so a dispatch can be refused on
   * the target's `requires` for the price of a spec read. Shared with
   * `resolve`, so an accepted dispatch never loads the spec twice.
   */
  const loads = new Map<string, Promise<LoadedSubWorkflow>>();

  function load(target: string): Promise<LoadedSubWorkflow> {
    let loading = loads.get(target);
    if (!loading) {
      // A failed load is not cached: a spec fixed between dispatches should be
      // picked up rather than remembered as broken forever.
      loading = loadSpec(target).catch((err) => {
        loads.delete(target);
        throw err;
      });
      loads.set(target, loading);
    }
    return loading;
  }

  async function loadSpec(target: string): Promise<LoadedSubWorkflow> {
    const paths = workflowPaths(target);
    const loaded = await loadMachineSpec(ctx.authoring, paths);
    if (!loaded.usable || !loaded.spec) {
      const detail = loaded.issues.some((i) => i.kind === "missing")
        ? `no '${paths.workflowYaml}' found`
        : loaded.issues.map((i) => i.message).join("; ") || "no valid machine spec";
      throw new SubWorkflowError("unknown-workflow", target, `Cannot run sub-workflow '${target}': ${detail}.`);
    }
    // Rubrics are deliberately *not* inherited: a child is graded by the
    // standards its own spec declares, so its registry comes from `loaded.spec`
    // when the child runtime is composed, never from the caller's.
    const machine = WorkflowMachine.fromSpec(loaded.spec, ctx.params.essentialTools);
    // A caller enters where a host would: the `manual` entry. A machine with
    // none cannot be started at all (fail-closed, as at the host ingress).
    if (!machine.startStateForTrigger(MANUAL_TRIGGER)) {
      throw new SubWorkflowError(
        "not-delegatable",
        target,
        `Cannot run sub-workflow '${target}': it declares no '${MANUAL_TRIGGER}' trigger ` +
          `entry, so it has no state to start in. Add ` +
          `"trigger: ${MANUAL_TRIGGER}" to the state a session should start in.`,
      );
    }
    return { body: loaded.body, machine };
  }

  async function compose(target: string, caller: DelegationCaller | undefined): Promise<SubWorkflowRuntime> {
    const { body, machine } = await load(target);
    const systemPrompt = await renderSystemPrompt(ctx, machine, body, { workflow: target });
    // The child's graders are its own: a rubric declared in one `workflow.yaml`
    // is not resolvable from another, so a sub-run is held to the standards its
    // own machine declares — and its `task` tool is registered with those.
    const rubrics = rubricsFromSpec(machine.spec);
    const childCtx: AssemblyContext = {
      ...ctx,
      rubrics,
      subagents: rubricsAsSubagents(rubrics, ctx.rubricModel),
    };
    const child = await composeGoverned(childCtx, {
      machine,
      workflow: target,
      systemPrompt,
      trigger: { id: MANUAL_TRIGGER },
      // Denials compose downward and accumulate: the caller hands down what it
      // inherited plus its own policy, so the child may narrow what is permitted
      // but never re-grant what any ancestor forbade. A caller-less resolve (a
      // direct child of the root) inherits the root's alone.
      inheritedPolicyRules: caller?.inheritedPolicyRules ?? inheritedDenials(ctx, root),
      registry,
    });
    // A child is driven exactly as the top-level agent drives itself: through
    // its turn runner, which binds the child's own session and streams its text.
    return { graph: { invoke: child.driver.invoke }, machine };
  }

  const registry: SubWorkflowRegistry = {
    resolve(target, caller) {
      const key = [...(caller?.chain ?? []), target].join(" > ");
      let composing = composed.get(key);
      if (!composing) {
        composing = compose(target, caller).catch((err) => {
          composed.delete(key);
          throw err;
        });
        composed.set(key, composing);
      }
      return composing;
    },
    async signature(target) {
      const { machine } = await load(target);
      const title = machine.spec.title?.trim();
      const signature = machine.signatureForTrigger(MANUAL_TRIGGER);
      return {
        ...(signature?.requires.length ? { requires: signature.requires } : {}),
        ...(signature?.returns.length ? { returns: signature.returns } : {}),
        ...(title ? { title } : {}),
        ...(signature?.description ? { description: signature.description } : {}),
        // Reported, not enforced here: a disabled target still binds a tool so
        // disabling a leaf does not fail every caller; the dispatcher refuses.
        ...(machine.disabled ? { disabled: true } : {}),
      };
    },
  };
  return registry;
}

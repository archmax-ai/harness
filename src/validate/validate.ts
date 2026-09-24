/**
 * Static validation of a workflow scaffold — no model calls.
 *
 * Single-document rules are the schema's (`machine/spec-schema.ts`) and the
 * linter's (`machine/lint-spec.ts`), surfaced through the runtime's loader. This
 * module owns what needs more than one document: the workflow slug, runtime
 * contract, hook files, the skill registry, delegation siblings,
 * offline test cases, and kernel probes that ask the real governance pipeline
 * whether a granted entry would be blocked at run time.
 */
import { canonicalizeRelPath, normalizeRelPath, type Workspace } from "../core/workspace.js";
import { isSlug, SLUG_PATTERN } from "../machine/slug.js";
import { createWorkspaceContext } from "../core/workspace-context.js";
import { normalizeAllowEntry } from "../machine/allow.js";
import {
  normalizeMountGrants,
  type NormalizedMountGrant,
} from "../machine/mount-grants.js";
import { hookKind, normalizeHooks } from "../lifecycle/hook-shape.js";
import { BUILTIN_HOOK_KINDS } from "../lifecycle/runner.js";
import { authoringPlanePrefix, describeAuthoringPrefix } from "../core/mounts.js";
import { ADVANCE_TOOL, RUN_TOOL, UNGRANTABLE_TOOLS, workflowToolName } from "../machine/tool-names.js";
import { MANUAL_TRIGGER, triggerBindings } from "../machine/triggers.js";
import { WorkflowMachine } from "../machine/machine.js";
import { loadMachineSpec } from "../machine/load-spec.js";
import { findForeignImports } from "../sandbox/imports.js";
import {
  specDisabled,
  type Hook,
  type MachineSpec,
  type MachineState,
  type MountGrantEntry,
} from "../machine/types.js";
import { decide } from "../kernel/kernel.js";
import { classifyWorkspacePath, mountNameOfPattern, SESSION_OPEN_DIR } from "../core/zones.js";
import { NO_MOUNTS, type MountPrefixes, type MountSpec } from "../core/mounts.js";
import {
  DEFAULT_SKILL_SOURCES,
  type SkillRegistry,
  inspectSkillSources,
  skillOfPattern,
  skillPrefixes,
} from "../core/skills.js";
import { DEFAULT_WORKFLOW, resolveHookScript, workflowPaths } from "../workflow/paths.js";
import { DEFAULT_SUB_WORKFLOW_DEPTH } from "../workflow/sub-workflow.js";
import {
  resolveRuntimeContract,
  unsupportedRuntimeContractMessage,
} from "../runtime/contract.js";
import {
  CaseSchemaError,
  normalizeFixturePath,
  parseCaseDocument,
  type CaseDocument,
  type CaseWorkspaceEntry,
} from "../testing/case-schema.js";
import { listCaseFiles } from "../testing/discovery.js";
import type { Diagnostic, DiagnosticSeverity } from "../machine/diagnostic.js";

export type { Diagnostic, DiagnosticSeverity } from "../machine/diagnostic.js";

export interface ValidationResult {
  /** False if any `error`-severity diagnostic was produced. */
  valid: boolean;
  workflow: string;
  /** Resolved absolute workspace root the scaffold was validated against; absent when every source was supplied and none was built over a root. */
  rootDir?: string;
  diagnostics: Diagnostic[];
}

export interface ValidateWorkflowOptions {
  /** Workspace root; defaults to the consumer's current working directory. */
  rootDir?: string;
  /** Named workflow under `workflows/<name>/`; defaults to {@link DEFAULT_WORKFLOW}. */
  workflow?: string;
  /**
   * Skill sources, matching the harness's `skills` option (default
   * `["skills/"]`). Validation resolves the registry from the same sources the
   * runtime would, so "this slug exists" means the same thing in both.
   */
  skills?: string[];
  /**
   * The mount table, matching the harness's `workspace.mounts` option. The
   * `mounts` diagnostics are about names and governance the **host** declares,
   * so without the host's table there is nothing to check a `mounts` list
   * against: the zero-config default governs nothing, and every mounts
   * diagnostic stays silent. A host that governs mounts passes the same table it
   * assembles with, so "this mount exists and is governed" means the same thing
   * in both.
   */
  mounts?: Record<string, MountSpec>;
}

type Add = (
  severity: DiagnosticSeverity,
  message: string,
  extra?: { file?: string; field?: string },
) => void;

function finalize(
  workflow: string,
  rootDir: string | undefined,
  diagnostics: Diagnostic[],
): ValidationResult {
  return {
    valid: !diagnostics.some((d) => d.severity === "error"),
    workflow,
    ...(rootDir !== undefined ? { rootDir } : {}),
    diagnostics,
  };
}

/**
 * Statically validate a workflow scaffold (`workflow.yaml` plus referenced
 * skills, lifecycle scripts, sibling workflows and test cases) by
 * reading it through the same backends the runtime uses. Performs only file
 * reads and parsing — "valid" means the runtime can load the scaffold, not that
 * a run will succeed.
 */
export async function validateWorkflow(
  options: ValidateWorkflowOptions = {},
): Promise<ValidationResult> {
  const workflowName = options.workflow ?? DEFAULT_WORKFLOW;
  const paths = workflowPaths(workflowName);
  // Two planes, checked from the right side of each: authoring-plane content
  // (this workflow's spec — its grading rubrics included — its siblings', its
  // hooks and its cases) is read through the authoring workspace, agent-visible
  // content (`skills/`, `AGENTS.md`) through the agent workspace.
  const { rootDir, workspace, authoring, mountPrefixes } = createWorkspaceContext({
    rootDir: options.rootDir,
    ...(options.mounts ? { mounts: options.mounts } : {}),
  });

  const diagnostics: Diagnostic[] = [];
  const add: Add = (severity, message, extra = {}) =>
    diagnostics.push({ severity, message, ...extra });

  // The workflow slug (directory name and CLI argument) takes the same
  // kebab-case shape as a state slug; missing or nonconforming is an **error**.
  if (workflowName.trim() === "") {
    add(
      "error",
      `No workflow slug provided; a workflow is identified by its 'workflows/<slug>/' directory name (e.g. 'order-lookup'), passed as the CLI argument or the 'workflow' option.`,
      { field: "workflow" },
    );
  } else if (!SLUG_PATTERN.test(workflowName)) {
    add(
      "error",
      `Workflow slug '${workflowName}' is not hyphen-separated kebab-case; rename the 'workflows/${workflowName}/' directory to lowercase segments joined by single hyphens (e.g. 'order-lookup') so it matches the slug convention state slugs follow. Give the workflow a 'title' for its human-readable label.`,
      { file: paths.workflowYaml, field: "workflow" },
    );
  }

  const { spec, issues, lint, specFile } = await loadMachineSpec(authoring, paths);
  const blocking = issues.find((i) => i.kind === "missing" || i.kind === "not-a-mapping");
  if (blocking || !spec) {
    if (blocking?.kind === "not-a-mapping") {
      add("error", `${specFile} machine spec is not a YAML mapping`, { file: specFile });
    } else {
      add("error", `No workflow.yaml found for workflow '${workflowName}'`, {
        file: paths.workflowYaml,
      });
    }
    return finalize(workflowName, rootDir, diagnostics);
  }

  // Loader issues (schema errors, lint warnings, a competing WORKFLOW.md) in the
  // loader's own words, so a spec fails here for the same reason it fails to load.
  for (const issue of [...issues, ...lint]) {
    add(issue.severity, issue.message, {
      file: issue.kind === "competing-machines" ? paths.workflow : specFile,
      ...(issue.field ? { field: issue.field } : {}),
    });
  }

  const contract = resolveRuntimeContract(spec.runtime);
  const unsupported = unsupportedRuntimeContractMessage(contract);
  if (unsupported) {
    add("error", unsupported, { file: specFile, field: "runtime" });
  }

  // The schema has already reported a missing or empty `states`; nothing below
  // can run without one.
  const states = spec.states;
  if (!states || typeof states !== "object" || Object.keys(states).length === 0) {
    return finalize(workflowName, rootDir, diagnostics);
  }

  // Build the machine from the parsed spec so static checks decide through the
  // same kernel the runtime uses (validator/runtime parity).
  const machine = WorkflowMachine.fromSpec(spec);

  // Custom hook kinds the workspace declares it will register executors for;
  // the validator accepts these offline (built-in kinds are always accepted).
  const expectedHookKinds = new Set(spec.extensions?.hooks ?? []);


  const skillRegistry = await validateSkills(
    workspace,
    machine,
    spec,
    specFile,
    add,
    options.skills ?? [...DEFAULT_SKILL_SOURCES],
  );

  validateMounts(machine, spec, specFile, add, mountPrefixes);

  for (const [slug, declared] of Object.entries(states)) {
    // A bare `done:` is YAML null; the schema reads it as an empty state, and so
    // does this pass when the schema itself was what failed.
    const state = (declared ?? {}) as MachineState;
    const field = `states.${slug}`;
    validateStateSlug(slug, specFile, add);
    for (const phase of ["before", "after"] as const) {
      await validateHookField(
        authoring,
        workflowName,
        state[phase],
        slug,
        phase,
        field,
        add,
        expectedHookKinds,
      );
    }
    validateStateGovernance(machine, states, slug, state, field, add, mountPrefixes, skillRegistry);
  }

  for (const entry of spec.tools?.allow_always ?? []) {
    const { tool, argMatchers } = normalizeAllowEntry(entry);
    if (!tool) continue;
    if (UNGRANTABLE_TOOLS.has(tool)) {
      add("error", ungrantableReason("tools.allow_always", tool), {
        file: specFile,
        field: "tools.allow_always",
      });
    }
    for (const filePath of argMatchers?.file_path ?? []) {
      const zone = classifyWorkspacePath(filePath);
      if (zone === "run-internal" || zone === "run-offload") {
        add(
          "error",
          `'tools.allow_always' allows '${tool}' on '${filePath}', which targets a runtime-owned run area; the runtime will block it. Write under '${SESSION_OPEN_DIR}/' instead.`,
          { file: specFile, field: "tools.allow_always" },
        );
      }
    }
  }

  await validateSubWorkflows(authoring, workflowName, spec, add);
  await validateOfflineTestCases(authoring, paths.testsDir, spec, add);

  return finalize(workflowName, rootDir, diagnostics);
}

/**
 * Validate the workflow's declarative offline test cases (`tests/**\/*.test.yaml`)
 * offline: schema violations, trigger ids the workflow does not declare, and
 * dangling or escaping `from:` fixture references. Same rules as the case
 * runner (shared modules), reported as diagnostics instead of thrown.
 */
async function validateOfflineTestCases(
  authoring: Workspace,
  testsDir: string,
  spec: MachineSpec,
  add: Add,
): Promise<void> {
  const caseFiles = await listCaseFiles(authoring, testsDir);

  // Every trigger id the machine declares — each one enters a state, so a case
  // naming one that is missing here names nothing.
  const declaredTriggers = new Set(triggerBindings(spec).keys());
  const checkTrigger = (file: string, trigger: { id: string } | undefined, at: string) => {
    if (!trigger || trigger.id === MANUAL_TRIGGER || declaredTriggers.has(trigger.id)) return;
    add(
      "error",
      `'${file}' declares trigger '${trigger.id}', which no state of this workflow declares ` +
        `(declared: ${[...declaredTriggers].sort().join(", ") || `${MANUAL_TRIGGER} only`})`,
      { file, field: at },
    );
  };

  const docs = new Map<string, CaseDocument>();
  for (const file of caseFiles) {
    const source = await authoring.readText(file);
    if (source == null) continue;
    try {
      docs.set(file, parseCaseDocument(file, source, testsDir));
    } catch (err) {
      if (err instanceof CaseSchemaError) {
        add("error", err.message, { file });
        continue;
      }
      throw err;
    }
  }

  // A `deliver` step's trigger id is deliberately not cross-checked against the
  // workflow: a park awaits no declared ids, so any id is deliverable.
  for (const [file, doc] of docs) {
    checkTrigger(file, doc.trigger, "trigger");

    for (const [path, entry] of Object.entries(doc.workspace) as Array<
      [string, CaseWorkspaceEntry]
    >) {
      if (entry.source !== "file") continue;
      let fixture: string;
      try {
        fixture = normalizeFixturePath(entry.from, file);
      } catch (err) {
        add("error", (err as Error).message, { file, field: "workspace" });
        continue;
      }
      if (!(await authoring.exists(`${testsDir}/${fixture}`))) {
        add(
          "error",
          `'${file}' workspace entry '${path}' references 'from: ${entry.from}', but ` +
            `'${testsDir}/${fixture}' does not exist`,
          { file, field: "workspace" },
        );
      }
    }
  }
}

/**
 * Cross-workflow checks for delegation targets: existence, startability,
 * disabled state, and termination within the dispatcher's depth bound. Reads
 * *sibling* workflows, which is why it is the validator's, not the schema's.
 */
async function validateSubWorkflows(
  authoring: Workspace,
  workflowName: string,
  spec: MachineSpec,
  add: Add,
): Promise<void> {
  const machine = WorkflowMachine.fromSpec(spec);
  if (machine.delegationTargets().length === 0) return;

  const loadedSpecs = new Map<string, MachineSpec | null>();

  /** A sibling workflow's spec, or `null` when it is missing or unusable. */
  async function specFor(slug: string): Promise<MachineSpec | null> {
    if (loadedSpecs.has(slug)) return loadedSpecs.get(slug) ?? null;
    const loaded = await loadMachineSpec(authoring, workflowPaths(slug));
    const resolved = loaded.usable && loaded.spec ? loaded.spec : null;
    loadedSpecs.set(slug, resolved);
    return resolved;
  }

  /**
   * Walk the delegation graph depth-first, reporting each problem once. `chain`
   * is the path from the validated workflow down to `current` — both the cycle
   * detector and the depth counter.
   */
  async function walk(current: string, chain: string[], field: string): Promise<void> {
    const currentSpec = current === workflowName ? spec : await specFor(current);
    if (!currentSpec) return;
    const currentMachine = WorkflowMachine.fromSpec(currentSpec);

    for (const slug of currentMachine.reachableStates()) {
      for (const target of currentMachine.delegationTargets(slug)) {
        const entry = workflowToolName(target);
        const where =
          current === workflowName
            ? `state '${slug}' allows '${entry}'`
            : `workflow '${current}' (state '${slug}') allows '${entry}'`;
        if (!isSlug(target)) {
          add(
            "error",
            `${where}, whose target '${target}' is not hyphen-separated kebab-case. A workflow ` +
              `slug is its 'workflows/<slug>/' directory name (e.g. 'enrich-account').`,
            { field },
          );
          continue;
        }

        if (chain.includes(target)) {
          add(
            "error",
            `${where}, which is already running in this chain ` +
              `(${[...chain, target].join(" → ")}). The delegation would never terminate.`,
            { field },
          );
          continue;
        }

        const targetSpec = await specFor(target);
        if (!targetSpec) {
          add(
            "error",
            `${where}, but 'workflows/${target}/workflow.yaml' is missing or has no valid ` +
              `machine spec.`,
            { field },
          );
          continue;
        }

        const targetMachine = WorkflowMachine.fromSpec(targetSpec);
        // A caller enters where a host would: a machine with no `manual` entry
        // has no state to start in. Worded to match the assembly-time diagnostic.
        if (!targetMachine.startStateForTrigger(MANUAL_TRIGGER)) {
          add(
            "error",
            `${where}, but '${target}' declares no ` +
              `'${MANUAL_TRIGGER}' trigger, so it has no state to start in. Add ` +
              `"triggers: { ${MANUAL_TRIGGER}: }" to the state a run should start in.`,
            { field },
          );
          continue;
        }

        // A disabled target is a deliberate, reversible operational state, so a
        // **warning** on the caller: the tool is still bound, only the dispatch
        // refuses.
        if (specDisabled(targetSpec)) {
          add(
            "warning",
            `${where}, but '${target}' is disabled ('disabled: true' in its workflow.yaml), so ` +
              `that call will be refused at runtime. The tool is still bound and the rest of ` +
              `this workflow still runs; re-enable '${target}' or stop allowing it.`,
            { field },
          );
        }

        const nextChain = [...chain, target];
        // Depth counts delegations, not workflows, so the root does not consume a level.
        const depth = nextChain.length - 1;
        if (depth > DEFAULT_SUB_WORKFLOW_DEPTH) {
          add(
            "error",
            `${where}, reaching ${depth} levels ` +
              `(${nextChain.join(" → ")}), past the dispatcher's default depth bound of ${DEFAULT_SUB_WORKFLOW_DEPTH}.`,
            { field },
          );
          continue;
        }
        await walk(target, nextChain, field);
      }
    }
  }

  await walk(workflowName, [workflowName], "states");
}

/**
 * The one wording for a grant of a tool no state may be given. `task` is the
 * framework's dispatch for grading rubrics, which the runtime uses on its own
 * authority: the entry reads as a grant but confers nothing, because disclosure
 * withholds the tool and the kernel refuses the call.
 */
function ungrantableReason(where: string, tool: string): string {
  return (
    `${where} allows '${tool}', which is not grantable. It is the runtime's own dispatch for ` +
    `grading rubrics — a rubric grades the agent rather than serving it — so the tool is ` +
    `disclosed in no state and the kernel refuses the call. Remove the entry; to delegate work ` +
    `to another process, allow that workflow's 'archmax_workflow_<slug>' tool instead.`
  );
}

/**
 * Check what a hook *refers to*: a `script` file that exists in the workflow's
 * `hooks/` directory and imports only from `@archmax-ai/harness/*`, or a custom kind
 * declared under `extensions.hooks`. The hook's own shape is the schema's.
 *
 * A `{ rubric: … }` hook needs no check here: a rubric is declared in the same
 * document, so the reference is resolved by the schema's own document-level
 * refinement — one implementation for the loader and the validator, with no file
 * read and no "exists but is unloadable" middle state to report.
 */
async function validateHookField(
  authoring: Workspace,
  workflow: string,
  declared: MachineState["before"],
  slug: string,
  phase: "before" | "after",
  field: string,
  add: Add,
  expectedHookKinds: Set<string>,
): Promise<void> {
  for (const hook of normalizeHooks(declared)) {
    const kind = hookKind(hook as Hook);
    // A malformed hook was reported by the schema; there is nothing to look up.
    if (!kind) continue;
    if (kind === "script") {
      const script = String((hook as { script: unknown }).script);
      // Resolved with the same helper the runtime uses, so a misplaced hook is an
      // offline diagnostic instead of a fail-closed veto mid-run.
      const resolved = resolveHookScript(workflow, script);
      if (!resolved.ok) {
        add("error", `State '${slug}' '${phase}' ${resolved.reason}`, {
          file: script,
          field: `${field}.${phase}`,
        });
        continue;
      }
      const source = await authoring.readText(resolved.path);
      if (source == null) {
        add("error", `State '${slug}' '${phase}' hook script not found: ${resolved.path}`, {
          file: resolved.path,
          field: `${field}.${phase}`,
        });
      } else {
        for (const specifier of findForeignImports(source)) {
          add(
            "error",
            `Hook script '${resolved.path}' imports from '${specifier}'; sandbox scripts may ` +
              `import only from '@archmax-ai/harness/*' type-carrier entry points`,
            { file: resolved.path, field: `${field}.${phase}` },
          );
        }
      }
    } else if (!BUILTIN_HOOK_KINDS.includes(kind as (typeof BUILTIN_HOOK_KINDS)[number]) && !expectedHookKinds.has(kind)) {
      // A custom kind is acceptable offline only when declared under
      // `extensions.hooks`: the executor is registered at assembly, which the
      // validator cannot see.
      add(
        "error",
        `State '${slug}' '${phase}' hook uses unknown kind '${kind}'; built-in kinds are ` +
          `${BUILTIN_HOOK_KINDS.join(" and ")}. ` +
          `Declare custom kinds under 'extensions.hooks' if an executor is registered at runtime.`,
        { field: `${field}.${phase}` },
      );
    }
  }
}

/**
 * Skill governance against the registry, resolved through the runtime's own
 * discovery path. The runtime silently drops an unknown slug and intersects a
 * state list with the root list; this is where an author is told about each.
 *
 * Two warnings carry the "enabled by nothing" case. A root slug no state enables
 * is an editing leftover. A spec with **no root block at all**, in a workspace
 * that serves bundles, is the shape that used to inherit them: it is told once,
 * naming what it cannot reach. An explicit `allow: []` says the workflow uses no
 * skill and is left alone — the registry is workspace-wide while enablement is
 * per workflow, so a bundle another workflow owns is not this one's problem.
 */
async function validateSkills(
  workspace: Workspace,
  machine: WorkflowMachine,
  spec: MachineSpec,
  specFile: string,
  add: Add,
  sources: readonly string[],
): Promise<SkillRegistry> {
  const { registry, issues } = await inspectSkillSources(workspace, sources);
  for (const issue of issues) {
    add(issue.severity, issue.message, { field: "skills" });
  }

  const known = [...registry.keys()];
  const knownList = known.length > 0 ? known.join(", ") : "(the workspace provides none)";

  /** The slugs one skills list names that the registry provides. */
  const provided = (allow: string[] | undefined, field: string, where: string): string[] | undefined => {
    if (!Array.isArray(allow)) return undefined;
    const slugs: string[] = [];
    for (const slug of allow) {
      if (typeof slug !== "string") continue; // reported by the schema
      if (!registry.has(slug)) {
        add(
          "error",
          `${where}'${field}' names skill '${slug}', which no source provides. ` +
            `Known skills: ${knownList}.`,
          { file: specFile, field },
        );
        continue;
      }
      slugs.push(slug);
    }
    return slugs;
  };

  const rootDeclared = spec.skills !== undefined;
  // Called for their diagnostics: a slug no source provides is an error under
  // every key, addressed at the key that named it.
  provided(spec.skills?.allow_always, "skills.allow_always", "");
  provided(spec.skills?.forbid_always, "skills.forbid_always", "");

  for (const [slug, declared] of Object.entries(spec.states)) {
    const state = (declared ?? {}) as MachineState;
    provided(state.skills?.allow, `states.${slug}.skills.allow`, `State '${slug}' `);
    provided(state.skills?.forbid, `states.${slug}.skills.forbid`, `State '${slug}' `);
  }

  // The shape that used to inherit the whole registry. Said once, and only for an
  // absent block: a declared list — `allow_always: []` included — is an author
  // stating what this workflow grants workflow-wide.
  if (!rootDeclared && known.length > 0) {
    add(
      "warning",
      `This workflow declares no root 'skills' block, so nothing here can read a bundle or run ` +
        `its scripts. The workspace provides: ${knownList}. Add a root 'skills.allow_always' list ` +
        `for the skills every state needs, name state-specific ones in a state's own ` +
        `'skills.allow', or write 'skills: { allow_always: [] }' to say this workflow grants none ` +
        `workflow-wide.`,
      { file: specFile, field: "skills" },
    );
  }

  return registry;
}

/**
 * Mount governance against the workspace's resolved table — the mounts twin of
 * {@link validateSkills}, and the only place an author is told that a `mounts`
 * entry reaches nothing.
 *
 * The table is the consumer's wiring, so a name it does not carry is an
 * **error**: the runtime would drop it silently and the state would quietly
 * reach less than the document says. Everything else is a warning about an inert
 * entry, in the same family as the skills diagnostics: a grant on an ungoverned
 * mount (visible everywhere already), a name at both levels, a state `allow: []`
 * beside a non-empty always-on grant, a `forbid` governing nothing, and a
 * `forbid_always` name some list also grants.
 */
function validateMounts(
  machine: WorkflowMachine,
  spec: MachineSpec,
  specFile: string,
  add: Add,
  mounts: MountPrefixes,
): void {
  const known = [...mounts.dirs, ...mounts.files];
  const knownList = known.length > 0 ? known.join(", ") : "(the workspace mounts none)";
  const governedList =
    mounts.governed.length > 0
      ? mounts.governed.join(", ")
      : "(the workspace governs none)";

  /** Report every name one list carries that the table does not. */
  const carried = (names: unknown, field: string, where: string): string[] => {
    if (!Array.isArray(names)) return [];
    const out: string[] = [];
    for (const name of names) {
      if (typeof name !== "string") continue; // reported by the schema
      if (!known.includes(name)) {
        add(
          "error",
          `${where}'${field}' names mount '${name}', which the workspace does not mount. ` +
            `Mounts: ${knownList}.`,
          { file: specFile, field },
        );
        continue;
      }
      out.push(name);
    }
    return out;
  };

  /**
   * The grants one list carries that the table mounts, plus the diagnostic for
   * an `access: read_write` the host's posture cannot honour — the write ceiling
   * is the wiring's, so asking past it is inert rather than an error.
   */
  const granted = (
    entries: readonly MountGrantEntry[] | undefined,
    field: string,
    where: string,
  ): NormalizedMountGrant[] => {
    const grants = normalizeMountGrants(entries);
    const names = carried(
      grants.map((grant) => grant.mount),
      field,
      where,
    );
    const kept = grants.filter((grant) => names.includes(grant.mount));
    for (const grant of kept) {
      if (grant.access !== "read_write" || mounts.writable.includes(grant.mount)) continue;
      add(
        "warning",
        `${where}'${field}' asks for 'access: read_write' on mount '${grant.mount}', which the ` +
          `workspace serves read-only, so the entry opens nothing — the host's write posture is ` +
          `the ceiling. Drop the access, or have the host mount it '{ readOnly: false }'.`,
        { file: specFile, field },
      );
    }
    return kept;
  };

  const alwaysAllow = granted(spec.mounts?.allow_always, "mounts.allow_always", "").map(
    (grant) => grant.mount,
  );
  // Called for its diagnostics: a name the table does not carry is an error
  // under every key, addressed at the key that named it.
  carried(spec.mounts?.forbid_always, "mounts.forbid_always", "");

  /** A grant naming an ungoverned mount adds nothing: it is visible everywhere. */
  const inertGrant = (names: readonly string[], field: string, where: string): void => {
    for (const name of names) {
      if (mounts.governed.includes(name)) continue;
      add(
        "warning",
        `${where}'${field}' names mount '${name}', which the workspace does not declare ` +
          `governed, so the entry grants nothing — an ungoverned mount is visible in every ` +
          `state already. Governed mounts: ${governedList}. Use 'mounts.forbid' to take one ` +
          `away from a state.`,
        { file: specFile, field },
      );
    }
  };

  inertGrant(alwaysAllow, "mounts.allow_always", "");

  for (const [slug, declared] of Object.entries(spec.states)) {
    const state = (declared ?? {}) as MachineState;
    const at = `states.${slug}.mounts`;
    const where = `State '${slug}' `;
    const allow = granted(state.mounts?.allow, `${at}.allow`, where).map((grant) => grant.mount);
    const forbid = carried(state.mounts?.forbid, `${at}.forbid`, where);
    inertGrant(allow, `${at}.allow`, where);

    // A `forbid` governs nothing when nothing would have reached the mount here:
    // an ungoverned mount is always reachable, so only a governed one can be inert.
    for (const name of forbid) {
      if (!mounts.governed.includes(name)) continue;
      const wouldReach = alwaysAllow.includes(name) || allow.includes(name);
      if (wouldReach) continue;
      add(
        "warning",
        `${where}forbids mount '${name}', which nothing enables here — neither ` +
          `'mounts.allow_always' nor this state's own 'mounts.allow' names it — so the entry ` +
          `governs nothing.`,
        { file: specFile, field: `${at}.forbid` },
      );
    }
  }

  // The shape that reaches none of the workspace's governed content. Said once,
  // and only for an absent block: a declared list — `allow_always: []`
  // included — is an author stating what this workflow reaches.
  if (spec.mounts === undefined && mounts.governed.length > 0) {
    add(
      "warning",
      `This workflow declares no root 'mounts' block, so it can reach none of the workspace's ` +
        `governed mounts: ${governedList}. Add a root 'mounts.allow_always' list for the ones ` +
        `every state needs, name state-specific ones in a state's own 'mounts.allow', or write ` +
        `'mounts: { allow_always: [] }' to say this workflow reaches none workflow-wide.`,
      { file: specFile, field: "mounts" },
    );
  }
}

/**
 * Kernel probes for one state's `tools.allow`: entries the spec grants that the
 * runtime would nonetheless refuse (a runtime-owned or read-only zone, a
 * denied path or tool, an `archmax_run` path outside every skill bundle,
 * a path inside a bundle the state does not enable, the authoring plane) and
 * `archmax_advance` targets with no matching edge. Decided through the same
 * kernel the runtime uses, so the diagnostic and the enforcement cannot diverge.
 */
function validateStateGovernance(
  machine: WorkflowMachine,
  states: Record<string, unknown>,
  slug: string,
  state: MachineState,
  field: string,
  add: Add,
  mountPrefixes: MountPrefixes = NO_MOUNTS,
  skillRegistry: SkillRegistry = new Map(),
): void {
  const entries = (state.tools?.allow ?? []).map(normalizeAllowEntry);

  for (const { tool } of entries) {
    if (tool && UNGRANTABLE_TOOLS.has(tool)) {
      add("error", ungrantableReason(`State '${slug}'`, tool), { field: `${field}.tools.allow` });
    }
  }

  for (const { tool, argMatchers } of entries) {
    if (tool !== ADVANCE_TOOL || !argMatchers) continue;
    for (const target of argMatchers.to ?? []) {
      if (target.includes("*")) continue;
      if (!(target in states)) {
        add("warning", `State '${slug}' allows ${ADVANCE_TOOL} to undefined state '${target}'`, {
          field: `${field}.tools.allow`,
        });
        continue;
      }
      // An allowed advance target with no declared edge passes tool governance
      // but the kernel blocks the transition.
      const edge = decide(machine, { kind: "transition", from: slug, to: target, hookFacts: [] });
      if (edge.decision === "block") {
        add(
          "warning",
          `State '${slug}' allows ${ADVANCE_TOOL} to '${target}' but declares no transition edge to it; the runtime will block the transition`,
          { field: `${field}.transitions` },
        );
      }
    }
  }

  // `archmax_run` is confined to skill bundles by a non-overridable safety rule,
  // so an entry naming paths outside one is inert — and reads as permissive.
  const bundlePrefixes = skillPrefixes(skillRegistry);
  /** Whether a pattern can match anything inside a skill bundle (or an ancestor of one). */
  const reachesABundle = (pattern: string): boolean => {
    if (skillOfPattern(pattern, bundlePrefixes) != null) return true;
    const literal = normalizeRelPath(pattern).split(/[*?[{]/, 1)[0] ?? "";
    const upTo = literal.slice(0, literal.lastIndexOf("/") + 1);
    return upTo !== "" && bundlePrefixes.some(({ prefix }) => `${prefix}/`.startsWith(upTo));
  };
  for (const { tool, argMatchers } of entries) {
    if (tool !== RUN_TOOL || !argMatchers) continue;
    const inert = (argMatchers.file_path ?? []).filter((pattern) => !reachesABundle(pattern));
    if (inert.length === 0) continue;
    add(
      "error",
      `State '${slug}' allows '${RUN_TOOL}' on ${inert.map((p) => `'${p}'`).join(", ")}, which is ` +
        `outside every skill bundle. '${RUN_TOOL}' may only execute scripts in a skill bundle ` +
        `(rule 'script.skill-only'), so this entry grants nothing — scope it to a capability's ` +
        `scripts (e.g. 'skills/<name>/scripts/**'). Lifecycle hook scripts are not run this way: ` +
        `they live in 'workflows/<slug>/hooks/' and are executed by the harness.`,
      { field: `${field}.tools.allow` },
    );
  }

  // An entry naming the authoring plane: no plane prefix is routed into the
  // agent's workspace, so such a path silently resolves inside the run's own zone.
  for (const { tool, argMatchers } of entries) {
    if (!argMatchers) continue;
    for (const filePath of argMatchers.file_path ?? []) {
      const { path: rel } = canonicalizeRelPath(filePath);
      const prefix = authoringPlanePrefix(rel);
      if (!prefix) continue;
      add(
        "error",
        `State '${slug}' allows '${tool}' on '${filePath}', which names the authoring ` +
          `plane ('${prefix}/'). That prefix holds ${describeAuthoringPrefix(prefix)}; ` +
          `it is served to the harness by the authoring backend and is not routed into the ` +
          `agent's workspace, so this path resolves inside the run's own zone instead and the entry ` +
          `does not mean what it reads as.`,
        { field: `${field}.tools.allow` },
      );
    }
  }

  // Writes the kernel will refuse even though the state's list permits them.
  for (const { tool, argMatchers } of entries) {
    if ((tool !== "write_file" && tool !== "edit_file") || !argMatchers) continue;
    for (const filePath of argMatchers.file_path ?? []) {
      // The zone checks apply to globs too (`checkpoints/**` shares the prefix),
      // so they run before the concrete-path kernel probe below.
      const zone = classifyWorkspacePath(filePath);
      if (zone === "run-internal" || zone === "run-offload") {
        add(
          "error",
          `State '${slug}' allows '${tool}' on '${filePath}', which targets a runtime-owned run area; the runtime will block it. Write under '${SESSION_OPEN_DIR}/' instead.`,
          { field: `${field}.tools.allow` },
        );
        continue;
      }
      if (filePath.includes("*")) continue;
      const verdict = decide(
        machine,
        { kind: "tool-call", state: slug, tool, args: { file_path: filePath } },
        [],
        mountPrefixes,
      );
      if (verdict.ruleId === "zone.read-only") {
        add(
          "error",
          `State '${slug}' allows '${tool}' on '${filePath}', which is in the read-only authored zone; the runtime will block it. Write under '${SESSION_OPEN_DIR}/' instead.`,
          { field: `${field}.tools.allow` },
        );
      } else if (verdict.ruleId === "tool.forbidden" || verdict.ruleId === "tool.forbidden-here") {
        const where =
          verdict.ruleId === "tool.forbidden"
            ? "the workflow denies in every state ('tools.forbid_always')"
            : `this state denies ('states.${slug}.tools.forbid')`;
        add(
          "error",
          `State '${slug}' allows '${tool}' on '${filePath}', which ${where}; a denial beats every grant, so the runtime will block it.`,
          { field: `${field}.tools.allow` },
        );
      }
    }
  }

  // A path entry that can only ever match inside a skill bundle this state does
  // not enable: the runtime refuses every call it would permit.
  if (skillRegistry.size > 0) {
    const table = skillPrefixes(skillRegistry);
    const enabled = new Set(machine.enabledSkills(slug, [...skillRegistry.keys()]));
    for (const { tool, argMatchers } of entries) {
      if (!tool || !argMatchers) continue;
      for (const pattern of argMatchers.file_path ?? []) {
        const owner = skillOfPattern(pattern, table);
        if (owner == null || enabled.has(owner)) continue;
        add(
          "error",
          `State '${slug}' allows '${tool}' on '${pattern}', which can only match inside skill ` +
            `'${owner}' — a skill this state does not enable, so the runtime blocks every such ` +
            `call. Add '${owner}' to this state's 'skills.allow' (or the workflow's ` +
            `'skills.allow_always'), check it is not denied by a 'forbid' list, or drop the entry.`,
          { field: `${field}.tools.allow` },
        );
      }
    }
  }

  // A path entry that can only ever match inside a mount this state cannot
  // reach: the runtime refuses every call it would permit. A warning rather than
  // an error, because the mount table is the host's wiring and a workflow may
  // legitimately be authored against one workspace and validated in another.
  if (mountPrefixes.governed.length > 0) {
    const enabled = new Set(machine.enabledMounts(slug, mountPrefixes.governed));
    for (const { tool, argMatchers } of entries) {
      if (!tool || !argMatchers) continue;
      for (const pattern of [...(argMatchers.file_path ?? []), ...(argMatchers.path ?? [])]) {
        const owner = mountNameOfPattern(pattern, mountPrefixes);
        if (owner == null || !mountPrefixes.governed.includes(owner) || enabled.has(owner)) continue;
        add(
          "warning",
          `State '${slug}' allows '${tool}' on '${pattern}', which can only match inside mount ` +
            `'${owner}' — a mount this state does not enable, so the runtime blocks every such ` +
            `call and the grant reaches nothing. Add '${owner}' to this state's 'mounts.allow' ` +
            `(or the workflow's 'mounts.allow_always'), check no 'forbid' list denies it, or ` +
            `drop the entry.`,
          { field: `${field}.tools.allow` },
        );
      }
    }
  }

  // A tool a denial covers outright: blocked wherever the denial reaches, so the
  // grant beside it governs nothing.
  for (const { tool } of entries) {
    if (!tool) continue;
    const verdict = decide(machine, { kind: "tool-call", state: slug, tool, args: {} }, [], mountPrefixes);
    if (verdict.ruleId === "tool.forbidden") {
      add(
        "error",
        `State '${slug}' allows '${tool}', which 'tools.forbid_always' denies in every state; a denial beats every grant, so the runtime will block it everywhere.`,
        { field: `${field}.tools.allow` },
      );
    } else if (verdict.ruleId === "tool.forbidden-here") {
      add(
        "error",
        `State '${slug}' allows '${tool}' and forbids it in the same state ('states.${slug}.tools.forbid'); the denial wins, so the runtime will block every such call.`,
        { field: `${field}.tools.allow` },
      );
    }
  }
}

/**
 * Check a state's slug: present, and shaped like a slug. Static only — the
 * runtime treats a slug as opaque, so a nonconforming slug still runs.
 */
function validateStateSlug(slug: string, specFile: string, add: Add): void {
  if (slug.trim() === "") {
    add(
      "error",
      `A state is declared with an empty slug; a state's key IS its slug — the identity every transition target, trigger id, and test assertion references — so give it a kebab-case slug (e.g. 'identify-case') and put any human-readable label in 'title'`,
      { file: specFile, field: "states" },
    );
    return;
  }
  if (SLUG_PATTERN.test(slug)) return;
  add(
    "error",
    `State slug '${slug}' is not a valid slug; use hyphen-separated kebab-case — lowercase letters and digits in segments joined by single hyphens (e.g. 'identify-case', 'refund-review'), with no underscores, capitals, or leading/trailing hyphens. The slug is the state's identity — every transition target, trigger id, and test assertion references it, and the agent passes it to archmax_advance — so give the state a 'title' for its human-readable label instead`,
    { file: specFile, field: `states.${slug}` },
  );
}

#!/usr/bin/env node
/**
 * The `archmax` binary. A declarative command table drives parsing (Node's own
 * `util.parseArgs`, strict), help text (generated from the table, top-level and
 * per command) and dispatch.
 *
 * Output discipline, every command alike: **results on stdout** (a reply, a
 * verdict line, a listing, or `--json`), **narration on stderr** (the session
 * header, the state flow, warnings, the usage footer). Exit codes: 0 for
 * success or a park, 1 for a failure, 2 for a usage error.
 */
import { realpathSync } from "node:fs";
import { argv, exit } from "node:process";
import { fileURLToPath } from "node:url";
import { runTests } from "./testing/runner.js";
import { validateWorkflow, type Diagnostic } from "./validate/validate.js";
import { printBanner } from "./cli/banner.js";
import { createStyle, icons, type Style } from "./cli/style.js";
import { createTestView } from "./cli/state-flow.js";
import { formatUsage, hasUsage } from "./core/usage.js";
import {
  CliError,
  UsageError,
  commandHelp,
  err,
  out,
  parseInvocation,
  topLevelHelp,
  type Command,
  type OptionSpec,
  type Positional,
} from "./cli/command.js";
import {
  bootstrap,
  createEventSink,
  isKnown,
  parseVariablesJson,
  printSessionHeader,
  resolveWorkflow,
  withSession,
} from "./cli/bootstrap.js";
import {
  driveTurn,
  printDecisionContext,
  printReply,
  printResumed,
  printUsageFooter,
} from "./cli/turn.js";

/** `--variables` parsing, re-exported for tests. */
export { parseVariablesJson };

// ---------------------------------------------------------------------------
// The command table

const OPT = {
  verbose: { type: "boolean", description: "Print raw lifecycle event lines to stderr" },
  json: {
    type: "boolean",
    description: "Write a machine-readable result to stdout, nothing else there",
  },
  workflow: {
    type: "string",
    placeholder: "<slug>",
    description: "Workflow the session belongs to (inferred when the workspace has exactly one)",
  },
  variables: {
    type: "string",
    placeholder: "<json>",
    description: 'Variables as a JSON object, seeded locked, e.g. \'{"from_email":"a@b.com"}\'',
  },
} satisfies Record<string, OptionSpec>;
const WORKFLOW_ARG: Positional = {
  name: "workflow",
  required: true,
  description: "Workflow slug under workflows/ (may be omitted when the workspace has exactly one)",
};
const SESSION_ARG: Positional = {
  name: "session",
  required: true,
  description: "Session id, as listed by 'archmax sessions'",
};

// ---------------------------------------------------------------------------
// Commands

function formatDiagnostic(style: Style, d: Diagnostic): string {
  const tag =
    d.severity === "error"
      ? style.red(`${icons.cross} error`)
      : style.yellow(`${icons.warn} warn `);
  const location = d.file ?? d.field;
  return `  ${tag}  ${d.message}${location ? ` ${style.dim(`[${location}]`)}` : ""}`;
}

const COMMANDS: Record<string, Command> = {
  run: {
    name: "run",
    summary: "Run a workflow on a prompt; the reply goes to stdout",
    description:
      "Assembles the workflow, runs one turn on a fresh session (or the session the firing resolves to) and prints " +
      "the reply to stdout. The session header and state flow go to stderr. A park exits 0 with a resume hint.",
    positionals: [
      WORKFLOW_ARG,
      {
        name: "prompt",
        required: true,
        rest: true,
        description: "The person's message; the rest of the line is taken",
      },
    ],
    options: {
      trigger: {
        type: "string",
        placeholder: "<id>",
        description: "Trigger starting the turn (default: manual); enters the state declaring it",
      },
      variables: OPT.variables,
      session: {
        type: "string",
        placeholder: "<id>",
        description:
          "Conversation this firing belongs to: resumes it, or starts a session under that id",
      },
      "session-path": {
        type: "string",
        placeholder: "<path>",
        description:
          "Dotted path in --variables holding the session id, overriding the trigger's declaration",
      },
      verbose: OPT.verbose,
    },
    async run(inv) {
      const [workflowArg, prompt] = inv.positionals;
      const workflow = resolveWorkflow(workflowArg, inv.root);
      if (!prompt) throw new UsageError("a prompt is required");
      const variables = parseVariablesJson(inv.values.variables as string | undefined);
      const trigger = inv.values.trigger ? { id: inv.values.trigger as string } : undefined;
      const style = createStyle();
      printSessionHeader(style, workflow, inv.root, true);
      const usage = createEventSink(style, inv.values.verbose === true);
      const agent = await bootstrap(workflow, inv.root, usage, {
        ...(trigger && { trigger }),
        ...(variables && { variables }),
      });
      return driveTurn(agent, style, usage, {
        workflow,
        prompt,
        ...(trigger && { trigger }),
        ...(variables && { variables }),
        ...(inv.values.session ? { sessionId: inv.values.session as string } : {}),
        ...(inv.values["session-path"]
          ? { sessionPath: inv.values["session-path"] as string }
          : {}),
      });
    },
  },
  test: {
    name: "test",
    summary: "Run a workflow's cases; the summary goes to stdout",
    positionals: [
      WORKFLOW_ARG,
      {
        name: "filter",
        required: false,
        description: "Only cases whose file path contains this substring",
      },
    ],
    options: { verbose: OPT.verbose, json: OPT.json },
    async run(inv) {
      const [workflowArg, filter] = inv.positionals;
      const workflow = resolveWorkflow(workflowArg, inv.root);
      const json = inv.values.json === true;
      const style = createStyle();
      printSessionHeader(style, workflow, inv.root, true);
      const view = createTestView(process.stderr, style);
      const usage = createEventSink(style, inv.values.verbose === true, view);
      const outcome = await runTests({
        workflow,
        rootDir: inv.root,
        filter,
        onEvent: usage.handler,
        onCaseStart: (file) => view.onCaseStart(file),
        onCaseResult: (result) => {
          view.onCaseResult(result);
          const perCase = result.sessionId ? usage.totals(result.sessionId) : undefined;
          if (perCase && hasUsage(perCase))
            err(`    ${style.dim(`tokens ${formatUsage(perCase)}`)}`);
        },
      }).catch((e) => {
        if (isKnown(e)) throw new CliError(e.message);
        throw e;
      });
      if (!outcome.skipped && outcome.results.length === 0 && filter) {
        throw new CliError(`no cases matched '${filter}' (${outcome.discovered} discovered)`);
      }
      if (json) {
        out(JSON.stringify({ workflow, ...outcome }, null, 2));
      } else if (outcome.skipped) {
        view.renderSuiteSkipped(workflow, outcome.skipped);
        out(`suite skipped — ${outcome.skipped}`);
      } else {
        view.renderSummary(outcome.results);
        const counts = { passed: 0, failed: 0, skipped: 0 };
        for (const r of outcome.results) counts[r.verdict.status] += 1;
        out(`${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped`);
      }
      printUsageFooter(style, usage);
      return outcome.exitCode;
    },
  },
  validate: {
    name: "validate",
    summary: "Statically validate a workflow — no model calls",
    positionals: [WORKFLOW_ARG],
    options: { json: OPT.json },
    async run(inv) {
      const workflow = resolveWorkflow(inv.positionals[0], inv.root);
      const style = createStyle();
      printSessionHeader(style, workflow, inv.root);
      const result = await validateWorkflow({ workflow, rootDir: inv.root });
      const errors = result.diagnostics.filter((d) => d.severity === "error").length;
      const warnings = result.diagnostics.length - errors;
      if (result.diagnostics.length === 0)
        err(`  ${style.green(`${icons.check} no issues found`)}`);
      for (const d of result.diagnostics) err(formatDiagnostic(style, d));
      err("");
      if (inv.values.json === true)
        out(
          JSON.stringify(
            { workflow, valid: result.valid, diagnostics: result.diagnostics },
            null,
            2,
          ),
        );
      else
        out(`${result.valid ? "valid" : "invalid"} — ${errors} error(s), ${warnings} warning(s)`);
      return result.valid ? 0 : 1;
    },
  },
  sessions: {
    name: "sessions",
    summary: "List durable sessions, or show one in full",
    description:
      "Lists sessions with status, open/finished, current state, variable names and — for parked sessions — what they " +
      "await. With a session id, prints that session in full, each variable with its value and whether it is locked " +
      "(locked = established by the host: a seed, a delivery, or the built-in trigger).",
    positionals: [{ ...SESSION_ARG, required: false }],
    options: { workflow: OPT.workflow, json: OPT.json },
    async run(inv) {
      const sessionId = inv.positionals[0];
      const json = inv.values.json === true;
      return withSession(inv, sessionId, async ({ agent, style }) => {
        if (sessionId) {
          const summary = await agent.sessions.get(sessionId);
          if (!summary)
            throw new CliError(
              `no durable session '${sessionId}'. Use 'archmax sessions' to list them.`,
            );
          if (json) return (out(JSON.stringify(summary, null, 2)), 0);
          err("");
          err(style.green(style.bold(`${icons.check} session ${summary.sessionId}`)));
          out(
            `  status   ${summary.status ?? "?"}${summary.classification ? `  (${summary.classification})` : ""}`,
          );
          out(`  state    ${summary.workflowState ?? "?"}`);
          if (summary.state) out(`  awaiting ${summary.state}`);
          if (summary.waitReason)
            out(
              `  waiting  ${summary.waitReason}${summary.resumeAt ? `  due=${summary.resumeAt}` : ""}`,
            );
          if (summary.specHash) out(`  spec     ${summary.specHash}`);
          const variables = Object.entries(summary.variables ?? {});
          out(variables.length ? "  variables" : "  variables  none set");
          for (const [name, entry] of variables)
            out(
              `    ${name}${entry.locked ? " (locked)" : ""} = ${JSON.stringify(entry.value ?? null)}`,
            );
          return 0;
        }
        const listed = await agent.sessions.list();
        if (json) return (out(JSON.stringify(listed, null, 2)), 0);
        err("");
        if (listed.length === 0) return (out("No durable sessions found."), 0);
        err(style.green(style.bold(`${icons.check} sessions`)));
        for (const t of listed) {
          const names = Object.keys(t.variables ?? {});
          out(
            `  ${t.sessionId}  ${t.status ?? "?"}${t.classification ? `  ${t.classification}` : ""}  state=${t.workflowState ?? "?"}` +
              `${t.state ? `  ${style.yellow(`awaiting=${t.state}`)}` : ""}${names.length ? `  vars=${names.join(",")}` : ""}`,
          );
          if (t.waitReason)
            out(`    waiting for: ${t.waitReason}${t.resumeAt ? `  due=${t.resumeAt}` : ""}`);
          else if (t.state)
            printDecisionContext(
              agent.workflow.machine,
              t.state,
              agent.workflow.machine.spec.states[t.state]?.transitions ?? [],
            );
        }
        return 0;
      });
    },
  },
  decide: {
    name: "decide",
    summary: "Resume a session parked at a human state by picking a transition",
    description:
      "The person picks the target state (one of the parked state's declared transitions); routing is deterministic. " +
      "Fails if the session is not parked or the target is not a declared transition.",
    positionals: [SESSION_ARG],
    options: {
      to: {
        type: "string",
        placeholder: "<state>",
        description: "The state to route to (the person's choice)",
      },
      comment: {
        type: "string",
        placeholder: "<text>",
        description: "Optional note explaining the decision",
      },
      workflow: OPT.workflow,
      verbose: OPT.verbose,
    },
    async run(inv) {
      const sessionId = inv.positionals[0];
      const to = inv.values.to as string | undefined;
      if (!sessionId) throw new UsageError("a session id is required");
      if (!to) throw new UsageError("--to <state> is required (the target the person picks)");
      const comment = inv.values.comment as string | undefined;
      return withSession(inv, sessionId, async ({ agent, style }) => {
        const outcome = await agent.workflow.decide(sessionId, {
          target: to,
          ...(comment ? { comment } : {}),
        });
        printResumed(style, sessionId, "decided", outcome);
        return 0;
      });
    },
  },
  reply: {
    name: "reply",
    summary: "Send a message to a session parked at a human state; it stays parked",
    description:
      "The session answers on a turn with no tools and stays parked at the same state with the same decision pending — " +
      "this is how you talk to a parked session, not how you move it. Use 'archmax decide' for that; no wording here selects a transition.",
    positionals: [
      SESSION_ARG,
      {
        name: "message",
        required: true,
        rest: true,
        description: "The message; the rest of the line is taken",
      },
    ],
    options: { workflow: OPT.workflow, verbose: OPT.verbose },
    async run(inv) {
      const [sessionId, message] = inv.positionals;
      if (!sessionId) throw new UsageError("a session id is required");
      if (!message?.trim())
        throw new UsageError("a message is required — there is nothing to answer otherwise");
      return withSession(inv, sessionId, async ({ agent, style }) => {
        printReply(style, sessionId, await agent.workflow.reply(sessionId, message));
        return 0;
      });
    },
  },
  deliver: {
    name: "deliver",
    summary: "Resume a session parked for input by delivering a trigger",
    description:
      "The event-driven analogue of 'archmax decide': the session continues in the state it parked in, the trigger becomes " +
      "its current one and the variables seed what the event carried, locked. Any trigger id resumes a park.",
    positionals: [SESSION_ARG],
    options: {
      trigger: {
        type: "string",
        placeholder: "<id>",
        description: "Trigger to deliver (the event that arrived)",
      },
      variables: OPT.variables,
      workflow: OPT.workflow,
      verbose: OPT.verbose,
    },
    async run(inv) {
      const sessionId = inv.positionals[0];
      const triggerId = inv.values.trigger as string | undefined;
      if (!sessionId) throw new UsageError("a session id is required");
      if (!triggerId) throw new UsageError("--trigger <id> is required (the event that arrived)");
      const variables = parseVariablesJson(inv.values.variables as string | undefined);
      return withSession(inv, sessionId, async ({ agent, style }) => {
        const outcome = await agent.workflow.deliver(sessionId, {
          trigger: { id: triggerId },
          ...(variables ? { variables } : {}),
        });
        printResumed(style, sessionId, "delivered", outcome);
        return 0;
      });
    },
  },
  help: {
    name: "help",
    summary: "Show help for the CLI or one command",
    positionals: [{ name: "command", required: false, description: "A command name" }],
    options: {},
    async run(inv) {
      const name = inv.positionals[0];
      if (name && !COMMANDS[name]) throw new UsageError(`unknown command '${name}'`);
      out(name ? commandHelp(COMMANDS[name] as Command) : topLevelHelp(Object.values(COMMANDS)));
      return 0;
    },
  },
};

/**
 * Dispatch the CLI on argv (without the node/script prefix) and return the exit
 * code. Exported for tests. Usage errors print one line plus a `--help` hint
 * and return 2; a missing command prints the top-level help to stderr.
 */
export async function dispatchCli(args: string[]): Promise<number> {
  const [name, ...rest] = args;
  if (name === "--help" || name === "-h") return (out(topLevelHelp(Object.values(COMMANDS))), 0);
  if (name === undefined) {
    err(topLevelHelp(Object.values(COMMANDS)));
    err("\nError: a command is required");
    return 2;
  }
  const cmd = COMMANDS[name];
  if (!cmd) return (err(`Error: unknown command '${name}' (try: archmax help)`), 2);
  try {
    const inv = parseInvocation(cmd, rest);
    if (inv.values.help) return (out(commandHelp(cmd)), 0);
    return await cmd.run(inv);
  } catch (e) {
    if (e instanceof UsageError)
      return (err(`Error: ${e.message} (try: archmax ${cmd.name} --help)`), 2);
    if (e instanceof CliError) return (err(`Error: ${e.message}`), 1);
    throw e;
  }
}

/** True when this module is the executed binary, also through npm's `.bin` symlink shim. */
function isEntrypoint(): boolean {
  if (argv[1] === undefined) return false;
  try {
    return realpathSync(argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  printBanner();
  dispatchCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error("archmax failed:", e);
      exit(1);
    });
}

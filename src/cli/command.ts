/**
 * The CLI's command vocabulary: the shape of a command-table entry, the two
 * error classes an invocation can end in, strict parsing through Node's own
 * `util.parseArgs`, help text generated from the table, and the two output
 * primitives every command writes through (results to stdout, narration to
 * stderr).
 */
import { parseArgs as parseNodeArgs } from "node:util";

export interface Positional {
  name: string;
  required: boolean;
  description: string;
  /** Joins every remaining positional with spaces (a prompt or message needs no quoting). */
  rest?: boolean;
}
export interface OptionSpec {
  type: "string" | "boolean";
  description: string;
  placeholder?: string;
  short?: string;
}
export type Values = Record<string, string | boolean | undefined>;
export interface Invocation {
  positionals: string[];
  values: Values;
  root: string | undefined;
}
export interface Command {
  name: string;
  summary: string;
  description?: string;
  positionals: Positional[];
  options: Record<string, OptionSpec>;
  run(inv: Invocation): Promise<number>;
}

/** A failure of the invocation itself: exit 2, one line, a `--help` hint — never a usage dump. */
export class UsageError extends Error {}
/** A failure the command established after parsing: exit 1, one line. */
export class CliError extends Error {}

export const GLOBAL_OPTIONS: Record<string, OptionSpec> = {
  root: {
    type: "string",
    placeholder: "<dir>",
    description: "Workspace root (default: current directory); .env is loaded from it",
  },
  help: { type: "boolean", short: "h", description: "Show help for this command" },
};
export const out = (line: string) => console.log(line);
export const err = (line: string) => console.error(line);

export function parseInvocation(cmd: Command, args: string[]): Invocation {
  const options = Object.fromEntries(
    Object.entries({ ...GLOBAL_OPTIONS, ...cmd.options }).map(([name, spec]) => [
      name,
      { type: spec.type, ...(spec.short ? { short: spec.short } : {}) },
    ]),
  );
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({ args, options, strict: true, allowPositionals: true });
  } catch (e) {
    throw new UsageError(String((e as Error).message).split(". ")[0] ?? "invalid arguments");
  }
  const values = parsed.values as Values;
  const root = typeof values.root === "string" ? values.root : undefined;
  if (values.help) return { positionals: parsed.positionals, values, root };

  // A `rest` positional (the last one) absorbs the remainder of the line; a
  // command without one refuses extra arguments rather than dropping them.
  const positionals = [...parsed.positionals];
  const restAt = cmd.positionals.findIndex((p) => p.rest);
  if (restAt >= 0) {
    const rest = positionals.splice(restAt).join(" ").trim();
    if (rest) positionals.push(rest);
  } else if (positionals.length > cmd.positionals.length) {
    throw new UsageError(`unexpected argument '${positionals[cmd.positionals.length]}'`);
  }
  return { positionals, values, root };
}

function usageLine(cmd: Command): string {
  const args = cmd.positionals
    .map((p) =>
      p.required ? `<${p.name}${p.rest ? "..." : ""}>` : `[${p.name}${p.rest ? "..." : ""}]`,
    )
    .join(" ");
  return `archmax ${cmd.name}${args ? ` ${args}` : ""} [options]`;
}

function columns(rows: Array<[string, string]>): string {
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`).join("\n");
}

function optionRows(options: Record<string, OptionSpec>): Array<[string, string]> {
  return Object.entries(options).map(([name, spec]) => [
    `--${name}${spec.short ? `, -${spec.short}` : ""}${spec.placeholder ? ` ${spec.placeholder}` : ""}`,
    spec.description,
  ]);
}

export function commandHelp(cmd: Command): string {
  const sections = [`Usage: ${usageLine(cmd)}`, "", cmd.description ?? cmd.summary];
  if (cmd.positionals.length) {
    sections.push(
      "",
      "Arguments:",
      columns(cmd.positionals.map((p) => [`<${p.name}>`, p.description])),
    );
  }
  sections.push("", "Options:", columns(optionRows({ ...cmd.options, ...GLOBAL_OPTIONS })));
  return sections.join("\n");
}

export function topLevelHelp(commands: Command[]): string {
  return [
    "Usage: archmax <command> [arguments] [options]",
    "",
    "Commands:",
    columns(
      commands.map((cmd) => [
        usageLine(cmd)
          .replace(/^archmax /, "")
          .replace(/ \[options\]$/, ""),
        cmd.summary,
      ]),
    ),
    "",
    "Global options:",
    columns(optionRows(GLOBAL_OPTIONS)),
    "",
    "Run 'archmax help <command>' for a command's arguments and options.",
  ].join("\n");
}

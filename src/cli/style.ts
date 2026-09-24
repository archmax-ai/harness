/**
 * Zero-dependency ANSI styling shared by the CLI's own output (banner,
 * starter message, state-flow view). Color is suppressed — falling back to
 * plain text with icons intact — when the `NO_COLOR` convention is set or the
 * target stream is not a TTY.
 */

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

const CODES = {
  bold: "1",
  dim: "2",
  red: "31",
  green: "32",
  yellow: "33",
  blue: "34",
  magenta: "35",
  cyan: "36",
  gray: "90",
} as const;

/** Icon constants used by CLI-rendered output; these never change with color suppression. */
export const icons = {
  check: "✔",
  cross: "✖",
  inProgress: "●",
  pending: "○",
  arrow: "→",
  diamond: "◆",
  bullet: "›",
  quote: "│",
  warn: "⚠",
} as const;

export interface ColorContext {
  /** Env to check for `NO_COLOR` (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Whether the target stream is a TTY (defaults to `process.stderr.isTTY`). */
  isTTY?: boolean;
}

/** True when ANSI color codes should be emitted for the given context. */
export function shouldUseColor(ctx: ColorContext = {}): boolean {
  const env = ctx.env ?? process.env;
  const isTTY = ctx.isTTY ?? Boolean(process.stderr.isTTY);

  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (!isTTY) return false;
  return true;
}

export interface Style {
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  blue(text: string): string;
  magenta(text: string): string;
  cyan(text: string): string;
  gray(text: string): string;
}

function wrap(code: string, useColor: boolean): (text: string) => string {
  if (!useColor) return (text: string) => text;
  return (text: string) => `${ESC}${code}m${text}${RESET}`;
}

/** Build a {@link Style} whose helpers are no-op passthroughs when color is suppressed. */
export function createStyle(ctx: ColorContext = {}): Style {
  const useColor = shouldUseColor(ctx);
  return {
    bold: wrap(CODES.bold, useColor),
    dim: wrap(CODES.dim, useColor),
    red: wrap(CODES.red, useColor),
    green: wrap(CODES.green, useColor),
    yellow: wrap(CODES.yellow, useColor),
    blue: wrap(CODES.blue, useColor),
    magenta: wrap(CODES.magenta, useColor),
    cyan: wrap(CODES.cyan, useColor),
    gray: wrap(CODES.gray, useColor),
  };
}

/** Default style instance resolved against the live process env/TTY state. */
export const style: Style = createStyle();

/**
 * Startup banner: the archmax harness ASCII wordmark, in the spirit of oh-my-zsh's
 * startup art. The banner is written to `stderr` only, never `stdout`, so it
 * can never pollute piped/redirected output.
 */
import { createStyle } from "./style.js";

export const BANNER_TEXT = `
               __                     __
 ___ _________/ /  __ _  ___ ___ __  / /  ___ ________  ___ ___ ___
/ _ \`/ __/ __/ _ \\/  ' \\/ _ \`/\\ \\ / / _ \\/ _ \`/ __/ _ \\/ -_|_-<(_-<
\\_,_/_/  \\__/_//_/_/_/_/\\_,_//_\\_\\ /_//_/\\_,_/_/ /_//_/\\__/___/___/
`;

export interface BannerContext {
  /** Env to check for `ARCHMAX_CLI_NO_BANNER` (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Whether `stderr` is a TTY (defaults to `process.stderr.isTTY`). */
  isTTY?: boolean;
}

/** True when the startup banner should be printed for the given context. */
export function shouldShowBanner(ctx: BannerContext = {}): boolean {
  const env = ctx.env ?? process.env;
  const isTTY = ctx.isTTY ?? Boolean(process.stderr.isTTY);

  if (env.ARCHMAX_CLI_NO_BANNER !== undefined && env.ARCHMAX_CLI_NO_BANNER !== "") return false;
  if (!isTTY) return false;
  return true;
}

/** Print the banner to `stderr` when {@link shouldShowBanner} allows it for the live process context. */
export function printBanner(): void {
  if (shouldShowBanner()) {
    console.error(createStyle().cyan(BANNER_TEXT));
  }
}

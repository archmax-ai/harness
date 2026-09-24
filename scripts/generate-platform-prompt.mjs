// Generates src/core/platform-prompt.generated.ts from src/core/platform-prompt.md,
// so the default platform prompt ships inside the compiled code and the runtime
// never reads it from disk. Run by `npm run build`; `npm test` fails when the
// committed module has drifted from the Markdown.
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { URL, pathToFileURL } from "node:url";

const source = new URL("../src/core/platform-prompt.md", import.meta.url);
const target = new URL("../src/core/platform-prompt.generated.ts", import.meta.url);

export function renderPlatformPromptModule(markdown) {
  return [
    "// Generated from platform-prompt.md by scripts/generate-platform-prompt.mjs. Do not edit.",
    "",
    "/** The bundled platform prompt: how to move through the graph and which tools are the runtime's. */",
    `export const PLATFORM_PROMPT: string = ${JSON.stringify(markdown)};`,
    "",
  ].join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(target, renderPlatformPromptModule(readFileSync(source, "utf8")));
}

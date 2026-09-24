// Flat ESLint config. Scoped to the TypeScript harness in src/. The bundled
// example scripts (examples/**/*.js) run in the QuickJS sandbox against
// injected globals (args, tools, t, satisfies) and are deliberately not linted
// here. eslint-config-prettier is last so formatting is left entirely to
// Prettier. The LangChain/deepagents/langgraph coupling is quarantined behind
// the typed adapter in src/core/framework.ts, so `no-explicit-any` is enforced
// everywhere; the adapter is the sanctioned home for any remaining
// framework-boundary casts.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["dist/", "docs/", "examples/", "node_modules/", "**/*.js"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          // Vars destructured only to omit them (via a `...rest` sibling) are
          // intentional, e.g. `const { ts, seq, ...rest } = ...`.
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  prettier,
);

---
title: Installation
description: Install @archmax-ai/harness and configure an OpenAI-compatible model endpoint.
sidebar:
  order: 1
---

The archmax harness requires **Node.js 22 or later** and ships as an ESM-only npm package.

## Install the package

```bash
npm install @archmax-ai/harness
```

This installs the runtime library and the `archmax` CLI.

For hacking on the SDK itself, see
[development setup](/contributing/development/).

## The bundled authoring skill

The package ships the workflow-authoring Agent Skill inside the install, so it
always matches the SDK version you depend on. The skill is the playbook coding
agents use to author `workflow.yaml` workspaces and wire the runtime. Locate it
via the exported constant:

```ts
import { BUNDLED_AUTHORING_SKILL_DIR } from "@archmax-ai/harness";
// <BUNDLED_AUTHORING_SKILL_DIR>/archmax-harness/SKILL.md (+ references/)
```

Point skills middleware at `BUNDLED_AUTHORING_SKILL_DIR`, or install it into a coding
agent with `npx skills add ./node_modules/@archmax-ai/harness/dist/authoring-skill/archmax-harness`.
Working from a checkout of the SDK repo, `npx skills add ./skills/archmax-harness` works
too. In a consuming project, prefer the packaged copy.

## Configure the model

The model is configured from environment variables, and it targets any
**OpenAI-compatible** endpoint (OpenRouter, vLLM, LiteLLM, Together, …). These
five are what a first run needs:

| Variable | Description | Example |
| --- | --- | --- |
| `ARCHMAX_API_BASE_URL` | Base URL of the OpenAI-compatible API | `https://openrouter.ai/api/v1` |
| `ARCHMAX_API_KEY` | API key for the endpoint | `sk-or-v1-...` |
| `ARCHMAX_MODEL` | Model identifier | `anthropic/claude-sonnet-4.6` |
| `ARCHMAX_TEMPERATURE` | (optional) sampling temperature | `0` |
| `ARCHMAX_MAX_TOKENS` | (optional) max output tokens | `4096` |

Under the hood this builds a `ChatOpenAI` instance pointed at
`ARCHMAX_API_BASE_URL`, and Deep Agents uses it as its model.

Prompt caching, streaming and token pricing have their own variables. The
[configuration reference](/reference/configuration/) lists the
full set.

`.env` is loaded from the **workspace root**. That is the directory passed via
`--root` (or `rootDir`), or the current working directory. Variables already
present in the real process environment always win.

```bash
cp .env.example .env   # then fill in your credentials
```

To supply a model programmatically instead, see the
[public API reference](/reference/public-api/). Any LangChain
`BaseChatModel` works, including per-role factories.

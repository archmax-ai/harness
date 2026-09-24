---
title: Changelog
description: One section per release, newest first, saying what changed and where the current behaviour is documented.
sidebar:
  order: 6
---

Newest first. Each section says what changed and links to the guide that describes the behaviour
as it is today; the guides themselves describe only the present. Every release also has
[GitHub release notes](https://github.com/archmax-ai/harness/releases) listing its pull requests.

## 0.1.0: first public release (unreleased)

The first release of `@archmax-ai/harness`: a governed layer over LangChain Deep Agents.

- **One `workflow.yaml` per workflow** is the enforced state machine: states, transitions,
  per-state `allow`/`forbid` governance for tools, skills and mounts, `before`/`after` hooks,
  budgets, error routing and triggers. See the [workflow machine guide](/guides/workflow-machine/)
  and the [machine spec reference](/reference/machine-spec/).
- **Human states and waits** park a session durably; `decide`, `reply` and `deliver` resume it.
  See [sessions](/guides/sessions/).
- **Hooks and the sandbox**: hook scripts, `archmax_eval` and `archmax_run` share one QuickJS
  sandbox with a governed tool bridge. See the [code interpreter guide](/guides/code-interpreter/).
- **Cases** (`archmax test`) and rubric grading. See [testing](/guides/testing/) and
  [grading rubrics](/guides/grading-rubrics/).
- **Sub-workflows**, **skills** and **triggers**: see [sub-workflows](/guides/sub-workflows/),
  [skills](/guides/skills/) and [triggers](/guides/triggers/).
- **The `archmax` CLI** (`run`, `test`, `validate`, `sessions`, `decide`, `reply`, `deliver`). See
  the [CLI reference](/reference/cli/).
- **The library API**: `createAgent` and the `sandbox`, `testing`, `cli`, `spec` and `messages`
  subpaths. See the [public API reference](/reference/public-api/).

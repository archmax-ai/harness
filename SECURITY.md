# Security policy

archmax harness is a governance layer: it decides which tools, files and transitions an agent
may use, and it runs authored scripts in a sandbox. A way around any of that is a security issue.

## Reporting a vulnerability

Please do **not** open a public issue. Report it privately through
[GitHub's private vulnerability reporting](https://github.com/archmax-ai/harness/security/advisories/new).
Include the version, a minimal reproduction (a `workflow.yaml` snippet or a short `.mts` script),
and what you expected the runtime to refuse.

We acknowledge a report within three working days and keep you updated until it is resolved.
Once a fix is released we publish an advisory and credit you, unless you prefer otherwise.

## In scope

- An agent or a sandboxed script calling a tool, reading or writing a path, or taking a
  transition that the workflow's `allow`/`forbid` rules, safety rules or `policy` refuse.
- Escaping the QuickJS sandbox, or reaching the host's filesystem, network or environment from it.
- The agent reaching the authoring plane (`workflows/**`: specs, hooks, cases) or another
  session's files.
- A hook verdict that fails open, or a park or decision that can be forged or skipped.
- Secrets from `.env` or the environment leaking into prompts, session files or the published
  package.

Behaviour of the model itself (a prompt injection that the governance layer then correctly
refuses, for example) is not a vulnerability in the harness.

## Supported versions

Security fixes land in the latest released minor version.

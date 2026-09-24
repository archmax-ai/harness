<!--
Task-list syntax is deliberately absent: GitHub counts every `- [ ]` in a PR
body as an open task, so a template full of them reports the PR as unfinished
no matter what was done. Fill in the three fields; the reminders below are
comments and never render.
-->

**Type:** <!-- feat | fix | refactor | docs | chore | release -->

**Issue:** <!-- Closes #123, so it closes on merge. Write "none" if there is no issue. -->

## Summary

<!-- What changed and why, in a line or two. -->

<!--
Before opening, confirm:
  - `npm run typecheck`, `npm test` and `npm run lint` pass
  - if behaviour changed: docs/, README.md, skills/archmax-harness/ and the specs under
    openspec/specs/ updated in this PR
  - no secrets committed (gitleaks clean)
To cut a release on merge, label the PR `release` (patch), `release:minor` or
`release:major`.
See CONTRIBUTING.md.
-->

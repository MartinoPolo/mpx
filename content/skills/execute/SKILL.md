---
name: execute
description: Implement one Issue with bounded changes and repository verification
triggers: implementing an approved Issue
metadata:
  mpx:
    skillPacks: [core]
    defaultExposure: full
---
# Execute an Issue

Implement one approved Issue in the current repository with evidence-driven, bounded changes.

## Launch identity

`<launch-identity>` is the immutable identity selected when MPX launched. Use it for every provider operation. If the launch identity is unavailable, stop and ask the user; never infer or substitute one.

## Workflow

1. Resolve the Issue identifier and run `mpx issue view --identity <launch-identity> --json`. Restate the accepted outcomes and stop for unresolved product decisions.
2. Inspect repository instructions, current branch state, and relevant code. Ordinary `git` commands are allowed for version-control inspection and local change management.
3. Plan the smallest coherent change. Keep unrelated findings out of scope and report them separately.
4. Add or update focused tests before implementation when the behavior is testable. Confirm the expected failure, implement the minimum correction, and rerun the focused checks.
5. Refactor only within the implemented behavior, then run the repository-prescribed checks relevant to the changed area.
6. Review `git diff` and `git status`. Do not discard unrelated existing changes.
7. If an Issue update is requested, use `mpx issue comment --identity <launch-identity> --json`, `mpx issue move --identity <launch-identity> --json`, or `mpx issue finish --identity <launch-identity> --json`. Do not mark the Issue finished until acceptance evidence is available.
8. Report changed files, checks, remaining risks, and the confirmed Issue state.

## Unsupported capability

After any MPX Issue command, if the JSON response has `ok: false` and `error.code: CAPABILITY_UNSUPPORTED`, stop that provider operation and preserve completed local work. Report the unsupported capability and any structured remediation. Do not invoke or suggest a direct provider command as a fallback.

For every other structured provider error, report the code and actionable message, then stop the affected provider operation without claiming it succeeded.

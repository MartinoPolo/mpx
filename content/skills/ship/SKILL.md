---
name: ship
description: Deliver a verified change through provider-neutral Review and CI gates
triggers: publishing or preparing a verified change for integration
metadata:
  mpx:
    skillPacks: [core]
    defaultExposure: name-only
---
# Ship a Change

Deliver an already implemented change without bypassing repository, Review, CI, or authorization gates.

## Launch identity

`<launch-identity>` is the immutable identity selected when MPX launched. Use it for every provider operation. If the launch identity is unavailable, stop and ask the user; never infer or substitute one.

## Workflow

1. Inspect `git status`, the complete diff, branch relationship, and recent commits. Preserve unrelated existing changes.
2. Run the repository-prescribed verification. Stop when required checks fail or evidence is incomplete.
3. Create a focused commit only when authorized. Use ordinary `git` for commit and push because these are version-control operations.
4. There is no implicit Review or CI discovery. Use a trusted known ID, or run `mpx review create --title <title> --body <body> --source-branch <source-branch> --target-branch <target-branch> --identity <launch-identity> --json` and capture the returned Review ID.
5. Run `mpx review view --id <review-id> --identity <launch-identity> --json` to inspect that Review. Use `mpx review update --id <review-id> --title <title> --body <body> --identity <launch-identity> --json` when an update is required.
6. Run `mpx ci status --id <review-or-pipeline-id> --identity <launch-identity> --json` or `mpx ci watch --id <review-or-pipeline-id> --identity <launch-identity> --json`. Use `mpx ci logs --run-id <run-id> --identity <launch-identity> --json` for failed check details and `mpx ci retry --run-id <run-id> --identity <launch-identity> --json` only when a retry is justified and authorized.
7. Run `mpx review ready --id <review-id> --identity <launch-identity> --json` only when the change is no longer a draft and all readiness requirements are met.
8. Run `mpx review merge --id <review-id> --identity <launch-identity> --json` only when the MPX Review operation, repository policy, and explicit authority all permit it. Never substitute a direct provider command.
9. Report the commit, push result, Review state, CI state, and any remaining human action. Do not claim delivery beyond the last confirmed response.

## Unsupported capability

After any MPX Review or CI command, if the JSON response has `ok: false` and `error.code: CAPABILITY_UNSUPPORTED`, stop that provider operation. Preserve confirmed git and provider results, report the unsupported capability and any structured remediation, and identify the remaining action. Do not invoke or suggest a direct provider command as a fallback.

For every other structured provider error, report the code and actionable message, then stop the affected delivery step.

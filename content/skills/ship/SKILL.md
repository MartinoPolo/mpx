---
name: ship
description: Deliver verified work through commit, provider-neutral Review, CI, and authorized merge
triggers: shipping or merging completed work end to end
metadata:
  mpx:
    schemaVersion: 1
    skillPacks: [core]
    defaultExposure: name-only
---

# Ship

The main agent orchestrates bounded results and never bypasses Review or CI gates.

## Launch identity

`<launch-identity>` is the immutable identity selected when MPX launched. Use it for every provider operation. If the launch identity is unavailable, stop and ask the user; never infer or substitute one.

## Workflow

1. Inspect status, branch/upstream, full diff, and commits. Determine which steps are already confirmed. Preserve unrelated changes and sync the base through ordinary `git` only when authorized.
2. Run repository-prescribed checks. Delegate a focused conventional commit/push to `mp-git-committer`; retry bounded failures twice and stop if unresolved.
3. Use a trusted explicit Review ID if supplied. It remains immutable for the run: never replace it from branch or provider discovery. Inspect with `mpx review view --id <review-id> --identity <launch-identity> --json`. If title, body, or target needs correction, use `mpx review update --id <review-id> --title <title> --body <body> --identity <launch-identity> --json`.
4. Otherwise create through `mpx review create --title <title> --body <body> --source-branch <source-branch> --target-branch <target-branch> --identity <launch-identity> --json`, and capture the returned Review ID as the explicit immutable ID. There is no implicit Review or CI discovery.
5. Check once with `mpx ci status --id <review-or-pipeline-id> --identity <launch-identity> --json`, then run `mpx ci watch --id <review-or-pipeline-id> --identity <launch-identity> --json` while pending. Never merge while pending or failed. If no checks are confirmed, state that absence and require policy/authority before continuing.
6. For failure details run `mpx ci logs --run-id <run-id> --identity <launch-identity> --json`. Delegate diagnosis/fixes, commit and push, and use `mpx ci retry --run-id <run-id> --identity <launch-identity> --json` only for an authorized justified retry. Repeat the CI fix loop at most three times, then stop blocked.
7. When checks are green and readiness requirements hold, run `mpx review ready --id <review-id> --identity <launch-identity> --json`. Merge only with explicit authority via `mpx review merge --id <review-id> --identity <launch-identity> --json`, using a method permitted by repository policy. Do not use an automatic merge as the CI gate.
8. Confirm merged state with `mpx review view --id <review-id> --identity <launch-identity> --json`, post an optional summary via `mpx review comment --id <review-id> --identity <launch-identity> --json`, then sync the main worktree safely.
9. Report sync, commit, Review ID/URL, CI results and retry count, merge confirmation, Issue/board writeback, and remaining manual handoffs.

## Errors

For `CAPABILITY_UNSUPPORTED`, stop the affected Review/CI action, preserve confirmed git and provider results, and return structured remediation. Never fall back to a provider CLI. Other structured errors stop that gate without claiming delivery.

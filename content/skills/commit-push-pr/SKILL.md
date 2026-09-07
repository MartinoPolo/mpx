---
name: commit-push-pr
description: Commit and push verified changes, then create or update a provider-neutral Review
triggers: committing, pushing, and publishing a Review together
metadata:
  mpx:
    schemaVersion: 1
    skillPacks: [work]
    defaultExposure: name-only
---

# Commit, Push, and PR

## Launch identity

`<launch-identity>` is the immutable identity selected when MPX launched. Use it for every provider operation. If the launch identity is unavailable, stop and ask the user; never infer or substitute one.

## Workflow

1. Inspect status, full diff, branch, base relationship, and repository instructions. Run required checks and preserve unrelated changes.
2. Delegate a focused conventional commit to `mp-git-committer` with push authorization. If there is nothing to commit, verify whether the branch is already pushed before continuing.
3. Resolve a linked Issue only from branch/commit evidence or `mpx issue view --identity <launch-identity> --json`; do not guess.
4. A trusted Review ID remains immutable for the run: never replace it from branch or provider discovery. With an explicit Review ID, inspect it using `mpx review view --id <review-id> --identity <launch-identity> --json`, then update via `mpx review update --id <review-id> --title <title> --body <body> --identity <launch-identity> --json`.
5. Without a Review ID, create one using `mpx review create --title <title> --body <body> --source-branch <source> --target-branch <target> --identity <launch-identity> --json`; include draft state when requested and capture the returned explicit Review ID.
6. Report commit, push, target branch, Review ID/URL/state, created-or-updated status, and skipped steps.

On `CAPABILITY_UNSUPPORTED`, return the structured remediation and stop publication without falling back to a provider CLI. Never claim a failed Review operation succeeded.

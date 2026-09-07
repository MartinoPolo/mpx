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

Provider operations follow [the shared provider resolution and native command references](../shared/ISSUE_TRACKER.md).

## Workflow

1. Inspect status, full diff, branch, base relationship, and repository instructions. Run required checks and preserve unrelated changes.
2. Delegate a focused conventional commit to `mp-git-committer` with push authorization. If there is nothing to commit, verify whether the branch is already pushed before continuing.
3. Resolve a linked Issue only from branch/commit evidence or the resolved provider reference’s documented native operation with an explicit target; do not guess.
4. A trusted Review ID remains immutable for the run: never replace it from branch or provider discovery. With an explicit Review ID, inspect it using the resolved provider reference’s documented native operation with an explicit target, then update via the resolved provider reference’s documented native operation with an explicit target.
5. Without a Review ID, create one using the resolved provider reference’s documented native operation with an explicit target; include draft state when requested and capture the returned explicit Review ID.
6. Report commit, push, target branch, Review ID/URL/state, created-or-updated status, and skipped steps.

On `CAPABILITY_UNSUPPORTED`, return the structured remediation and stop publication without falling back to a provider CLI. Never claim a failed Review operation succeeded.

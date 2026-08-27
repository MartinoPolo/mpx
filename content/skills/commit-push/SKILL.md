---
name: commit-push
description: "Stages, commits, and pushes changes without opening a PR."
metadata:
  mpx:
    skillPacks: [work]
    defaultExposure: name-only
---

# Commit and Push

Stage, commit, and push changes. No PR created. the invocation input

## Workflow

1. Read `../shared/GIT_COMMIT_WORKFLOW.md` now.
2. Run **Phase A** (commit via `mp-git-committer`) with `push: true`, including its result handling and escalation. Only Phase A applies — it covers both the commit and the push.

## Output

After completion, display:

- Commit hash and message (if committed)
- Push status
- "Nothing to commit — already up-to-date" (if applicable)

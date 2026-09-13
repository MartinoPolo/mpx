---
name: commit-push
description: 'Stages, commits, and pushes changes without opening a PR.'
argument-hint: '[commit hint]'
metadata:
  author: MartinoPolo
  version: '0.6'
  category: git-workflow
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: name-only
---

# Commit and Push

Stage, commit, and push changes. Do not create a PR. `the invocation input`

## Workflow

1. Read [Git Commit Workflow]({{MPX_SHARED_INSTRUCTIONS}}/GIT_COMMIT_WORKFLOW.md) through the
   compiler-resolved shared link.
2. Run **Phase A** through `mpx-git-committer` with `push: true` and
   `commit_hint: the invocation input`, preserving its structured result handling and bounded
   escalation. Only Phase A applies; it covers commit and push.
3. Preserve the native CLI authentication environment. Native status/login diagnostics may inspect
   the active account, but do not log in or out, substitute credentials, or switch accounts during
   push troubleshooting.

## Output

- Commit hash and message, when committed
- Push status
- “Nothing to commit — already up-to-date”, when applicable

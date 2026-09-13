---
argument-hint: "[commit hint]"
description: Loads the mp-commit-push skill when explicitly referenced.
metadata:
  author: MartinoPolo
  category: git-workflow
  version: "0.6"
name: mp-commit-push
---

# Commit and Push

Stage, commit, and push changes. Do not create a PR. `the invocation input`

## Workflow

1. Read [Git Commit Workflow](../../../../../pi/instructions/shared/GIT_COMMIT_WORKFLOW.md) through the
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

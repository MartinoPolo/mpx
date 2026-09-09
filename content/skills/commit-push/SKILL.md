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

1. Read [Git Commit Workflow](../shared/GIT_COMMIT_WORKFLOW.md), resolving the Markdown link relative to this compiled
   skill. If a tool requires a literal absolute content path, follow [Content Paths](../shared/CONTENT_PATHS.md): use
   the validated `MPX_ACTIVE_CONTENT_ROOT` and projection-relative path; do not search fallback roots or guess a
   checkout.
2. Run **Phase A** through `mpx-git-committer` with `push: true` and `commit_hint: the invocation input`, preserving its
   structured result handling and bounded escalation. Only Phase A applies; it covers commit and push.
3. Preserve the immutable launch identity and account-bound native CLI environment used when MPX launched. Do not
   substitute credentials or accounts during push troubleshooting.

## Output

- Commit hash and message, when committed
- Push status
- “Nothing to commit — already up-to-date”, when applicable

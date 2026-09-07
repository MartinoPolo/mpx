---
name: commit
description: 'Stages and commits changes in conventional commit format.'
metadata:
  author: MartinoPolo
  version: '0.7'
  category: git-workflow
  mpx:
    schemaVersion: 1
    skillPacks: [work]
    defaultExposure: name-only
---

# Commit Changes

Stage and commit the working changes as one conventional commit, inline in the main agent (no delegation).
`the invocation input`

## Workflow

1. Read [Git Commit Workflow](../shared/GIT_COMMIT_WORKFLOW.md), resolving the Markdown link relative to this compiled
   skill.
2. If a tool requires a literal absolute content path, follow [Content Paths](../shared/CONTENT_PATHS.md): read and
   validate `MPX_ACTIVE_CONTENT_ROOT`, resolve the projection-relative path beneath it, verify containment and
   existence, and stop if that fails. Do not search fallback roots or guess an installation checkout.
3. Follow **Commit Conventions** directly: inspect, stage explicit paths, choose the type from the diff, write the
   message to a temporary file, run `git commit -F`, and verify. Treat `the invocation input` as the commit hint; there
   is no Issue reference unless the caller supplies one. Do not push or publish a PR.

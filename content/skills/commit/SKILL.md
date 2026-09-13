---
name: commit
description: 'Stages and commits changes in conventional commit format.'
metadata:
  author: MartinoPolo
  version: '0.7'
  category: git-workflow
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: name-only
---

# Commit Changes

Stage and commit the working changes as one conventional commit, inline in the main agent (no
delegation). `the invocation input`

## Workflow

1. Read [Git Commit Workflow]({{MPX_SHARED_INSTRUCTIONS}}/GIT_COMMIT_WORKFLOW.md) through the
   compiler-resolved shared link.
2. Follow **Commit Conventions** directly: inspect, stage explicit paths, choose the type from the
   diff, write the message to a temporary file, run `git commit -F`, and verify. Treat
   `the invocation input` as the commit hint; there is no Issue reference unless the caller supplies
   one. Do not push or publish a PR.

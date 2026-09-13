---
description: Loads the mp-commit skill when explicitly referenced.
metadata:
  author: MartinoPolo
  category: git-workflow
  version: "0.7"
name: mp-commit
---

# Commit Changes

Stage and commit the working changes as one conventional commit, inline in the main agent (no
delegation). `the invocation input`

## Workflow

1. Read [Git Commit Workflow](../../../../../pi/instructions/shared/GIT_COMMIT_WORKFLOW.md) through the
   compiler-resolved shared link.
2. Follow **Commit Conventions** directly: inspect, stage explicit paths, choose the type from the
   diff, write the message to a temporary file, run `git commit -F`, and verify. Treat
   `the invocation input` as the commit hint; there is no Issue reference unless the caller supplies
   one. Do not push or publish a PR.

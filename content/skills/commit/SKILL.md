---
name: commit
description: 'Stages and commits changes in conventional commit format.'
metadata:
  mpx:
    schemaVersion: 1
    skillPacks: [work]
    defaultExposure: name-only
---

# Commit Changes

Stage and commit the working changes as one conventional commit, inline in the main agent (no delegation). the invocation input

## Workflow

1. Read `../shared/GIT_COMMIT_WORKFLOW.md` now.
2. Follow its **Commit Conventions** section directly — inspect, stage explicit paths, pick the type from the diff, compose the message to a temp file, `git commit -F`, then verify. Treat `the invocation input` as the `commit_hint`; there is no `issue_ref` unless the caller supplies one. Do not run any push or PR phase.

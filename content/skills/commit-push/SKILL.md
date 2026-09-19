---
name: commit-push
description: 'Stages, commits, and pushes explicit intended changes without opening a PR.'
argument-hint: '[commit hint]'
metadata:
  author: MartinoPolo
  version: '0.8'
  category: git-workflow
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: name-only
---

# Commit and Push

Prepare a substantive summary of the intended change before delivery. Invoke `mpx-shipper` with
endpoint `push`, the explicit intended paths, the summary and `the invocation input`, and all
required repository, branch, configured remote, provider, Issue, and existing immutable identities.
Preserve native authentication.

The parent owns **three total shipping attempts: the initial attempt plus two retries across all
stages and any continuation**. Never reset this budget or replace identities established by an
earlier attempt. On failure, evaluate the bounded evidence,
dispatch a fresh `mpx-executor` for each accepted repair with the requirements, precise repair
objective, file pointers, acceptance criteria, and verification commands. Tell it to inspect the
current diff and relevant files. Verify the repair before invoking the shipper again. The shipper
never repairs.

Completion requires the verified commit and selected-remote push state. Do not create a PR. Report
actual results after delivery, including completed stage, commit/branch/repository identities, push
state, excluded artifacts, retries, remaining work, and blockers.

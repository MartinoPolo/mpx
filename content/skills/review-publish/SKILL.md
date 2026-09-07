---
name: review-publish
description: Create or update a provider-neutral Review from existing commits
triggers: publishing committed branch changes for review
metadata:
  mpx:
    schemaVersion: 1
    skillPacks: [work]
    defaultExposure: name-only
---

# Publish a Review

Provider operations follow [the shared provider resolution and native command references](../shared/ISSUE_TRACKER.md).

## Workflow

1. Inspect branch status, commits, complete diff, push state, and target branch. This skill does not create commits.
2. Resolve linked Issue context only from durable branch or commit evidence, optionally with the resolved provider reference’s documented native operation with an explicit target.
3. When given an explicit Review ID, treat it as immutable and never replace it from branch or provider discovery. Read it with the resolved provider reference’s documented native operation with an explicit target and update with the resolved provider reference’s documented native operation with an explicit target.
4. Otherwise create with the resolved provider reference’s documented native operation with an explicit target. Capture the explicit Review ID returned. Honor requested draft state.
5. Report target branch, Review ID, URL, state, and whether created or updated.

If a response has `error.code: CAPABILITY_UNSUPPORTED`, stop and return its structured remediation. Do not fall back to direct provider tooling or imply publication occurred.

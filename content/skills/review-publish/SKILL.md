---
name: review-publish
description: Create or update a provider-neutral Review from existing commits
triggers: publishing committed branch changes for review
metadata:
  mpx:
    skillPacks: [work]
    defaultExposure: name-only
---
# Publish a Review

## Launch identity

`<launch-identity>` is the immutable identity selected when MPX launched. Use it for every provider operation. If the launch identity is unavailable, stop and ask the user; never infer or substitute one.

## Workflow

1. Inspect branch status, commits, complete diff, push state, and target branch. This skill does not create commits.
2. Resolve linked Issue context only from durable branch or commit evidence, optionally with `mpx issue view --identity <launch-identity> --json`.
3. When given an explicit Review ID, treat it as immutable and never replace it from branch or provider discovery. Read it with `mpx review view --id <review-id> --identity <launch-identity> --json` and update with `mpx review update --id <review-id> --title <title> --body <body> --identity <launch-identity> --json`.
4. Otherwise create with `mpx review create --title <title> --body <body> --source-branch <source> --target-branch <target> --identity <launch-identity> --json`. Capture the explicit Review ID returned. Honor requested draft state.
5. Report target branch, Review ID, URL, state, and whether created or updated.

If a response has `error.code: CAPABILITY_UNSUPPORTED`, stop and return its structured remediation. Do not fall back to direct provider tooling or imply publication occurred.

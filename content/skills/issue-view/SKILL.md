---
name: issue-view
description: Retrieve and summarize one Issue through the configured MPX provider
triggers: viewing or understanding an Issue
metadata:
  mpx:
    skillPacks: [core]
    defaultExposure: full
---
# View an Issue

Retrieve one Issue through MPX and present its current provider-neutral state.

## Launch identity

`<launch-identity>` is the immutable identity selected when MPX launched. Use it for every provider operation. If the launch identity is unavailable, stop and ask the user; never infer or substitute one.

## Workflow

1. Resolve the intended Issue identifier from explicit user input or unambiguous conversation context. Ask when multiple identifiers are plausible.
2. Run `mpx issue view --identity <launch-identity> --json` with that identifier.
3. Summarize the title, state, description, acceptance criteria, labels, assignees, and recent discussion only when those fields are present.
4. Distinguish absent fields from empty fields. Preserve links returned by MPX.
5. Do not infer updates that are not in the structured response.

## Unsupported capability

If the JSON response has `ok: false` and `error.code: CAPABILITY_UNSUPPORTED`, stop the view operation. Report the unsupported capability and any structured remediation. Do not invoke or suggest a direct provider command as a fallback.

For every other structured error, report the code and actionable message, then stop.

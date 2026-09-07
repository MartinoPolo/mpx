---
name: issue-view
description: Retrieve and summarize one Issue through the configured MPX provider
triggers: viewing or understanding an Issue
metadata:
  mpx:
    schemaVersion: 1
    skillPacks: [core]
    defaultExposure: full
---

# View an Issue

Provider operations follow [the shared provider resolution and native command references](../shared/ISSUE_TRACKER.md).

Retrieve one Issue through the resolved trusted provider reference and present its current state.

## Workflow

1. Resolve the intended Issue identifier from explicit user input or unambiguous conversation context. Ask when multiple identifiers are plausible.
2. Run the resolved provider reference’s documented native operation with an explicit target with that identifier.
3. Summarize the title, state, description, acceptance criteria, labels, assignees, and recent discussion only when those fields are present.
4. Distinguish absent fields from empty fields. Preserve links returned by MPX.
5. Do not infer updates that are not in the structured response.

## Unsupported capability

If the native operation reports `CAPABILITY_UNSUPPORTED`, stop the view operation. Report the unsupported capability and any structured remediation. Do not invent a command outside the shipped provider reference.

For every other structured error, report the code and actionable message, then stop.

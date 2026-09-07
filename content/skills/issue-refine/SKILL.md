---
name: issue-refine
description: Refine an Issue into an implementable provider-neutral specification
triggers: clarifying scope or acceptance criteria for an Issue
metadata:
  mpx:
    schemaVersion: 1
    skillPacks: [core]
    defaultExposure: name-only
---

# Refine an Issue

Provider operations follow [the shared provider resolution and native command references](../shared/ISSUE_TRACKER.md).

Turn an existing Issue into a concise, verifiable specification while preserving confirmed intent.

## Workflow

1. Run the resolved provider reference’s documented native operation with an explicit target with the resolved Issue identifier.
2. Identify ambiguity in the problem, boundaries, acceptance criteria, dependencies, and verification expectations.
3. Ask focused questions for decisions that cannot be derived from repository evidence. Do not invent product choices.
4. Draft the revised title and body. Keep the public term Issue and express acceptance criteria as observable outcomes.
5. Show the proposed material change before writing it unless the user already authorized direct refinement.
6. Run the resolved provider reference’s documented native operation with an explicit target with the approved fields. Use the resolved provider reference’s documented native operation with an explicit target only when preserving a discussion note is preferable to changing the Issue body.
7. Re-read with the resolved provider reference’s documented native operation with an explicit target when supported and summarize the confirmed result.

## Unsupported capability

After any native provider operation, if the response has `ok: false` and `error.code: CAPABILITY_UNSUPPORTED`, stop that operation. Report the unsupported capability and any structured remediation. Do not invent a command outside the shipped provider reference. A failed optional re-read does not invalidate a confirmed edit, but its failure must be stated.

For every other structured error, report the code and actionable message, then stop the affected operation.

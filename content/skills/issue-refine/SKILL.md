---
name: issue-refine
description: Refine an Issue into an implementable provider-neutral specification
triggers: clarifying scope or acceptance criteria for an Issue
metadata:
  mpx:
    skillPacks: [core]
    defaultExposure: name-only
---
# Refine an Issue

Turn an existing Issue into a concise, verifiable specification while preserving confirmed intent.

## Launch identity

`<launch-identity>` is the immutable identity selected when MPX launched. Use it for every provider operation. If the launch identity is unavailable, stop and ask the user; never infer or substitute one.

## Workflow

1. Run `mpx issue view --identity <launch-identity> --json` with the resolved Issue identifier.
2. Identify ambiguity in the problem, boundaries, acceptance criteria, dependencies, and verification expectations.
3. Ask focused questions for decisions that cannot be derived from repository evidence. Do not invent product choices.
4. Draft the revised title and body. Keep the public term Issue and express acceptance criteria as observable outcomes.
5. Show the proposed material change before writing it unless the user already authorized direct refinement.
6. Run `mpx issue edit --identity <launch-identity> --json` with the approved fields. Use `mpx issue comment --identity <launch-identity> --json` only when preserving a discussion note is preferable to changing the Issue body.
7. Re-read with `mpx issue view --identity <launch-identity> --json` when supported and summarize the confirmed result.

## Unsupported capability

After any MPX Issue command, if the JSON response has `ok: false` and `error.code: CAPABILITY_UNSUPPORTED`, stop that operation. Report the unsupported capability and any structured remediation. Do not invoke or suggest a direct provider command as a fallback. A failed optional re-read does not invalidate a confirmed edit, but its failure must be stated.

For every other structured error, report the code and actionable message, then stop the affected operation.

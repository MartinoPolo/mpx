---
name: epic-create
description: Draft and create an approved Epic Issue from project requirements
triggers: turning requirements into an Epic specification
metadata:
  mpx:
    skillPacks: [work]
    defaultExposure: explicit-only
---

# Create an Epic

## Launch identity

`<launch-identity>` is the immutable identity selected when MPX launched. Use it for every provider operation. If the launch identity is unavailable, stop and ask the user; never infer or substitute one.

## Workflow

1. Read `.mpx/CONTEXT.md` and `.mpx/DECISIONS.md`; stop if context is absent. Explore current modules, conventions, dependencies, and test prior art.
2. Propose deep module boundaries and ask the user to confirm the breakdown and testing boundaries.
3. Draft a provider-neutral Epic spec with Overview, User Stories, Included/Excluded Scope, testable Acceptance Criteria, Technical Notes, Implementation Decisions, and Testing Decisions. Use durable domain language, not file paths or snippets.
4. Present the complete draft at the HITL approval gate. Revise until explicitly approved; never create before approval.
5. Ensure labels through the launch-bound tool capability: `mpx tool invoke --capability issue.labels.ensure --identity <launch-identity> --json`. Then create with `mpx issue create --identity <launch-identity> --json`, including the approved title/body, Epic label, and optional milestone.
6. Capture and report the immutable Issue ID, URL, title, and milestone.

If label, milestone, or create capability returns `CAPABILITY_UNSUPPORTED`, stop that operation and report structured remediation. Never use a provider CLI fallback or claim creation.

---
name: issue-create
description: Create a clear provider-neutral Issue, optionally linked to an Epic
triggers: creating or recording an Issue
metadata:
  mpx:
    schemaVersion: 1
    skillPacks: [core]
    defaultExposure: name-only
---

# Create an Issue

Provider operations follow [the shared provider resolution and native command references](../shared/ISSUE_TRACKER.md).

Use [the canonical template](references/ISSUE_TEMPLATE.md) to create one well-scoped Issue.

## Workflow

1. Parse the confirmed summary, details, and optional explicit Epic ID. Ask only for missing information that changes the result.
2. If no Epic is supplied, list candidates with the resolved provider reference’s documented native operation with an explicit target and propose the best match; do not silently attach one. Fetch an approved Epic with the resolved provider reference’s documented native operation with an explicit target and retain requirements, milestone, and sibling relationships.
3. Explore relevant code and classify HITL versus AFK. Use `design needed` only for meaningful new visual workflows.
4. Build the body from the template: durable Description, mapped Requirements, independently testable Acceptance Criteria, optional relationships and notes, and unanswered questions only for HITL.
5. Ensure labels through the resolved provider reference’s documented native operation with an explicit target.
6. Run the resolved provider reference’s documented native operation with an explicit target with confirmed fields, assignment, labels, and supported milestone. Capture the immutable Issue ID and canonical URL.
7. For an approved Epic, request the resolved provider reference’s documented native operation with an explicit target. If supported, confirm the native link; otherwise preserve the created Issue and provide manual handoff.
8. Report ID, URL, title, labels, Epic link status, and blocking relationships.

## Capability handling

GitHub may support native sub-issues and templates; request those provider-resolved capabilities. GitLab or another provider may return `CAPABILITY_UNSUPPORTED`; report structured remediation and never emulate or invoke a provider CLI. Other structured errors stop the affected operation. Do not claim creation or linking without a successful response.

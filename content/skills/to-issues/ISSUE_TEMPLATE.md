# Issue Template

Canonical task Issue body for `to-issues`.

```markdown
> **Unanswered questions:**
>
> - [Question requiring a human decision; HITL Issues only]

## Description

[Imperative statement of outcome and reason]

## Requirements

- REQ-1: [Durable requirement mapped to the Epic body/comment]

## Acceptance Criteria

- [ ] [Independently observable condition]

## Epic

- Parent: #<epic-id> — <epic-title>: `<epic-url>`

## Blocking Relationships

- Blocked by #<issue-id> — <title>: `<url>` (reason)
- Blocks #<issue-id> — <title>: `<url>` (reason)

## Notes

[Optional constraints and prior art]
```

## Rules

- Omit the unanswered-questions blockquote for AFK Issues. HITL means an unresolved human decision, not manual testing,
  visual inspection, review, or QA.
- Description uses domain language without file paths. Requirements map to the Epic. Acceptance criteria describe
  behavior, not implementation.
- Always retain `## Epic`. Omit optional empty sections. After creation, relationships use immutable IDs plus canonical
  URLs and are written in both directions, sorted by ID.
- Every task receives `task`, exactly one of `HITL` or `AFK`, relevant area labels, and `design needed` for substantial
  new visual workflows.
- The Epic body owns the ordered `## Child Issues` index. These body links intentionally replace native parent/sub-Issue
  APIs and do not imply provider-native hierarchy or automatic checkbox synchronization.

# Issue Template

Provider-neutral task Issue body for `issue-create`.

```markdown
> **Unanswered questions:**
>
> - [Question requiring a human decision; HITL Issues only]

## Description

[Imperative statement of outcome and reason]

## Requirements

- REQ-1: [Durable requirement]

## Acceptance Criteria

- [ ] [Independently observable condition]

## Epic

- Parent: [Epic title and canonical URL or immutable ID]

## Blocking Relationships

- Blocked by [Issue title and canonical URL or immutable ID] (reason)
- Blocks [Issue title and canonical URL or immutable ID] (reason)

## Notes

[Optional constraints and prior art]
```

## Rules

- Omit the unanswered-questions blockquote for AFK Issues. HITL means an unresolved human decision, not manual testing,
  visual inspection, review, or QA.
- Description uses domain language without file paths. Requirements map to the Epic when linked. Acceptance criteria
  describe behavior, not implementation.
- Omit optional empty sections. Represent relationships with ordinary body links and immutable IDs; write reciprocal
  links without native sub-Issue APIs.
- Every task receives `task`, exactly one of `HITL` or `AFK`, relevant area labels, and `design needed` for substantial
  new visual workflows.
- Apply labels, assignment, and milestones only through capabilities documented in the selected provider guide. Report
  unsupported operations or partial failures without discarding a successfully created Issue.

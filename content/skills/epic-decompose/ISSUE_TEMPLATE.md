# Issue Template

Canonical provider-neutral task Issue body for `issue-create` and `epic-decompose`.

```markdown
> **Unanswered questions:**
> - [Question requiring a human decision; HITL Issues only]

## Description

[Imperative statement of outcome and reason]

## Requirements

- REQ-1: [Durable requirement]

## Acceptance Criteria

- [ ] [Independently observable condition]

## Blocking Relationships

- Blocked by [Issue ID] (reason)
- Blocks [Issue ID] (reason)

## Notes

[Optional constraints and prior art]
```

## Rules

- Omit the unanswered-questions blockquote for AFK Issues. HITL means an unresolved human decision, not manual testing, visual inspection, review, or QA.
- Description uses domain language without file paths. Requirements map to the Epic when linked. Acceptance criteria describe behavior, not implementation.
- Omit optional empty sections. Relationships use immutable provider-neutral Issue IDs.
- Every task receives `task`, exactly one of `HITL` or `AFK`, relevant area labels, and `design needed` for substantial new visual workflows.
- Label, assignment, milestone, template, and sub-issue operations are launch-bound MPX tool capabilities. A capability failure returns structured remediation and never authorizes a provider CLI fallback.

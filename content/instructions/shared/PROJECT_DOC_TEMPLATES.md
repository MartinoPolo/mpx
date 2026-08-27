# Project Documentation Scaffolds

Create both files with these headings when a setup workflow initializes `.mpx/` documentation.
Replace `[Project Name]` when known.

## `.mpx/CONTEXT.md`

```markdown
# [Project Name] Context

## What This Is
[Three-sentence project summary]

## Domain Language
[One-line definition-list entries]

## Relationships
[Entity cardinalities such as 1:N and N:1]

## Flagged Ambiguities
[Resolved term conflicts with rationale]

## Core Features
[Feature index: name, status, MPX Issue ID, and design pointer]

## Key Constraints
[Settled facts about the system]
```

## `.mpx/DECISIONS.md`

```markdown
# Decisions

Settled architectural and design decisions, updated only after user confirmation.

## [Domain]

### [Decision title]

Decided: YYYY-MM-DD
What: [One sentence describing the choice.]
Why: [One sentence explaining the rationale.]
Rejected: [Alternatives considered and why they lost.]
```

Roles, boundaries, formatting, and splitting policy are canonical in
[DOCUMENTATION_STRATEGY.md](DOCUMENTATION_STRATEGY.md).

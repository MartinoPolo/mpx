# Project Documentation Scaffolds

Create both files with these headings when a setup workflow initializes `.mpx/` documentation.
Replace `[Project Name]` when known. Preserve substantive files. Do not create, update, or fall back
to the retired `.mpx/REQUIREMENTS.md`, `.mpx/VOCABULARY.md`, or `.mpx/ARCHITECTURE.md` files.

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

[Feature index: name, status, configured-provider Issue ID, and design pointer]

## Key Constraints

[Settled facts about the system]
```

## `.mpx/DECISIONS.md`

```markdown
# Decisions

Settled architectural and design decisions, updated only after user confirmation.

## [Domain]

- [Confirmed decision, with useful rationale and only explicitly rejected alternatives inline.]
```

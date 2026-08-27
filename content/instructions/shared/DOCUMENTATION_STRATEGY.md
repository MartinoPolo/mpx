# Documentation Strategy: CONTEXT.md + DECISIONS.md

Two-document system for project context consumed by users and agents. Initial content follows
[PROJECT_DOC_TEMPLATES.md](PROJECT_DOC_TEMPLATES.md).

## `.mpx/CONTEXT.md` — what the project is

Read-heavy; target roughly 250–300 lines. It contains:

- a three-sentence summary;
- domain language as one-line definition-list entries;
- entity relationships and cardinalities;
- resolved ambiguities with rationale;
- a core-feature index with status, MPX Issue ID, and design pointer;
- settled system constraints.

Keep implementation maps, diagrams, stack minutiae, and pixel specifications elsewhere.

## `.mpx/DECISIONS.md` — why choices were made

Write-heavy; target roughly 200–300 lines. Group decisions by domain and use:

```markdown
### Decision title

Decided: YYYY-MM-DD
What: One sentence describing the choice.
Why: One sentence explaining the rationale.
Rejected: Alternatives considered and why they lost.
```

The date is when the decision was made. Everything in the file is accepted; avoid status
bureaucracy. When reversing a decision, replace the old entry and note the reversal rather than
leaving contradictory active rules.

## Domain language

```markdown
**Workspace** — Top-level container for one repository, project folder, and window.
**Issue** — Atomic work unit identified by one MPX Issue ID, worktree, branch, and color.
**Session** — One agent execution tied to an issue, with transcript, cost, and state.

_Avoid_: “task” for Issue, “project” for Workspace, “run” for Session.
```

Use one sentence per definition, an em dash, and `_Avoid_` lines after related clusters. Do not use
a terminology table.

## Responsibilities

Context discovery and vocabulary workflows read/update `CONTEXT.md`. Planning and review workflows
read both; review may update feature status using explicit MPX Issue IDs. Decision harvesting and
user-confirmed architecture sessions update `DECISIONS.md`. Setup workflows create only these two
files. Handoff workflows summarize them without becoming a third source of truth.

Older `.mpx/REQUIREMENTS.md`, `.mpx/VOCABULARY.md`, and `.mpx/ARCHITECTURE.md` files are read-only
history. Never create, update, or fall back to them.

When `DECISIONS.md` exceeds about 500 lines, split by stable domains under `decisions/` (for example
`platform.md`, `ui-design.md`, `data-state.md`, and `session-providers.md`). Until then keep one
file.

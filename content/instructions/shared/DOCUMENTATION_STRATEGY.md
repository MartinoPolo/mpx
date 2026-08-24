# Documentation Strateg<configured-path>CONTEXT.md + DECISIONS.md

Two-document system for project documentation consumed by AI agent skills.

## File Roles

### `.mpx/CONTEXT.md` — What This Project Is

Read-heavy. Every skill that needs project understanding reads this file. Targe<configured-path>**250–300 lines**.

Contain<configured-path>- **What This Is** — 3-sentence project summary
- **Domain Language** — One-line definitions using definition-list format (not tables)
- **Relationships** — Entity cardinalities (1:N, N:1)
- **Flagged Ambiguities** — Resolved term conflicts with rationale
- **Core Features** — Index onl<configured-path>feature name + status + epic# + design file pointer. Detail lives in epic issues
- **Key Constraints** — Settled facts about the system (SPA mode, single_instance, etc.)

Does NOT contai<configured-path>implementation details, module maps, mermaid diagrams, tech stack minutiae, pixel specs.

### `.mpx/DECISIONS.md` — Why We Chose What We Chose

Write-heavy. Updated after grill sessions. Targe<configured-path>**200–300 lines**.

Contains settled architectural and design decisions with rationale. Each entr<configured-path>markdown
### Decision title

Decide<configured-path>YYYY-MM-DD
Wha<configured-path>One sentence describing the choice.
Wh<configured-path>One sentence explaining the rationale.
Rejecte<configured-path>Brief list of alternatives considered and why they lost.
```

Does NOT contai<configured-path>requirements, vocabulary, implementation specs, or anything that changes frequently.

## Domain Language Format

Use definition-list style, not table<configured-path>markdown
## Domain Language

**Workspace** — Top-level containe<configured-path>one GitHub repo + one project folder + one window.
**Issue** — Atomic work unit. One GitHub issue, one worktree, one branch, one color.
**Session** — One AI agent execution tied to an issue. Has transcript, cost, state.

_Avoid_: "task" for Issue, "project" for Workspace, "run" for Session.
```

Rule<configured-path>- One sentence max per definition
- Bold the term, em-dash, definition
- Group `_Avoid_` lines after each cluster of related terms
- No table headers, no columns, no "Aliases to Avoid" column

## Decision Entry Format

```markdown
## Section (e.g., Platform, UI, Data)

### Single process, multi-window via single_instance

Decide<configured-path>2026-04-28
Wha<configured-path>One Tauri process, WebviewWindow per workspace.
Wh<configured-path>Shared SQLite, IPC between windows, simpler auth.
Rejecte<configured-path>Electron multi-process (too heavy), separate processes (IPC complexity).
```

Rule<configured-path>- Group by domai<configured-path>Platform & Infrastructure, UI & Design, Data & State, Session & Providers
- 3–5 lines per entry (what/why/rejected)
- Date is when the decision was made, not when it was written down
- No "Statu<configured-path>Accepted" bureaucracy — everything in this file is accepted
- If a decision is reversed, delete the old entry and add the new one with a note

## Skill Responsibilities

| Skill                    | Reads                        | Updates                           |
| ------------------------ | ---------------------------- | --------------------------------- |
| `mpx grill`               | CONTEXT.md, DECISIONS.md     | Both (after user confirmation)    |
| `mpx vocabulary`          | CONTEXT.md                   | CONTEXT.md § Domain Language      |
| `mpx to-epic`             | CONTEXT.md, DECISIONS.md     | —                                 |
| `mpx epic-review`         | CONTEXT.md, DECISIONS.md     | CONTEXT.md (status updates)       |
| `mpx consolidate-context` | CONTEXT.md                   | CONTEXT.md (cleanup)              |
| `mpx harvest-decisions`   | Session JSONL files          | CONTEXT.md, DECISIONS.md          |
| `mpx init-repo`           | —                            | Creates CONTEXT.md + DECISIONS.md |
| `mpx setup-sveltekit`     | —                            | Creates CONTEXT.md + DECISIONS.md |
| `mpx setup-react-native`  | —                            | Creates CONTEXT.md + DECISIONS.md |
| `mpx handoff`             | CONTEXT.md, DECISIONS.md     | writes HANDOFF.md                 |
| `mpx bug-report`          | CONTEXT.md § Domain Language | —                                 |
| `mpx to-issues`           | CONTEXT.md § Domain Language | —                                 |

## Legacy Files

Older projects may still have `.mpx/REQUIREMENTS.md`, `.mpx/VOCABULARY.md`, or `.mpx/ARCHITECTURE.md`. Skills should **not** create, update, or fall back to these files. If encountered in an existing project, treat them as read-only historical context — the canonical sources are CONTEXT.md and DECISIONS.md.

When initializing a new project, only scaffold CONTEXT.md and DECISIONS.md.

## When to Split DECISIONS.md

If the file exceeds ~500 lines, split by domain into a `decisions/` director<configured-path>- `decisions/platform.md`
- `decisions/ui-design.md`
- `decisions/data-state.md`
- `decisions/session-providers.md`

Until then, keep it as one file. Grovekeeper currently has ~50 decisions — well under the threshold.

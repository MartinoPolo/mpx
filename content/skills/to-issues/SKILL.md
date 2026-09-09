---
name: to-issues
description: Decompose an Epic into approved vertical-slice Issues with deterministic parent and dependency body links
triggers: breaking an Epic into implementation Issues
metadata:
  author: MartinoPolo
  version: '0.13'
  category: project-management
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: explicit-only
---

# Decompose an Epic

Argument: explicit Epic Issue number or URL. Use [the Issue template](ISSUE_TEMPLATE.md).

## Content and provider discovery

Resolve bundled skill assets relative to this loaded skill. For literal absolute reads, follow
[Content Paths](../shared/CONTENT_PATHS.md).

Read [Issue tracker policy](../shared/ISSUE_TRACKER.md), [provider routing](../shared/PROVIDER_ROUTING.md),
[exploration policy](../shared/EXPLORATION.md), and [sub-agent policy](../shared/SUBAGENT_PROTOCOL.md). Read nearest
valid `mpxconfig.json`; resolve `issues.provider` independently from `repository.provider`. This skill uses the Issue
provider only. Read its selected shared provider guide and use its target-bound native commands; do not invent MPX
facade actions or switch providers.

## Rules

- Fetch the explicit Epic body and every comment before analysis. A clearly authoritative later comment may supersede
  stale body text.
- Resolve Epic-wide ambiguity before decomposition. Explore discoverable facts instead of asking.
- Design vertical slices, not horizontal layers; each is independently implementable/testable and maps to Epic
  requirements.
- Create nothing until the user approves the complete breakdown.
- Every child receives `task`, exactly one of `HITL` or `AFK`, relevant area labels, and `design needed` for substantial
  new visual workflows.
- Parent/child and dependency relationships are deterministic Markdown body links, not native parent/sub-Issue APIs.

## Workflow

### 1. Fetch Epic and comments

Use the configured provider's native view command and fetch all comments. GitHub:

```bash
gh issue view <number> --json number,title,body,labels,state,url,comments
```

GitLab: use the shared provider guide's native `glab issue view`/API read forms required to obtain the Issue and all
notes. Stop if absent or body is empty.

### 2. Clarify ambiguity

Inspect contradictions, TBDs, missing details, and open questions. Batch related HITL questions into thematic rounds and
include a recommended answer. Add a later round only when earlier answers materially change it. A large slice-specific
question cluster may remain in that slice's unanswered-questions blockquote.

### 3. Explore

Delegate medium-breadth domain exploration to `mpx-explorer` (declared `exploration` model policy): patterns, services,
UI, data models, tests, and architectural boundaries. Stop after obvious locations and one alternate naming convention.

### 4. Design and classify slices

Target 3–15 tracer-bullet slices. Put the riskiest assumption first. For each define plain-English title (no Epic number
or conventional-commit prefix), outcome, mapped requirements, observable acceptance criteria, body-link relationships,
and labels. HITL means an unresolved human decision—not manual testing, review, QA, or visual inspection. Put unanswered
questions only in HITL Issues.

### 5. Approval gate

Present numbered title, HITL/AFK, Blocked by, requirements covered, and labels for every slice, plus the full dependency
graph. Ask for explicit approval and revise until received.

### 6. Ensure labels and create children

Use native label commands from the selected provider guide. For GitHub, list first and create only missing labels; do
not force-normalize existing labels unless the user approves that separate mutation:

```bash
gh label list --repo <target> --limit 100
gh label create task --repo <target> --description "Implementation task" --color 1D76DB
gh label create HITL --repo <target> --description "Human decision required" --color D93F0B
gh label create AFK --repo <target> --description "Ready for autonomous execution" --color 0E8A16
```

The selected GitLab guide supports label listing but not label creation. If any required label is absent, stop child
creation and return the exact manual label handoff.

Build body files from [ISSUE_TEMPLATE.md](ISSUE_TEMPLATE.md), including the final Epic section, then create sequentially
enough to capture every immutable ID and URL. Use the selected guide's target-bound `gh issue create` or GitLab
Issue-create API form. On ambiguous creation outcome, reconcile before retrying.

### 7. Deterministic body-link writeback

After all IDs exist, edit every child and the Epic so links and dependencies are exact:

```markdown
## Epic

- Parent: #<epic-id> — <epic-title>: `<epic-url>`

## Blocking Relationships

- Blocked by #<id> — <title>: `<url>` (reason)
- Blocks #<id> — <title>: `<url>` (reason)
```

Replace the Epic's `## Child Issues` section with creation-order entries:

```markdown
## Child Issues

- [ ] #<id> — <title>: `<url>` — `HITL|AFK`
```

Preserve all other Epic text byte-for-byte where practical. Sort child links by approved creation order; sort each
relationship list by immutable ID. Include both directions for every dependency. Use the selected guide's target-bound
native edit command (`gh issue edit ... --repo <target> --body-file ...` or the documented GitLab Issue update API
form). If any writeback fails, do not claim that relationship; report created Issues and exact repair edits.

### 8. Report

Report Epic ID/title, selected `issues.provider`, created count, each child URL/classification, final dependency graph,
body-writeback evidence, and provider limitations.

## Provider limitations

GitHub and GitLab Issue bodies can preserve the approved relationship convention, but checkboxes are documentary and do
not auto-sync with child state. GitLab does not gain native Epic hierarchy from these links. Local, KanbanFlow, `none`,
missing native tools, or providers without reliable body editing cannot complete this workflow automatically; stop the
affected operation and give a deterministic manual handoff. Milestones are inherited only when explicitly approved and
supported—never infer inheritance.

---
name: issue-create
description: Create a clear provider-neutral Issue, optionally linked to an Epic
triggers: creating or recording an Issue
metadata:
  author: MartinoPolo
  version: '0.11'
  category: utility
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: name-only
---

# Create an Issue

Create one well-scoped Issue from the invocation input using [the canonical template](references/ISSUE_TEMPLATE.md).

## Provider and identity

Read the nearest committed `mpxconfig.json` and resolve `issues.provider` exactly as specified by
[provider routing](../shared/PROVIDER_ROUTING.md). Load only the selected [GitHub](../shared/providers/GITHUB.md),
[GitLab](../shared/providers/GITLAB.md), [KanbanFlow](../shared/providers/KANBANFLOW.md), or
[Local Markdown](../shared/providers/LOCAL.md) guide. Preserve launch-bound authentication and target identity. Never
infer a provider from remotes, switch providers, or invent a command. Use the native Issue interface selected by that guide; Local Markdown uses its documented application entrypoint.

When a canonical content file must be read with a tool, resolve it according to
[content paths](../shared/CONTENT_PATHS.md).

## Workflow

### 1. Parse intent

From the invocation input, extract:

- a concise one-line summary;
- supplied details, constraints, and expected outcome;
- an optional explicit Epic identifier;
- requested assignment, milestone, labels, and dependencies, if any.

Ask only for missing information that changes the Issue materially. Never reinterpret an explicit Epic identifier.

### 2. Resolve an optional Epic

If an Epic was supplied, view it through the selected provider and confirm that it is the intended open Epic.

If none was supplied, perform a medium-breadth search of open Issues for Epic-labelled candidates. Compare their titles
and bodies with the requested outcome. Propose the single best candidate and obtain approval before linking; if there is
no strong match, create a standalone Issue. Never silently attach an Epic.

For an approved Epic, retain its canonical URL or immutable ID, requirements, milestone, and linked sibling/dependency
context. Milestone inheritance is allowed only when the selected provider supports milestones and the Epic has one;
resolve the exact existing milestone before creation and never create one implicitly.

### 3. Explore the codebase

Spawn `mpx-explorer` with medium breadth to identify affected domains, existing patterns and tests, architectural
boundaries, and useful area labels. Describe durable module behavior in the Issue, not machine paths or line numbers.

### 4. Classify and label

Classify the Issue as:

- `HITL` when an unresolved product, contract, business-rule, or approach decision requires a human answer;
- `AFK` when scope and acceptance criteria permit autonomous implementation.

Manual testing, visual inspection, review, and QA alone do not make an Issue HITL. Once all questions are resolved, use
AFK.

Every created task receives:

- `task` — description `Implementation task`, color `0E8A16`;
- exactly one of `HITL` — `Requires human interaction`, color `FBCA04` — or `AFK` — `Can be implemented autonomously`,
  color `0E8A16`;
- relevant existing or approved area labels such as `area:api`, `area:ui`, or `area:db`;
- `design needed` — `Requires design (mockup + refine) before/with implementation`, color `5319E7` — only for
  substantial new UI, significant visual change, complex layout, or a user-facing workflow needing design exploration;
  not for backend-only work, ordinary bug fixes, or minor UI tweaks.

List labels using the selected provider guide. Where label creation is supported, create only missing canonical labels
with the exact names, descriptions, and colors above; do not overwrite existing labels merely to normalize them.
KanbanFlow labels must already exist. If ensuring a required label is unsupported, report the gap rather than switching
interfaces or claiming it was applied.

### 5. Build the body

Follow [the canonical template](references/ISSUE_TEMPLATE.md) exactly:

- include the unanswered-questions blockquote only for HITL;
- write an imperative, durable Description;
- map relevant Epic requirements when linked, or define standalone requirements when needed;
- make every Acceptance Criterion independently observable and testable;
- include only real relationships and optional useful notes;
- omit optional empty sections.

Represent parent/child and blocking relationships with canonical URLs or immutable IDs in the body. Do not use native
hierarchy APIs. For an Epic child, add a child link to the Epic body and a Parent Epic link to the child body. Add
reciprocal dependency links where applicable. Review every multiline body before submission.

### 6. Create and reconcile

Create the Issue using only the selected provider guide, with confirmed title, body, labels, and assignment or inherited
milestone only where the guide documents those capabilities. Capture the immutable created Issue ID and canonical URL
from the successful response; this ID remains the identity for all later updates.

After creation, update the child and Epic bodies to include reciprocal canonical links. Re-read before editing, preserve
unrelated body content, and use the immutable created ID. If a reciprocal update, assignment, milestone, label, or other
optional operation is unsupported or fails, preserve the successfully created Issue and provide a precise manual
handoff. Never report a relationship or field as applied without provider confirmation.

## Output

Truthfully report:

- immutable Issue ID and canonical URL;
- title and labels actually applied;
- assignment and milestone actually applied, when any;
- approved Epic and reciprocal-link status, when any;
- blocking relationships recorded;
- every unsupported, failed, or manually required follow-up.

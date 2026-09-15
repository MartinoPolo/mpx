---
name: epic-create
description: Create an approved Epic Issue from project requirements using the configured Issue provider
triggers: turning requirements into an Epic specification
metadata:
  author: MartinoPolo
  version: '0.9'
  category: project-management
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: explicit-only
---

# Create an Epic

Create one Epic whose body is the durable specification. Optional argument: milestone name.

## Content and provider discovery

Resolve bundled skill assets relative to this loaded skill. For literal absolute reads, follow
[Content Paths](../shared/CONTENT_PATHS.md).

Read [Issue tracker policy](../shared/ISSUE_TRACKER.md),
[provider routing](../shared/PROVIDER_ROUTING.md), [exploration policy](../shared/EXPLORATION.md),
and [sub-agent policy](../shared/SUBAGENT_PROTOCOL.md). Read the nearest valid `mpxconfig.json`
before provider work. Resolve `issues.provider` independently from `repository.provider`; this
workflow uses only `issues.provider`. Follow the selected provider guide and its documented native
commands. Do not invent an MPX facade action.

Provider limits and target binding are defined by the selected guide. Stop only an affected
unsupported branch and return the exact limitation and manual step rather than switching providers;
preserve independently completed work.

## Workflow

### 1. Read requirements

Read `.mpx/CONTEXT.md` first and `.mpx/DECISIONS.md` when present. If context is absent, report the
error and stop. Requirements and supplied conversation are inputs; settled decisions constrain the
design.

### 2. Explore current state

Delegate medium-breadth exploration to named agent `mpx-explorer` (declared `exploration` model
policy). Ask it to identify project name, dependencies/scripts, structural boundaries, existing
docs, patterns/frameworks, and test prior art. Stop when both obvious locations and one alternate
naming convention have been checked.

### 3. Design modules and testing boundaries

Sketch major modules/components, favoring deep modules with small interfaces hiding substantial
implementation. Identify interactions, risks, and modules needing tests.

HITL prompt:

> Here is the proposed module breakdown. Does this match your expectations? Which modules need
> tests?

Incorporate the answer before drafting.

### 4. Draft the specification

Use these sections:

- **Overview** — what and why, tied to project context.
- **User Stories** — `As a [user], I want [action], so that [benefit].`
- **Scope** — explicit Included and Excluded lists.
- **Acceptance Criteria** — measurable checkboxes mapped to stories.
- **Technical Notes** — architecture constraints, versions/dependencies, risks, open questions.
- **Implementation Decisions** — modules, interfaces, schemas/contracts, and interactions; no file
  paths or code snippets.
- **Testing Decisions** — valuable tests, selected modules, test-suite prior art, and boundaries.
- **Child Issues** — initialize with `_None yet._`; `to-issues` replaces this with deterministic
  body links.

Use project domain language and provider-compatible Markdown.

### 5. Approval gate

Show the complete draft and ask:

> Here is the Epic specification draft. Approve it, or describe edits?

Revise and re-show substantial changes. Never create before explicit approval.

### 6. Create through the selected Issue provider

Ensure an `epic` label exists, described as `Epic — parent issue`, then create the Issue with
approved title/body and label. Use the selected guide's explicit target on every command. For
GitHub, list before creating; do not force-normalize an existing label unless the user separately
approves changing it:

```bash
gh label list --repo <target> --limit 100
gh label create epic --repo <target> --description "Epic — parent issue" --color 0052CC
gh issue create --repo <target> --title "<approved title>" --label epic --body-file <approved-body-file>
```

The selected GitLab guide supports listing labels but not label creation. If `epic` is absent,
return a manual label-creation handoff without attempting Issue creation. If present, use the
guide's documented Issue-create API command with the approved body file and label.

Capture the provider-returned immutable ID/number and URL. On ambiguous mutation outcome, reconcile
native provider state before any retry.

### 7. Optional milestone

If a milestone argument was supplied, assign it with the selected Issue provider's native command.
Preserve native behavior: the milestone must already exist unless the provider guide explicitly
supports approved creation. For GitHub use the guide's target-bound `gh issue edit` form. For GitLab
resolve the exact milestone ID and use the guide's documented Issue update API form. If unsupported,
preserve the created Epic and report the limitation; do not silently omit it.

### 8. Report

Report Issue URL, immutable ID/number, title, milestone result, selected `issues.provider`,
commands/results used as evidence, and provider limitations or remaining manual action.

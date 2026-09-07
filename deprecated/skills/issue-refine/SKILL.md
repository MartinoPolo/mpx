---
name: issue-refine
description: Refine an Issue into an implementable provider-neutral specification
triggers: clarifying scope or acceptance criteria for an Issue
metadata:
  mpx:
    schemaVersion: 1
    skillPacks: [core]
    defaultExposure: name-only
---

# Refine an Issue

Turn an existing Issue identified by the invocation input into a concise, verifiable specification while preserving
confirmed intent.

## Provider routing

Read the nearest committed `mpxconfig.json`, resolve `issues.provider`, and follow
[provider routing](../shared/PROVIDER_ROUTING.md). Load only the selected [GitHub](../shared/providers/GITHUB.md),
[GitLab](../shared/providers/GITLAB.md), [KanbanFlow](../shared/providers/KANBANFLOW.md), or
[Local Markdown](../shared/providers/LOCAL.md) guide. Preserve launch-bound authentication and explicit repository,
board, project, and Issue identity. Never infer from remotes, switch providers, or invent a fallback command. Local
Markdown uses only its documented MPX Issue interface. Resolve canonical tool paths through
[content paths](../shared/CONTENT_PATHS.md).

## Workflow

1. Resolve the intended Issue identifier from the invocation input or unambiguous conversation context. Ask when
   multiple identifiers are plausible.
2. View the Issue through the selected provider. Preserve its immutable identifier, canonical URL, state, title, body,
   labels, milestone, assignment, comments, and relationships when returned. Distinguish absent fields from empty ones.
3. Inspect relevant repository evidence at sufficient breadth to understand current behavior, boundaries, tests, prior
   art, dependencies, and the project's domain language. Do not replace confirmed product intent with implementation
   guesses.
4. Identify ambiguity in the problem, scope boundaries, requirements, acceptance criteria, dependencies, design needs,
   and verification expectations. Ask focused questions only for decisions that repository evidence cannot resolve.
5. Draft a revised title and body. Use the public term Issue and durable domain language; avoid machine paths and line
   numbers. Preserve useful existing context and unrelated relationship links. Make requirements imperative and
   acceptance criteria independently observable. Include unanswered questions only when genuinely HITL, and ensure
   labels remain consistent with the resolved HITL/AFK state and meaningful `design needed` rules.
6. Show the proposed material changes before writing unless the user already authorized direct refinement. Clearly call
   out title, body, label, assignment, milestone, or relationship changes.
7. Apply only approved fields with the selected provider's documented edit operation. For multiline content, use the
   guide's safe body-file mechanism when available and inspect content before submission. Use a comment only when
   preserving a discussion note is preferable to changing the canonical Issue body.
8. Re-read the Issue when supported and summarize only provider-confirmed state. A failed optional re-read does not
   invalidate a confirmed edit, but state that verification failed.

## Relationships and unsupported operations

Use reciprocal body links for Epic/child and dependency relationships; never create or depend on native hierarchy.
Re-read each body before updating and preserve unrelated content. Unsupported label creation, milestone, assignment,
relationship, comment, or edit behavior is a concrete capability gap and manual handoff, not permission to switch
provider or interface.

On any structured provider error, report the code and actionable message and stop the affected operation. Do not claim
an edit without a successful response.

## Output

Report the immutable Issue ID and canonical URL, the confirmed title/state, material refinements applied, labels and
relationships actually present, unresolved questions, and any unsupported or unverified operation.

---
name: issue-create
description: 'Creates one Issue in the configured provider. Use when "create issue", "create a ticket", or to track a bug or follow-up instead of fixing it now.'
triggers: creating or recording an Issue
metadata:
  author: MartinoPolo
  version: '0.14'
  category: utility
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: normal
---

# Create an Issue

Create one Issue from the specified context without waiting for approval; the user reviews it in
the provider. If the project has its own `issue-create` skill, follow that skill instead.

## Provider

Resolve project configuration as specified by
[Provider Routing]({{MPX_SHARED_INSTRUCTIONS}}/PROVIDER_ROUTING.md), then select `issues.provider`.
Load only the selected
[GitHub]({{MPX_SHARED_INSTRUCTIONS}}/providers/GITHUB.md) or
[KanbanFlow]({{MPX_SHARED_INSTRUCTIONS}}/providers/KANBANFLOW.md) guide. Never infer a provider from
remotes, switch providers, or invent a command. An unsupported provider receives a manual handoff
with the composed title and body.

## 1. Investigate briefly

Investigate only enough to describe the Issue correctly; the executor explores the code, the cause, and the fix itself.

- Find where the Issue is visible: page URL, story, or failing command.
- When it is visible in a UI, take a screenshot that shows it; the user checks it at a glance.
- Keep every useful image the user supplied as evidence, from its source path.
- Do not probe candidate fixes, write test harnesses, or inventory code unless the user asks.

## 2. Compose

Write the title, body, and optional comments per
[the Issue template]({{MPX_SHARED_INSTRUCTIONS}}/ISSUE_TEMPLATE.md).

Stop and ask only when you cannot describe the Issue without the user's decision, for example when
it is unclear what they want. Otherwise create it and put the open questions in its HITL section.

## 3. Classify

- `task` (`Implementation task`, `0E8A16`) and exactly one of `AFK` (`Can be implemented
  autonomously`, `0E8A16`) or `HITL` (`Requires human interaction`, `FBCA04`). `AFK` when the scope
  and acceptance criteria are clear and no question is open.
- Relevant existing area labels.
- `design needed` (`Requires design (mockup + refine) before/with implementation`, `5319E7`) only for
  substantial new UI or a user-facing workflow that needs design exploration.

Where the provider supports label creation, create only missing labels with these exact values.
Where it does not, apply the labels that exist and report the rest; the HITL section alone marks an
Issue `HITL`.

## 4. Create

Skip creation when an open Issue already covers the same problem; report that Issue instead.
Otherwise create the Issue through the selected provider guide, attaching screenshots or logs
already on disk where the provider supports it, then add the comments. For an Epic or blocker the
user named, write the reciprocal body link on the other Issue after re-reading it, preserving its
unrelated content.

## Output

The immutable ID and a clickable canonical URL, the title, the labels actually applied, the open
questions the Issue carries, and every failed or unsupported operation with a manual handoff.

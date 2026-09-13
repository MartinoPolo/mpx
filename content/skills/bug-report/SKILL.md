---
name: bug-report
description:
  "Investigates a bug's root cause, designs a TDD fix plan, and opens an issue/task labelled bug in
  the..."
metadata:
  author: MartinoPolo
  version: '0.6'
  category: issue-management
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: name-only
---

# Bug Report

Investigate each bug from the invocation input to its root cause, design a TDD fix plan, and create
or update an Issue through the selected Issue provider.

## Provider routing

Read the nearest committed `mpxconfig.json`, resolve `issues.provider`, and follow
[provider routing]({{MPX_SHARED_INSTRUCTIONS}}/PROVIDER_ROUTING.md). Load only the selected
[GitHub]({{MPX_SHARED_INSTRUCTIONS}}/providers/GITHUB.md) or
[KanbanFlow]({{MPX_SHARED_INSTRUCTIONS}}/providers/KANBANFLOW.md) guide. Preserve the native
authentication environment and explicit target identity. Never infer from remotes, switch providers,
or invent commands. An unsupported Issue provider receives a bounded manual handoff.

## Input resolution

- If the invocation input is present, parse it as one or more bug descriptions. Blocks separated by
  blank lines are separate bugs only when each block describes a distinct failure.
- If it is absent, ask the user to describe actual behavior, expected behavior, and reproduction.
- Investigate one bug once. For multiple independent bugs, run separate named investigations in
  parallel.

## Process per bug

### 1. Capture the problem

Extract actual behavior, expected behavior, reproduction steps, environment details relevant to the
failure, and observed diagnostics. Ask only for critical information without which investigation
cannot proceed; then investigate promptly. Never publish secrets, machine paths, private identity
data, or unrelated logs.

### 2. Investigate root cause

Spawn a named `mpx-issue-analyzer` agent for each bug. For multiple bugs, launch those agents in
parallel and keep their evidence separate. Give each agent the parsed problem and require it to:

1. locate where the failure manifests;
2. reproduce or trace the relevant public behavior when feasible;
3. follow the code and data path across module boundaries;
4. identify the root cause rather than restating the symptom;
5. find related patterns, regressions, tests, and likely affected behavior;
6. return evidence, affected modules, and a durable root-cause explanation.

Reconcile the agent result with repository evidence. If the root cause remains uncertain, label it
as a hypothesis and identify the missing evidence rather than asserting certainty.

### 3. Design the TDD fix plan

Create ordered RED-GREEN cycles. Each cycle is a vertical behavioral slice:

- **RED:** add one test through a public interface that demonstrates the broken or missing behavior;
- **GREEN:** make the smallest production change that satisfies that behavior;
- repeat for distinct behaviors;
- **REFACTOR:** clean up only after all cycles pass.

Tests must survive internal refactors. Include regression boundaries and relevant error cases
without prescribing brittle implementation details.

### 4. Search for duplicates

Before creating anything, search open and closed Issues through the selected provider using the
symptom, domain terms, diagnostics, and root-cause concepts. View plausible matches.

- If an existing Issue describes the same root cause and scope, update its durable body when
  authorized or add a concise evidence comment; do not create a duplicate.
- If a similar Issue differs materially, record the relationship in the new Issue body.
- If provider search, edit, or comment is unsupported, report that limitation and do not claim
  duplicate resolution.

### 5. Create or update the Issue

Use title format `bug: [concise description]`. Ensure the `bug` label exists using only the selected
provider's supported label operation, and include relevant existing area labels discovered during
investigation. KanbanFlow labels must already exist. If label creation is unsupported, report the
gap truthfully.

Use this durable body:

```markdown
## Problem

**Actual behavior:** [what happens] **Expected behavior:** [what should happen]

**How to reproduce:**

1. [step 1]
2. [step 2]

## Root Cause Analysis

[Why the code path fails and contributing contract or state conditions, expressed in durable module
and behavior terms]

## TDD Fix Plan

1. **RED:** [public behavior to verify] **GREEN:** [minimal behavioral change]

2. **RED:** [next public behavior] **GREEN:** [next minimal change]

3. **REFACTOR:** [cleanup after all tests pass]

## Acceptance Criteria

- [ ] [independently observable outcome]
- [ ] [regression boundary]
```

Omit unsupported or unknown details rather than fabricating them. Do not put file paths, line
numbers, transient implementation details, or machine-specific data in the Issue. Use project domain
language, including `.mpx/CONTEXT.md` when present. Review multiline content before submission.

Create or update only through the selected guide. Capture the immutable Issue ID and canonical URL
from the successful response. A successful creation remains valid if a later optional label,
assignment, comment, or relationship update fails; report the exact capability gap and required
manual action.

## Report

For each bug, report:

- immutable Issue ID and canonical URL;
- whether an Issue was created, updated, or identified as a duplicate;
- one-line root-cause summary and confidence when uncertain;
- labels actually applied;
- unsupported, failed, or manually required follow-up.

Never claim creation, update, duplicate linkage, or label application without provider confirmation.

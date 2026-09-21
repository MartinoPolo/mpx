---
name: code-clean
description: 'Deduplicates code, removes repetition, and deletes dead code in a given scope.'
metadata:
  author: MartinoPolo
  version: '0.5'
  category: code-review
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: name-only
---

# Code Clean

Run focused code-quality cleanup and apply easy wins immediately. Target duplication, repetition,
and dead/unused code. Use the invocation input as the requested scope.

## Objectives

- Enforce DRY in practical scope
- Remove dead/unused code safely
- Reduce repeated logic and copy-paste blocks
- Keep behavior unchanged

## Workflow

### Step 1: Resolve Scope and Build File Groups

Parse the invocation input as file/s or folder/s scope, then build meaningful module groups.

- Group by feature/module boundaries (example: full dashboard module)
- Preserve relationships between files in each group
- Keep each logical module within a single group

Rules:

- Always spawn sub-agents for execution (agent types named in Steps 2-3)
- If scope is a single folder, still create at least one grouped module context
- If scope is a single file, expand to nearest logical module group (not file-only review)

### Step 2: Spawn Review Subagents per Group

For each file group, spawn the named `mpx-reviewer-code-quality` agent using its declared review
model policy (finding duplication and judging risk needs judgment). Reviewers must run in sessions
distinct from the author/executor; request fresh review of changed scope when the reviewed diff
changes.

Use this exact review prompt shape:

```text
You are reviewing one module group for immediate code cleanup.

Goal:
- Find DRY violations, duplication/repetition, and dead/unused code.
- Propose low-risk cleanups that preserve behavior.
- Optimize for understandable behavior. Prefer direct control flow, cohesive responsibilities, and explicit data flow.

Input:
- Module group: <folder/files list>
- Boundaries: review only this group and direct dependencies.

Required actions:
1) Identify duplicated logic and repeated patterns.
2) Identify dead/unused exports, imports, helpers, and unreachable code.
3) Prioritize easy wins first.
4) Produce an edit plan with exact files and concrete changes.

Required output:
- Findings grouped by file
- Ranked cleanup plan (easy wins first)
- Risk notes per proposed change
```

### Step 3: Spawn Fix Subagents per Group

For each reviewed group, spawn named `mpx-executor` agent with approved findings. The prompt
must carry the full pre-analyzed plan with exact files and concrete changes, relevant requirements,
known failures, observable acceptance criteria, a precise cleanup objective, and file pointers.
Instruct it to inspect the current `git diff` and relevant files itself. If a finding still needs
judgment (unclear plan, cross-module tradeoffs), return it to `mpx-reviewer-code-quality` for a
concrete decision and plan before dispatching `mpx-executor`.

Use this exact fix prompt shape:

```text
You are a fresh executor applying approved cleanup changes for one module group. Inspect the current
git diff and relevant files before editing.

Goal:
- Execute the approved deduplication and dead-code-removal plan.
- Keep behavior and signatures stable.

Input:
- Module group: <folder/files list>
- Approved findings/plan: <review output>
- Requirements and known failures: <relevant requirements/failures or none>
- Acceptance criteria: <observable criteria>
- Repair objective: <precise cleanup outcome>
- File pointers: <files and direct dependencies>

Required actions:
1) Apply deduplication and repetition removal.
2) Remove dead/unused code safely.
3) Keep public contracts stable unless plan explicitly allows change.
4) Keep edits narrow and scoped to the approved plan.
5) Preserve existing meaningful coverage and add or update tests only when they proportionally
   verify changed behavior, important failure modes, or a known regression.
6) Run targeted checks/tests for touched files when available.

Required output:
- Applied edits by file
- What was removed/consolidated
- Validation results
- Follow-ups not completed and why
```

Fix subagent must reject unapproved scope expansion.

### Step 4: Validate and Summarize

Run targeted validation on touched groups. Report outcomes per group.

- Cleanups applied
- Duplications removed
- Dead code removed
- Validation status and remaining follow-ups

## Constraints

- Prefer small, reversible edits
- No new features
- Keep naming explicit and consistent

## Output

Display:

- Scope and group map
- Subagents dispatched (review + fix)
- Applied cleanups by module group
- Validation summary

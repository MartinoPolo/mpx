---
name: decompose
description:
  'Splits large files or folders into logical modules while preserving behavior and public APIs.'
argument-hint: '[file or folder ...]'
triggers: decompose large file; split oversized module; reorganize folder without behavior changes
metadata:
  author: MartinoPolo
  version: '0.4'
  category: refactor
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: name-only
---

# Decompose Large Files

Split oversized files into logical modules. Keep functionality unchanged, enforce DRY, and improve
organization. Use `the invocation input` as the requested scope.

## Goals

- Preserve runtime behavior and public API.
- Reduce file size and responsibility overlap.
- Organize by role: constants, utilities, types, hooks, context, components, and services as
  applicable.
- Keep each requested large file as an independently verifiable decomposition unit.

## Workflow

### Step 1: Resolve scope

Parse `the invocation input` into explicit file or folder targets.

- Ask for scope when none was supplied.
- Preserve each supplied file as a separate decomposition unit.
- For a folder, inventory candidate source files deterministically, identify the large files, and
  prioritize the highest-impact units using size, responsibility overlap, and dependency centrality.
  Report the resulting units before editing.

### Step 2: Dispatch decomposition units

Spawn one native subagent per unit using the Agent capability available in {{MPX_HARNESS}}. Select
the canonical `advanced` class with medium effort through structured runtime options when the native
agent has no declared policy; do not embed a vendor model ID or add model-resolution machinery. Use
fresh bounded context for each unit and dispatch disjoint units in parallel. Each prompt must name
the target, allowed related paths, project conventions, and exact verification commands when known.

Use this prompt contract for every unit:

```text
You are decomposing one large file into multiple files/modules.

Goal:
- Split the target file into logical modules (constants, utilities, types, hooks,
  context, components, or services as applicable).
- Preserve behavior, naming conventions, and public API.
- Improve DRY and organization.

Input:
- Target unit: <file path>
- Allowed scope: <related module paths>
- Constraints: no feature changes and no behavior changes.

Required actions:
1) Read the complete target and relevant direct dependencies.
2) Identify extraction boundaries and state each module's responsibility.
3) Create multiple files/modules rather than rewriting one large file in place.
4) Move code into clearly named modules.
5) Update imports, exports, and every reference in the allowed scope.
6) Remove dead code discovered during extraction.
7) Run the supplied targeted checks/tests; when none were supplied, perform static
   verification of imports, exports, and call paths and say that final command verification
   remains with the parent.

Required output:
- New file tree for this unit.
- Mapping of old sections to new files.
- Public API and behavior-preservation evidence.
- Exact verification results or static-verification evidence.
- Residual risks.
```

Require the sub-agent to stop and return the concrete blocker when a safe multi-module split is not
possible. A blocked unit must not cause independent units to be abandoned.

### Step 3: Validate preservation

Reconcile each unit's edits and evidence exactly once. Run the project-native targeted checks
supplied by the caller or discovered in directly relevant project configuration. Do not invent
commands. When executable checks are unavailable, statically validate imports, exports, public entry
points, and call paths, and label that evidence as static rather than test evidence.

Confirm for every unit that:

- external behavior and public exports remain stable;
- newly introduced modules have one clear responsibility;
- all moved symbols have updated references;
- no feature work entered the diff;
- dead-code removal is limited to code made provably unreachable or unused by the split.

### Step 4: Report results

Return one outcome per unit, including blocked units, and a combined validation status.

## Constraints

- Preserve external behavior and public APIs.
- Keep edits within decomposition scope.
- Use descriptive names consistent with the repository.
- Remove only dead code established during the split.
- Do not commit, publish, or deploy.

## Output contract

```markdown
Scope Resolved:

- [unit]

Subagents Dispatched:

- [unit -> agent/model class]

Decomposition Outcomes:

- [unit]: [new module layout and old-section mapping]

Preservation Evidence:

- [unit]: [API/behavior and DRY notes]

Validation:

- [command and exact result, or static verification]

Residual Risks:

- [none or bounded risk]
```

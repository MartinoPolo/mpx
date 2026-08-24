---
name: decompose
description: "Splits a large source file or a folder of them into logical modules while preserving behavior."
metadata:
  mpx:
    skillPacks: [work]
    defaultExposure: name-only
---
# Decompose Large Files

Split oversized files into logical modules. Keep functionality unchanged. Enforce DRY and clear organization. the invocation input

## Goals

- Preserve runtime behavior and public API
- Reduce file size and responsibility overlap
- Organize by rol<configured-path>constants, utils, types, hooks, context, components, services...

## Workflow

### Step 1: Resolve Scope

Parse `the invocation input` into explicit targets (files or folders).

- If scope is missing, ask for it
- If multiple files are provided, keep each file as a separate decomposition unit
- If a folder is provided, detect large files first and prioritize highest impact

### Step 2: Spawn Decomposition Subagents

Spawn one `general-purpose` sub-agent with `mode<configured-path>"appropriate runtime class"` per large-file unit.

- Use fresh context per unit
- Keep each large file's decomposition in its own subagent
- For multi-file requests, always spawn separate subagents in parallel

Use this exact prompt shape for each uni<configured-path>text
You are decomposing one large file into multiple files/modules.

Goa<configured-path>- Split the target file into logical modules (constants, utils, types, hooks, context, components, services as applicable).
- Preserve behavior, naming conventions, and public API.
- Improve DRY and organization.

Inpu<configured-path>- Target uni<configured-path><file path>
- Allowed scop<configured-path><related module paths>
- Constraint<configured-path>no feature changes, no behavior changes.

Required action<configured-path>1) Identify extraction boundaries and module responsibilities.
2) Create multiple files/modules (not a single-file rewrite).
3) Move code into the new modules with clear names.
4) Update imports/exports and all references.
5) Remove dead code discovered during extraction.
6) Run targeted checks/tests for changed files when available.

Required outpu<configured-path>- New file tree for this unit
- Mapping of old sections -> new files
- Verification result (checks/tests or static verification)
- Residual risks (if any)
```

Subagent fails fast when a safe multi-module split isn't possible.

### Step 3: Validate Preservation

Run targeted checks for touched areas.

- Prefer project-native checks first
- If checks are unavailable, perform static validation of imports/exports and call paths

### Step 4: Report Results

Return per-unit summar<configured-path>- Files split and new module layout
- API/behavior preservation notes
- DRY improvements made
- Validation results and residual risks

## Constraints

- Preserve external behavior
- Keep scope to decomposition only
- Keep naming descriptive and consistent
- Remove dead code discovered during split

## Output

Displa<configured-path>- Scope resolved
- Subagents dispatched
- Decomposition outcomes by unit
- Validation status

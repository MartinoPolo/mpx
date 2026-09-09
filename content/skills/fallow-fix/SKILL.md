---
name: fallow-fix
description: 'Diagnoses and fixes fallow dead-code audit failures, suppressing or baselining findings when justified.'
metadata:
  author: MartinoPolo
  version: '0.3'
  category: code-quality
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: name-only
---

# Fallow Fix

Diagnose and resolve fallow code-quality failures. Use the invocation input as diagnostic context.

## Step 1: Identify the Failure

Run the appropriate diagnostic command based on what failed:

- **Dead-code regression** (`check:fallow` failed): output already shows all issues with file:line and rule explanations
- **Audit failure** (fallow-gate hook blocked commit/push): `pnpm fallow:audit` for JSON details
- **Need more detail**: re-run `pnpm check:fallow` — `--explain` includes rule descriptions and docs URLs

Parse the JSON output. Each issue has `path`, `line`, `name`, `severity`, and `actions`.

## Step 2: Categorize Each Issue

For each issue, determine the correct action:

### Fix (default — remove the dead code)

- Unused file → delete it
- Unused export → remove the `export` keyword or delete the declaration
- Unused dependency → `pnpm remove <package>`
- Stale suppression → remove the `// fallow-ignore-*` comment

### Suppress (only when the code is intentionally unused)

#### Situation: Public API export consumed by external packages

- **Suppression:** `/** @public */` above the export

#### Situation: Intentionally pre-exported for planned use

- **Suppression:** `/** @expected-unused */` above the export (becomes stale warning when used)

#### Situation: Framework lifecycle method (mount, destroy, etc.)

- **Suppression:** `// fallow-ignore-next-line unused-class-member`

#### Situation: Interface implementation method

- **Suppression:** `// fallow-ignore-next-line unused-class-member`

#### Situation: High-complexity function that can't be split now

- **Suppression:** `// fallow-ignore-next-line complexity`

#### Situation: Entire generated file

- **Suppression:** `// fallow-ignore-file` at top

**Always** specify the suppression kind in `// fallow-ignore-next-line`.

### Available suppression kinds

`unused-export`, `unused-type`, `unused-class-member`, `unused-enum-member`, `unresolved-import`, `unlisted-dependency`,
`duplicate-export`, `circular-dependency`, `complexity`, `code-duplication`, `coverage-gaps`

## Step 3: Apply Fixes

1. Fix or suppress each issue.
2. After each fix, use the narrowest available form of the original diagnostic as incremental feedback. Do not treat
   this per-fix rerun as final verification.
3. If dead-code count legitimately changed (new public API, refactored exports), update the baseline:

```bash
pnpm fallow:baseline
```

Commit the updated `fallow-baselines/regression.json` alongside your code changes.

## Step 4: Final Verification

After all fixes and any baseline update, run the original failing check once as final verification:

- `pnpm check:fallow` — must exit 0
- `pnpm fallow:audit` — verdict must be `pass` or `warn`

If both commands were part of the original failure path, run each once. Do not rerun a command solely to duplicate
successful final evidence.

## Rules

- Prefer removing dead code over suppressing it
- Every suppression must have a clear reason (public API, framework requirement, etc.)
- Suppress only after understanding why the code is unused
- Always commit baseline updates in the same PR as the code changes that caused them
- `stale-suppressions` is set to `error` — orphaned suppression comments will fail checks

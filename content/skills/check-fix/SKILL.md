---
name: check-fix
description: "Detects the project's check scripts, runs them, and fixes what fails. Use when asked to run checks,..."
metadata:
  author: MartinoPolo
  version: '0.6'
  category: code-review
  mpx:
    schemaVersion: 1
    skillPacks: [work]
    defaultExposure: name-only
---

# Check & Fix

Deterministic check execution and fix loop based on the bundled `detect-check-scripts.mjs`.

This skill accepts no arguments. Ignore argument-based filtering and follow detector output only.

## Step 1: Detect Available Checks

Read [content paths](../shared/CONTENT_PATHS.md). Resolve `skills/check-fix/scripts/detect-check-scripts.mjs` beneath
`MPX_ACTIVE_CONTENT_ROOT` as instructed there, validate it, and store its literal absolute path as `<detector>`. Do not
run a caller-checkout `./scripts` path.

```bash
node <detector>
```

Handle all outputs explicitly:

- `NO_PROJECT=true`: report "No package.json found" and stop.
- `PM_UNKNOWN=true`: ask user which package manager to use (`npm`, `pnpm`, `yarn`, `bun`), then re-run:

```bash
node <detector> . <chosen_pm>
```

- `PM=<pm>`: continue with detected scripts.
- `MONOREPO=true`: expect package-prefixed keys too (for example `packages_ui_CHECK_ALL=...`).

Possible script keys per scope (root or prefixed package):

- `<prefix>CHECK_ALL`, `<prefix>CHECK_ALL_DIR`
- `<prefix>TYPECHECK`, `<prefix>TYPECHECK_DIR`
- `<prefix>LINT`, `<prefix>LINT_DIR`
- `<prefix>FORMAT`, `<prefix>FORMAT_DIR`
- `<prefix>BUILD`, `<prefix>BUILD_DIR`
- `<prefix>TEST_UNIT` or `<prefix>TEST`, with the matching `_DIR`
- `<prefix>TEST_E2E`, `<prefix>TEST_E2E_DIR`

If no runnable script keys are present after `PM=...`, report "No scripts detected" and stop.

## Step 2: Build Run Plan (No Arguments)

Per scope, build two tiers from detector output:

- Fast tier: `CHECK_ALL` when present; otherwise detected `TYPECHECK`, `LINT`, and `FORMAT`.
- Full tier: the fast tier, then `BUILD`, `TEST_UNIT` or `TEST`, and `TEST_E2E` when present.

Run exactly what the detector output specifies, regardless of any user arguments. Use fast-tier commands for feedback
while fixing; after all planned fixes, run the full tier once as final verification.

## Step 3: Run Checks

Run fast-tier commands in deterministic order.

- `CHECK_ALL` mode: `CHECK_ALL`
- Individual mode: `TYPECHECK` -> `LINT` -> `FORMAT`

For monorepo keys, run from `*_DIR`:

```bash
cd <DIR> && <COMMAND>
```

Run sequentially. Stop at first failing command, fix it, then continue.

## Step 4: Fix Errors

If a check fails:

1. Parse failing files and diagnostics from command output.
2. Read relevant files and identify root cause.
3. TDD-first when practical:

- If there is a clear behavioral bug and test setup exists, add/update a focused failing test first (red).
- Implement minimal fix (green).
- Refactor only if needed.

4. Re-run the failed command.

Repeat up to **3 iterations** per failed command. If still failing, mark as `Failed` and continue.

## Step 5: Continue and Run Final Verification

Continue through remaining fast-tier commands. Each command has its own 3-iteration fix budget. Then run the full tier
once in this order: `CHECK_ALL` or `TYPECHECK` -> `LINT` -> `FORMAT`, followed by `BUILD` -> `TEST_UNIT` or `TEST` ->
`TEST_E2E`. Stop final verification at the first failure and report it; do not start another fix loop that duplicates
the completed feedback phase.

## Step 6: Report Results

Summarize status for each attempted command/scope:

- `Passed`: passed immediately
- `Fixed`: failed initially, passed after fixes
- `Failed`: still failing after 3 iterations
- `Skipped`: not detected for that scope or superseded by `CHECK_ALL`

Report in execution order. Include scope (`root` or package prefix) and command used.

Recommended table:

```
Scope | Command | Status | Notes
```

## Troubleshooting

| Problem                            | Action                                                             |
| ---------------------------------- | ------------------------------------------------------------------ |
| `NO_PROJECT=true`                  | Run from a folder containing `package.json`                        |
| `PM_UNKNOWN=true`                  | Ask user for package manager and re-run detector with arg 2        |
| `PM=...` but no script keys        | Report "No scripts detected" and stop                              |
| Prefix keys present (`apps_api_*`) | Treat each prefix as its own scope; run with corresponding `*_DIR` |

## Rules

- Fix underlying issues rather than suppressing (`@ts-ignore`, `eslint-disable`)
- Keep tests truthful: assertions must verify real passing behavior
- If a fix needs architectural changes outside check-fix scope, report a blocker
- For monorepos, report failing scopes explicitly

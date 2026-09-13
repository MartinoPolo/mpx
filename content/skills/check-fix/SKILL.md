---
name: check-fix
description:
  "Detects the project's check scripts, runs them, and fixes what fails. Use when asked to run
  checks,..."
metadata:
  author: MartinoPolo
  version: '0.6'
  category: code-review
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: name-only
---

# Check & Fix

Deterministic parent-owned check and repair loop based on the bundled `detect-check-scripts.mjs`.
Follow [Parent-owned Check and CI Repair]({{MPX_SHARED_INSTRUCTIONS}}/REPAIR_ORCHESTRATION.md). This end-user skill
still fixes accepted problems; the report-only specialist does not.

This skill accepts no arguments. Ignore argument-based filtering and follow detector output only.

## Step 1: Detect Available Checks

Resolve [the bundled detector](scripts/detect-check-scripts.mjs) relative to this loaded skill,
validate it, and store its literal absolute path as `<detector>`. Do not run a caller-checkout
`./scripts` path.

```bash
node <detector>
```

Handle all outputs explicitly:

- `NO_PROJECT=true`: report "No package.json found" and stop.
- `PM_UNKNOWN=true`: ask user which package manager to use (`npm`, `pnpm`, `yarn`, `bun`), then
  re-run:

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

Run exactly what the detector output specifies, regardless of any user arguments. Use fast-tier
commands for feedback while fixing; after all planned fixes, run the full tier once as final
verification.

## Step 3: Collect and assess results

Dispatch `mpx-checker` with the fast-tier commands in deterministic order and their exact working
directories:

- `CHECK_ALL` mode: `CHECK_ALL`
- Individual mode: `TYPECHECK` -> `LINT` -> `FORMAT`

Supply its bounded result to `mpx-check-reporter`. Require assessment, evidence, file/line
locations, suggested repairs, blockers, uncertainty, and verification commands. The parent evaluates
the report; neither specialist edits files or chooses which findings to accept.

## Step 4: Repair accepted findings

For each accepted finding, send a bounded precise repair with exact files and failed command to
`mpx-executor`. Use `mpx-tdd-executor` when a behavioral bug and test setup permit a focused
red/green cycle. Fix root causes rather than suppressing diagnostics, and change a test only when it
is demonstrably wrong against intended behavior.

After repairs, re-dispatch `mpx-checker` for the failed command and send the fresh result to
`mpx-check-reporter` for assessment. The parent evaluates it and repeats up to three iterations per
failed command. Mark a remaining failure `Failed` and continue; a repair requiring architectural
work outside this skill is a blocker.

## Step 5: Continue and run final verification

Continue through remaining fast-tier commands under the same parent-owned loop. Then dispatch
`mpx-checker` once with the complete full tier in this order: `CHECK_ALL` or `TYPECHECK` -> `LINT`
-> `FORMAT`, followed by `BUILD` -> `TEST_UNIT` or `TEST` -> `TEST_E2E`. Treat this fresh result as
the final gate. Stop at its first failure and report it; do not start another fix loop that
duplicates the completed feedback phase.

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

---
name: suppression-audit
description: 'Repo-wide audit of code-quality suppressions (eslint-disable, ts-ignore, fallow-ignore) that fixes...'
metadata:
  author: MartinoPolo
  version: '0.5'
  category: code-quality
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: name-only
---

# Suppression Audit

Audit all code quality suppressions and lint config rule changes across the repository. For each
suppression, determine whether a simple fix resolves the underlying issue or the suppression is
genuinely needed. Fix unjustified suppressions, verify checks pass, and create a PR.

## Suppression Types

#### Type: ESLint

- **Pattern:** `eslint-disable` , `eslint-disable-next-line` , `eslint-disable-line`
- **Where:** Source files

#### Type: Fallow

- **Pattern:** `fallow-ignore-next-line` , `fallow-ignore-file`
- **Where:** Source files

#### Type: Svelte

- **Pattern:** `svelte-ignore`
- **Where:** `.svelte` files

#### Type: TypeScript

- **Pattern:** `@ts-ignore` , `@ts-expect-error` , `@ts-nocheck`
- **Where:** `.ts` /`.svelte` files

#### Type: Oxlint

- **Pattern:** `oxlint-disable` , rules set to `"off"`
- **Where:** Source + config

#### Type: Config rules

- **Pattern:** Rules set to `"off"` , `"warn"` , or `0`
- **Where:** `eslint.config.*` , `.oxlintrc.*`

## Process

### Step 1: Detect Check Commands

Read [content paths](../shared/CONTENT_PATHS.md). Resolve the canonical
`skills/check-fix/scripts/detect-check-scripts.mjs` beneath `MPX_ACTIVE_CONTENT_ROOT` as instructed
there, validate it, and store its literal absolute path as `<detector>`. Do not use a
caller-checkout `./scripts` path or search for a fallback. Run `node <detector>` (optionally pass
the project directory and package manager as arguments). It prints `KEY=value` pairs (e.g.
`CHECK_ALL=...`, `TYPECHECK=...`, `LINT=...`, `FORMAT=...`, `BUILD=...`, `TEST_UNIT=...` or
`TEST=...`, `TEST_E2E=...`, plus `_DIR` companions and `MONOREPO=true` when applicable).

For each scope, store:

- **Fast plan:** `CHECK_ALL` when present; otherwise `TYPECHECK`, `LINT`, and `FORMAT`, in that
  order.
- **Full plan:** the fast plan followed by detected `BUILD`, `TEST_UNIT` or `TEST`, and `TEST_E2E`,
  in that order.

### Step 2: Scan for All Suppressions

Read [exploration policy](../shared/EXPLORATION.md),
[sub-agent policy](../shared/SUBAGENT_PROTOCOL.md), and [content paths](../shared/CONTENT_PATHS.md).
Resolve links relative to this loaded skill; for absolute filesystem reads, follow
[Content Paths](../shared/CONTENT_PATHS.md).

Spawn the named `mpx-explorer` agent using its declared very-thorough exploration policy to find
every suppression comment in source files (exclude `node_modules`, `dist`, `.svelte-kit`, lock
files). For each match, have it record:

- File path and line number
- Suppression type and rule name
- Surrounding code context (3 lines before/after)

### Step 3: Scan Config Files

Spawn the named `mpx-explorer` agent using its declared medium-breadth exploration policy to find
and read all lint config files (`eslint.config.*`, `.eslintrc.*`, `.oxlintrc.*`, `oxlint.json`).
Have it, for each:

1. List every rule explicitly set to `"off"`, `"warn"`, or `0`
2. Check git history for recent changes (last 2 weeks):
   `git log --since="2 weeks ago" -p -- <config-file>`
3. Flag any rule that was downgraded (error→warn) or removed recently

### Step 4: Evaluate Each Suppression

For each suppression found in Steps 2-3, classify it:

**REMOVE** — suppression is unjustified, a straightforward fix exists:

- Rule violation is easy to fix (rename, restructure, add type)
- Suppression was added as a shortcut instead of fixing the issue
- The suppressed rule no longer triggers (code changed since suppression was added)

**KEEP** — suppression is justified:

- Framework/library limitation requires it (e.g., Svelte a11y for intentionally non-standard
  interactions)
- Fix would require major refactoring disproportionate to the benefit
- Rule is genuinely wrong for the context (e.g., `no-undef` disabled globally in TypeScript
  projects)
- Test files where the suppressed pattern is the thing being tested

**UPGRADE** — warning should be an error:

- Config recently downgraded a rule from error to warn without clear reason
- Rule removal weakens quality gates

Log the evaluation as a table (printed to the user) and immediately proceed to fixes:

```
| # | File | Type | Rule | Verdict | Reason |
|---|------|------|------|---------|--------|
```

### Step 5: Fix Suppressions

Automatically fix every suppression marked REMOVE or UPGRADE — no confirmation needed.

For each fix:

1. Remove the suppression comment
2. Fix the underlying code issue
3. Run that scope's detected fast plan to get per-fix feedback
4. If the fix breaks something, revert and reclassify as KEEP with explanation

After all individual fixes pass, run every scope's detected full plan once as final verification. Do
not substitute guessed commands or repeat the full plan after each fix.

### Step 6: Create PR

Before provider work, read [provider routing](../shared/PROVIDER_ROUTING.md), load the nearest valid
`mpxconfig.json`, resolve `repository.provider` independently, and read its planned native guide
under `../shared/providers/`. Use only that guide's native commands; never invent an MPX facade
action. Then use `/mpx:commit-push-pr` to commit all changes and create a PR. Include the evaluation
table in the PR body so reviewers can see the reasoning for each decision. If the provider, guide,
authentication, or tooling is unavailable, preserve local evidence and return the exact blocker and
manual step rather than switching providers.

PR title format: `chore: audit and fix code quality suppressions`

## Edge Cases

- **Generated files** (`.svelte-kit/`, `dist/`): skip entirely
- **Test files**: suppressions in test code are more often justified — evaluate with higher bar for
  removal
- **Index/barrel files**: `unused-export` suppressions on re-export files are usually justified
- **Config-level `"off"` rules**: check if the rule conflicts with another tool (e.g., ESLint
  `no-undef` off because TypeScript handles it) — these are usually justified

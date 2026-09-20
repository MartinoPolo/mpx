---
name: suppression-audit
description:
  'Repo-wide audit of code-quality suppressions (eslint-disable, ts-ignore, fallow-ignore) that
  fixes...'
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

Resolve the bundled canonical [check detector]({{MPX_SHARED_INSTRUCTIONS}}/detect-check-scripts.mjs)
from this compiled skill, validate it, and store its literal absolute path as `<detector>`. If it is
unavailable, report the dependency and stop rather than searching or guessing another root. Run
`node <detector>` with the project directory when needed. It prints JSON with this schema:

```json
{"fast_checks":[{"command":"<exact command>","cwd":"<working directory>"}],"full_checks":[{"command":"<exact command>","cwd":"<working directory>"}],"unresolved":[]}
```

Preserve each command and working directory exactly; resolve relative `cwd` values against the
checkout. For resolved main-checkout configuration or machine-local overrides, pass the config
object in a temporary JSON file outside the repository as the detector's third argument after the
checkout and package manager (empty to discover). Explicit project `fast_checks` and
`full_checks` configuration takes precedence over detector output; ask `mpx-checker` to investigate
only entries in `unresolved`. The two arrays are ordered plans: run formatting in `fast_checks` to
completion before any parallel review or deferred check, and include both arrays in final full
verification.

### Step 2: Scan for All Suppressions

Spawn the named `mpx-explorer` agent to find
every suppression comment in source files (exclude `node_modules`, `dist`, `.svelte-kit`, lock
files). For each match, have it record:

- File path and line number
- Suppression type and rule name
- Surrounding code context (3 lines before/after)

### Step 3: Scan Config Files

Spawn the named `mpx-explorer` agent to find
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

Automatically fix every suppression marked REMOVE or UPGRADE — no confirmation needed. Pre-analyze
each accepted fix, then dispatch a fresh `mpx-executor` with relevant requirements, failures,
acceptance criteria, a precise repair objective, and file pointers. Instruct it to inspect the
current `git diff` and relevant files itself.

For each fix:

1. Remove the suppression comment.
2. Fix the underlying code issue.
3. Preserve existing meaningful coverage and add or update tests only when they proportionally
   verify changed behavior, important failure modes, or a known regression.
4. Run that scope's detected `fast_checks` to get per-fix feedback.
5. If the fix breaks something, revert and reclassify it as KEEP with an explanation.

After all individual fixes pass, run every scope's `fast_checks` and `full_checks` once as final
verification. Finish any formatting write before parallel review or deferred checks. Do not
substitute guessed commands or repeat full verification after each fix.

### Step 6: Create PR

Before provider work, read [provider routing]({{MPX_SHARED_INSTRUCTIONS}}/PROVIDER_ROUTING.md), resolve
project configuration as described there, resolve `repository.provider` independently, and read
the selected native guide linked there. Use only that guide's native commands; never invent an MPX facade
action. Then invoke `{{MPX_SKILL_COMMAND}}pr` with the explicit `pr` endpoint to stage and commit the
intended changes, push, create or update a draft PR, and monitor CI. Keep the evaluation table in
the local user report; use the shipper's title/body contract for publication. On hook or CI failure, evaluate
the bounded evidence, dispatch accepted repairs to a fresh executor with the repair inputs above,
verify locally, and invoke the shipper workflow again. Allow three aggregate shipping attempts
total—the initial attempt plus two repair/retry attempts—with no budget reset between delivery
stages. If the provider, guide, authentication, or tooling is unavailable, preserve local evidence
and return the exact blocker and manual step rather than switching providers.

## Edge Cases

- **Generated files** (`.svelte-kit/`, `dist/`): skip entirely
- **Test files**: suppressions in test code are more often justified — evaluate with higher bar for
  removal
- **Index/barrel files**: `unused-export` suppressions on re-export files are usually justified
- **Config-level `"off"` rules**: check if the rule conflicts with another tool (e.g., ESLint
  `no-undef` off because TypeScript handles it) — these are usually justified

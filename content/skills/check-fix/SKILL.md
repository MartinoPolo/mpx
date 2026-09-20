---
name: check-fix
description: "Detects the project's check scripts, runs them, and fixes accepted failures."
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

Main evaluates findings and authorizes repairs; specialists return bounded evidence.

## 1. Discover

Use explicit project `fast_checks` / `full_checks` configuration first, the deterministic
[check detector]({{MPX_SHARED_INSTRUCTIONS}}/detect-check-scripts.mjs) second, and checker
investigation of unresolved discovery last. Resolve the detector relative to this loaded skill and
run `node "<absolute-detector>" "<checkout>"`.

Retain the ordered JSON `fast_checks`, `full_checks`, and `unresolved` result. Pass exact commands
and working directories unchanged; resolve relative `cwd` values against the checkout. For resolved
main-checkout configuration or machine-local overrides, pass the config object in a temporary JSON
file as the detector's third argument after checkout and package manager (empty to discover).
Keep that temporary file outside the repository. `full_checks` is the deferred category; complete verification
runs both arrays. Missing or unresolved checks are not a passing result. Ask for project commands
only when checker investigation cannot resolve discovery.

Fast defaults are formatting, typechecking, unit tests, Oxlint, and project-configured Fallow.
Deferred/full checks are ESLint, build, E2E, and opaque combined checks. These are scheduling
categories, not measured duration guarantees. Fallow stays project-owned; classification does not
imply installing/enabling it globally.

## 2. Check and assess

Dispatch `mpx-checker` with the ordered fast commands, working directories, and resolved absolute
detector path. Formatting writes are allowed and preferred;
finish formatting before parallel reviewers inspect stable source. Include resulting changes in
final verification/review. Avoid unsafe parallel checks sharing mutable fixtures or servers.

Main evaluates checker and reviewer results, distinguishes root causes from symptoms, and resolves contradictory advice before authorizing repairs. Preserve uncertainty and missing evidence rather than guessing.

## 3. Repair

Dispatch a fresh `mpx-executor` for each accepted repair, never a resumed one. Supply relevant
requirements, failures, acceptance criteria, precise repair objective, file pointers, and exact
verification commands. Instruct it to inspect current `git diff` and relevant files itself; do not
paste large diffs/source into the prompt. Fix causes rather than suppressing diagnostics. Update
obsolete tests against agreed acceptance criteria and report material coverage changes.

Recheck affected commands after each repair. Allow at most three repair iterations per failed
command. Report remaining failures; architectural work outside the agreed scope is a blocker.

## 4. Verify and report

Run deferred checks and evaluate failures under the same bounded loop. After accepted repairs,
dispatch the complete ordered fast and full arrays as final verification. Do not reset exhausted
budgets. Report exact command, working directory, actual result, formatting changes, resolved and
unresolved issues, and any unavailable verification. Do not commit or publish from this skill.

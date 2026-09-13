---
description: Verifies UI changes with raw Playwright over a defined scope and reports a per-surface PASS/FAIL table...
disable-model-invocation: true
metadata:
  author: MartinoPolo
  category: testing
  version: "0.5"
name: mp-playwright-test
---

# mp-playwright-test

Run reliable browser verification over a defined scope. This skill owns **scope → surfaces** and
orchestration. Read the canonical compiled-relative `../../../../../../claude/instructions/shared/PLAYWRIGHT_TESTING.md` now — the
reliability rules (sanity-gate, assert-don't-eyeball, programmatic auth, never `networkidle`) live
there and are followed verbatim. Also read `../../../../../../claude/instructions/shared/PROVIDER_ROUTING.md`; after selecting the
repository provider, read its linked native repository guide. Resolve each reference relative to
this loaded skill first. If projection relocation makes that impossible, read
`MPX_ACTIVE_CONTENT_ROOT`, require an absolute path, resolve the referenced projection-relative file
beneath it, and verify the literal result exists and remains contained by that root. Stop if
validation fails; do not search ordered roots or guess an installation checkout. the invocation
input

## Rules

- **Raw Playwright only** — the project's installed `playwright` dep, run as a Node script. Browser
  MCP work belongs to the exploratory `mp-chrome-devtools-tester` agent, not this reliability path.
- **Verify only** — assert and screenshot, leaving source untouched.
- This skill encodes **policy**; the runner command, dev-server port, auth endpoint, and seed users
  come from the project's `AGENTS.md` / memory, not from here.

## Step 1: Resolve scope

Parse `the invocation input`:

- `uncommitted` (or empty) → **working-tree mode**: `git diff --name-only HEAD` (+ untracked).
- `review:<id>` → **PR mode**: resolve the repository provider from `mpxconfig.json`, use its
  canonical native PR command against the explicit repository target in the native authenticated environment, retain the returned source
  revision and changed-file metadata, and stop for clarification when no explicit PR ID is supplied.
  Never invent a cross-provider facade command.
- anything else → **verbal mode**: treat the text as a description of the app area to test.

## Step 2: Map scope → surfaces

- **working-tree / PR mode** — from the changed file list, keep UI-affecting files (routes,
  components, styles, layouts). Resolve each to the route(s) that render it. Drop pure backend/logic
  changes: they have **no visual surface** and are out of scope for this skill.
- **verbal mode** — translate the described area into the concrete route(s) and interactions to
  exercise (run a quick `Explore` if the routes are not obvious).

If mapping yields zero UI surfaces, stop and report that there is nothing to visually verify.

## Step 3: Discover project specifics

Per `../../../../../../claude/instructions/shared/PLAYWRIGHT_TESTING.md` § _Discover project specifics_, read the project's `AGENTS.md`
/ `repository instructions` / memory for: the Playwright runner/helper (e.g. `scripts/shot.mjs`),
the parent-provided server URL, the sign-in API + seed users, and the approved project test-login
credential locations (`.local/`, `.env.local`). Preserve this project-owned credential reading and
never print or publish values. If no runner script exists, the verifier writes a minimal one from
the shared skeleton.

## Step 4: Verify in a sub-agent

Spawn a read-only runtime sub-agent with the standard model class to run the verification. Give it:
the surface list (with the route + what changed for each), the discovered runner/server-URL/auth details,
and the instruction to Read `../../../../../../claude/instructions/shared/PLAYWRIGHT_TESTING.md` and follow it exactly —
**stale-worktree sanity-gate FIRST**, then programmatic auth, explicit waits (never `networkidle`),
one measured assertion per surface, a screenshot per surface under `test-results/`. It verifies
every surface even if one fails, and returns the PASS/FAIL table — it does not fix anything.

The sanity-gate is load-bearing: if the supplied server does not reflect the code under test, the
sub-agent reports every affected surface `BLOCKED` with freshness evidence. Project servers are
started and managed manually in Orca or a project terminal; this skill never kills, starts,
restarts, or replaces one.

## Step 5: Report

Relay the sub-agent's per-surface table: surface, `PASS`/`FAIL`/`BLOCKED`, measured value vs
expected, and the screenshot path. Call out any surface where the sanity-gate had to restart the
server. Failures are reported, not fixed — hand them back to the caller (or to `mpx execute`) to
resolve.

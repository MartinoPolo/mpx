**Active migration authority:** [MPX_MIGRATION.md](MPX_MIGRATION.md).

`HANDOFF.md` is continuity context only. It does not define migration status, decisions, acceptance, or phase completion.

## Checkpoint

- Clean `main` at HEAD `47db12f` (`test(tooling): enforce final unit test layout`).
- Nothing has been pushed.

## Completed

- Quality tooling is merged.
- Stage A unified the strict test harness, build, and typecheck boundaries.
- Stage B established the root contract, integration, and end-to-end categories and their payload categories.
- Stage C moved every owned unit test and fixture to workspace `test/unit` and `test/fixtures` directories.
- Payload and Pi vendor tests remain explicit exceptions.
- A generic final-layout guard is in place.
- Root `test:unit` builds first, and aggregate category commands execute each category once.

## Verification

The final guard passed the focused harness, `pnpm run typecheck`, `pnpm run check:quality`, `pnpm run validate:generated`, and `git diff --check`. The full categories and full test passed immediately before the final guard.

Current convergence and the full aggregate are blocked by external drift. Do not describe the current checkout as fully green.

## External blocker — do not modify automatically

The user-owned `$MPX_PROJECTS/mpx-pi/APPEND_SYSTEM.md` differs from the committed convergence snapshot. Its current hash prefix is `624f55`; the recorded prefix is `42a85e`. This causes `CONVERGENCE_SOURCE_DRIFT: pi:APPEND_SYSTEM.md`.

Do not revert the external file, regenerate the manifest, or rebind evidence without user review. `pnpm run validate:generated` without source verification passes.

## Next session — Stage D

- Replace hard-coded historical move ledgers and former-path declarations in the large harness with compact, generic final-layout, category, workspace, script, typecheck, and public-boundary guards.
- Remove the stale `.fallowrc.json` `**/test-fixtures/**` entry.
- After evidence review, check only the first three structural acceptance boxes in `MPX_MIGRATION.md`.
- Preserve the historical PHASE_J parity snapshot.
- Audit active paths and hashes.
- Defer CLI-internal root integration and end-to-end seams to Stage G.

## Remaining plan

- **Stage E:** Move skill internals behind stable facades.
- **Stage F:** Introduce a neutral `SkillProjectionPlan` with thin runtimes.
- **Stage G:** Introduce a provider-neutral application package and thin CLI.
- **Stage H:** Remove transitional machinery and complete final gates.

## Reliability

- `de2b30e` fixes session-lock `EPERM` handling.
- `73d4101` makes the migration race deterministic.
- Installer simulation occasionally nears its timeout under load. Investigate if it repeats; never increase the timeout blindly.

## Start commands

Run in Bash using `$MPX_PROJECTS`:

```bash
cd "$MPX_PROJECTS/mpx"
git status --short --branch
git log -1 --oneline

git -C "$MPX_PROJECTS/mpx-pi" status --short --branch
git -C "$MPX_PROJECTS/mpx-pi" diff -- APPEND_SYSTEM.md

pnpm run typecheck
pnpm run check:quality
pnpm run validate:generated
git diff --check
```

Run convergence and the full test only after deliberate review and resolution of the external drift:

```bash
pnpm run test:convergence
pnpm test
```

## Temporary branches and worktrees

- `main` contains the accepted work.
- `$MPX_PROJECTS/mpx.worktrees/skills-first-*` worktrees and pi-agent worktrees or refs may remain.
- Do not merge them again. Prune them only after checking for unique intentional work.
- The stopped Stage D branch was squash-integrated as `47db12f`.

## Do not

- Do not push.
- Do not hand-edit hashes.
- Do not refresh the Fallow baseline.
- Do not move payload or vendor tests.
- Do not rewrite historical snapshots.
- Do not edit the external Pi repository without user review.

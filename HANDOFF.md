**Active migration authority:** [MPX_MIGRATION.md](MPX_MIGRATION.md).

`HANDOFF.md` is continuity context only. It does not define migration status, decisions, acceptance, or phase completion.

## Checkpoint

- Stage D structural cleanup is complete and verified.
- Nothing has been pushed.
- Use `git log` and `git status` for the exact commit and integration state.

## Completed

- Stages A–C established the final test categories and moved owned workspace tests and fixtures to `test/unit` and `test/fixtures`.
- Stage D replaced historical move inventories with compact repository-derived structural guarantees.
- Normal `pnpm test` is now self-contained and invokes unit, payload, contract, integration, and E2E exactly once without external convergence.
- Explicit `test:convergence` and `convergence:verify` remain available for Phase J migration review.
- The first three structural acceptance items in `MPX_MIGRATION.md` are evidenced; later architecture and full-gate items remain pending.

## External blocker — do not modify automatically

Active convergence verification remains blocked by the user-owned `$MPX_PROJECTS/mpx-pi/APPEND_SYSTEM.md`, which differs from the immutable convergence snapshot (`624f55` current hash prefix versus recorded `42a85e`). This causes `CONVERGENCE_SOURCE_DRIFT: pi:APPEND_SYSTEM.md`.

Do not revert the external file, regenerate the manifest, rebind evidence, or run external convergence without user review. Explicit convergence remains pending that review.

## Remaining implementation stages

Consult the active migration authority and current `git log`/`git status` before selecting the next work:

- **Stage E:** Move skill internals behind stable facades.
- **Stage F:** Introduce a neutral `SkillProjectionPlan` with thin runtimes.
- **Stage G:** Introduce a provider-neutral application package and thin CLI.
- **Stage H:** Remove transitional machinery and complete final gates.

## Preserved evidence and boundaries

- `docs/history/CONVERGENCE_MANIFEST.json` and historical Phase J reports remain immutable migration evidence.
- Fallow baseline, convergence scripts, provenance, external repositories, payload/vendor locations, and CLI-internal root integration/E2E seams are unchanged.
- Do not push, hand-edit hashes, refresh the Fallow baseline, move payload/vendor tests, rewrite historical snapshots, or edit the external Pi repository without user review.

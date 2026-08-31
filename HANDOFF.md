**Active migration authority:** [MPX_MIGRATION.md](MPX_MIGRATION.md).

`HANDOFF.md` is continuity context only. It does not define migration status, decisions, acceptance, or phase completion.

## Checkpoint

- Stage E is complete and verified.
- Nothing has been pushed.
- Use `git log` and `git status` for the exact commit and integration state.

## Completed

- Stages A–C established the final test categories and moved owned workspace tests and fixtures to `test/unit` and `test/fixtures`.
- Stage D replaced historical move inventories with compact repository-derived structural guarantees.
- Stage E split skill-platform internals behind the unchanged root facade, exposed the narrow side-effect-free `@mpx/skills/contracts` API for config compatibility, and removed skills dependencies on config and runtime adapters.
- Normal `pnpm test` is self-contained and invokes unit, payload, contract, integration, and E2E exactly once without external convergence.
- The first four structural acceptance items in `MPX_MIGRATION.md` are evidenced; later architecture and full-gate items remain pending.

## External blocker — do not modify automatically

Explicit convergence verification remains deferred and external. The user-owned `$MPX_PROJECTS/mpx-pi/APPEND_SYSTEM.md` differs from the immutable convergence snapshot (`624f55` hash prefix versus recorded `42a85e`), which produces `CONVERGENCE_SOURCE_DRIFT: pi:APPEND_SYSTEM.md`.

Do not revert the external file, regenerate the manifest, rebind evidence, or run explicit convergence without user review.

## Next implementation stage

- **Stage F:** Introduce a neutral `SkillProjectionPlan`, then migrate the Claude adapter followed by the Pi adapter while preserving projection behavior.

Later Stages G and H remain pending. Stage F completion does not imply those stages or the full gates are complete.

## Preserved evidence and boundaries

- `docs/history/CONVERGENCE_MANIFEST.json` and historical Phase J reports remain immutable migration evidence.
- Fallow baseline, convergence scripts, provenance, external repositories, payload/vendor locations, and CLI-internal root integration/E2E seams are unchanged.
- Do not push, hand-edit hashes, refresh the Fallow baseline, move payload/vendor tests, rewrite historical snapshots, or edit the external Pi repository without user review.

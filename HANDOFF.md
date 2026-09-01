# Session Handoff

Date: 2026-09-01

**Authority:** `MPX_MIGRATION.md` defines migration scope and acceptance. This file is continuity context only.

## Repository State

- `main` is at `ead99c8` (`refactor(application): extract session operations`).
- `main` is ahead of private `origin/main`; nothing from this continuation was pushed.
- The G4c worktree and temporary branch were removed after their final tree was proven identical to `ead99c8`.
- Only the main worktree and local `main` branch remain.
- Stages through the session-operation extraction are integrated and verified, but Stage G as a whole is not yet complete.
- No `.mpx/` context directory exists.

## Progress This Session

- Finished the interrupted G4c session-operation extraction.
- Added provider-neutral `SessionApplicationService` under `packages/application/src/session-application-service.ts`.
- Added concrete Node composition under `packages/application/src/node/session-application-service.ts`.
- Moved one-time legacy session filesystem/import behavior into `packages/application/src/node/session-legacy-import.ts`.
- Reduced `apps/cli/src/session-command.ts` to argv grammar, usage validation, request mapping, and result forwarding.
- Updated `apps/cli/src/main.ts` to compose the Node service with production store, discovery, branch, resume, identity, and scheduled-authority adapters.
- Regenerated deterministic `bin/mpx.mjs` through the supported bundle script.
- Strengthened root-application architecture tests with TypeScript AST inspection of runtime imports and re-exports.
- Added real-store application tests for reconcile, branch, and resume ordering.
- Added real-filesystem tests for unsafe legacy sources and bounded directory import.

## Final G4c Behavior

- Root `@mpx/application` imports session domain contracts as types only. It has no Node, filesystem, runtime-adapter, provider, Windows, or CLI runtime dependency.
- `createNodeSessionApplicationService` wires `SessionStore`, `SessionService`, lifecycle consumption, resume planning, and confirmation verification.
- `createNodeSessionLegacyImport` owns native-binding lookup, identity mapping, source traversal, safety checks, planning, and confirmed import.
- Session reconcile preserves this compatibility order:
  1. Validate positional and `--capture` grammar.
  2. Application admits immutable scheduled-capture authority.
  3. CLI parses `--map-account` syntax.
  4. CLI parses `--map-pi-root` syntax.
  5. CLI requires an account mapping.
  6. Application plans/imports legacy records.
  7. Application discovers and reconciles runtime sessions.
- Scheduled admission uses a service-bound, one-use `PreparedSessionReconcile` token so callers cannot bypass or replay admission.
- Branch preparation loads and validates the parent and native binding before CLI workspace/intent validation, preserving established error precedence.
- Branch execution uses a service-bound `PreparedSessionBranch` token and derives immutable branch requests from prepared state.
- Resume preserves initial verification → lifecycle consumption → reload/replan → confirmation verification → execution. Initial verification failure consumes nothing.
- CLI envelopes, warnings, grammar, aliases, error messages, and persisted session formats remain stable.

## Verification

- Focused session/application/architecture tests pass.
- `pnpm run typecheck` passes.
- `pnpm run check:quality` passes, including Prettier, Oxlint, and Fallow regression checks.
- `pnpm run validate:generated` passes.
- Full `pnpm test` passes across unit, payload, contract, integration, and E2E categories.
- Repeated `scripts/bundle-cli.mjs` generation produced the same tracked bundle hash.
- `git diff --check` and protected-path review pass.
- Spec-alignment, code-quality, security, error-handling, and test-quality reviews found no remaining G4c blockers.
- One earlier full run hit unrelated transient Windows `EPERM` installer rename and delayed process-tree timing failures. Both passed immediately in narrow reruns and subsequent full runs.

## Completed Migration Checkpoints

- Stages A–D established the final test taxonomy, moved package-owned tests/fixtures, and added repository-derived layout guards.
- Stage E separated skill-platform internals behind stable public APIs.
- Stage F introduced verified neutral skill projection plans and moved runtime policy/model ownership into workspace packages.
- Stage G completed these application cohorts:
  - Provider operations.
  - Project/config and skill operations.
  - Provider capability-role correction.
  - Lifecycle/dev/ports/status/worktree/preparation operations.
  - Launch execution sequencing.
  - Launch preparation, explanation, skill resolution, and resume repository binding.
  - Session list/show/inbox/mark/save/disposition/reconcile/branch/resume operations.

## Key Decisions

- `content/skills` remains canonical; runtimes consume verified neutral plans.
- Root `@mpx/application` remains provider/runtime/Windows/Node-neutral and side-effect-light.
- Concrete process/filesystem/session composition belongs under `@mpx/application/node`.
- CLI retains argv grammar, aliases, TTY/human rendering, envelopes, stdout/stderr, exits, and concrete composition.
- Application owns provider-neutral workflow sequencing, policy admission, prepared-state integrity, and typed results.
- Prepared states are opaque, immutable, service-bound capabilities, not caller-controlled booleans or forgeable plans.
- Legacy session import remains an explicit one-time adapter, never a permanent fallback reader.
- Normal `pnpm test` remains self-contained; explicit convergence is separate and human-reviewed.
- Use pnpm exclusively for package commands.

## Dead Ends & Mistakes

- The first G4c pass changed branch error precedence by validating workspace/intent before loading the parent.
- Reconcile initially ran discovery before legacy import, leaving imported sessions outside the same reconciliation.
- Scheduled authority was initially duplicated between CLI and application, then briefly moved after legacy grammar parsing. The prepared-reconcile capability now preserves both ownership and precedence.
- The first root service runtime-imported Node-backed session implementations. Concrete construction now lives under the Node export.
- Raw `SOURCE=TARGET` parsing briefly leaked into the Node adapter. CLI now translates those flags into structured mappings.
- A precommit fixer incorrectly moved branch option validation before parent preparation. This was reverted because main’s existing error precedence is a compatibility contract.
- Narrow Vitest runs against workspace package imports require relevant packages to be built first; otherwise tests may load stale `dist` output.
- Do not use ancestry or `git cherry` alone to classify squash-integrated branches; compare trees/blobs and current behavior.

## Next Steps

1. Read the Stage G section and current CLI composition before choosing the next operation family.
2. Inventory remaining domain orchestration in `apps/cli/src/main.ts` and command modules. Likely candidates include account, installer, migration, and remaining sandbox composition.
3. Extract one coherent operation family at a time into root-neutral application contracts plus Node composition where required.
4. Preserve exact CLI loading/error precedence, especially optional user config and provider identity/route handling.
5. Run focused tests first, then `pnpm run typecheck`, quality, generated validation, full tests, deterministic bundling, and protected-path review.
6. Complete Stage H final-structure and fail-closed gates only after all Stage G operation families are accepted.
7. Keep F2 live proof and Stage H/I/J live rollout/cutover work behind their explicit human gates.

## External and Live Blockers

- Explicit convergence remains blocked by user-owned external drift, including `$MPX_PROJECTS/mpx-pi/APPEND_SYSTEM.md` (`CONVERGENCE_SOURCE_DRIFT: pi:APPEND_SYSTEM.md`).
- Do not revert external files, regenerate/rebind convergence evidence, or run explicit convergence without user review.
- F2 standalone-sbx live proof requires human-reviewed daemon/auth/live execution.
- Stage H live rollout, Stage I installation, and Stage J observation/cutover/rollback remain pending.

## Critical Files

- `MPX_MIGRATION.md` — authoritative migration plan and acceptance ledger.
- `packages/application/src/session-application-service.ts` — neutral session orchestration and prepared capabilities.
- `packages/application/src/node/session-application-service.ts` — concrete Node session composition.
- `packages/application/src/node/session-legacy-import.ts` — one-time legacy import filesystem adapter.
- `apps/cli/src/session-command.ts` — session argv grammar and request/result mapping.
- `apps/cli/src/main.ts` — concrete application composition root.
- `packages/application/test/unit/session-application-service.test.ts` — reconcile/branch/resume ordering and prepared-state integrity.
- `packages/application/test/unit/node-session-legacy-import.test.ts` — filesystem safety coverage.
- `packages/application/test/unit/architecture.test.ts` — root dependency boundary guard.
- `apps/cli/test/unit/session-command.test.ts` — CLI grammar, precedence, and envelope compatibility.
- `bin/mpx.mjs` — tracked deterministic generated CLI bundle; never hand-edit.
- `docs/history/CONVERGENCE_MANIFEST.json` — protected historical evidence.
- `fallow-baselines/regression.json` — protected regression baseline; never refresh to conceal findings.

## Working Memory

- `MPX_MIGRATION.md` is authority; completion of G4c does not declare all of Stage G complete.
- Preserve optional-config loading behavior: `config show` and `config validate` must not eagerly read malformed optional APPDATA config.
- Routes are required only for capable hosted providers; local and route-neutral providers must remain route-neutral.
- Preserve recorded `plan.repositoryId` during resume instead of substituting newly discovered repository identity.
- Generated path/hash/provenance references must update atomically through supported scripts, never by hand.
- Do not modify external roots, credentials, native auth/session state, installer state, payload/vendor content, convergence snapshots, or Fallow baselines during structural extraction.

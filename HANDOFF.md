# Session Handoff

Date: 2026-09-02

**Authority:** `MPX_MIGRATION.md` defines migration scope and acceptance. This file is continuity context only.

## Outcome

All repository-local migration work that can be completed without live credentials, user-owned external mutations, another operating system, or human observation/approval is complete on `skills-first-finish` at `dff624c`.

- Skills-first Stage G application extraction is complete.
- Stage H structural implementation and acceptance are complete.
- Explicit convergence passes after human review and targeted acceptance of all three external source changes.
- Only live, other-OS, and human-approved gates remain.
- `main` is published to the private origin through the latest committed checkpoint.

## Completed Application Boundary

Root `@mpx/application` now owns provider-neutral sequencing for:

- Providers, projects/configuration, skills, launch preparation/execution, lifecycle, worktrees, development services, ports, status, sessions, accounts, installation protocol, local views/doctor, and Phase-J migration.
- Opaque service-bound prepared launch, session reconcile, branch, and resume states.
- Exact compatibility ordering for provider preflight, optional config loading, launch selection, session reconcile/import, branch parent/native binding, account verification, executor evidence, and resume confirmation.

`@mpx/application/node` now owns concrete composition for:

- Provider process/repository/private-route adapters.
- Account attestation and bounded Pi OAuth probes.
- Session discovery, lifecycle, branch, resume, legacy import, and Docker admission.
- Launch runtime projection/execution, sandbox adapters, proof loading, Claude gateway, and production launch policy composition.
- Provider-local view rebuilding, Windows Terminal/branch adapters, installer protocol input, and Phase-J filesystem/process reconciliation.

The CLI now retains argv grammar, usage validation, aliases, IO/rendering, envelopes, exits, command registration, TTY interaction, and structural composition.

## Final Structural Enforcement

Stage H added fail-closed repository gates for:

- Public cross-workspace imports and declared package exports.
- Forbidden relative/absolute/deep workspace imports.
- Tests, specs, and fixtures under workspace `src`.
- Final-only `.test`/`.spec` discovery and production TypeScript exclusions.
- Removal of transitional root-unit discovery.
- Deterministic, non-mutating source-to-bundle checks for `bin/mpx.mjs` and `bin/claude-gateway.js`.
- Mandatory exact Phase-J owned-activation inventory before cutover planning.
- Node-only application exports and root application neutrality.

The generated Claude gateway is now a deterministic adjacent companion executable rather than an implicit missing bundled path.

## Verification

The final repository-local gate passed at `dff624c`:

- `pnpm run check`
- `pnpm run typecheck`
- `pnpm test`
- `git diff --check`

Full test categories passed:

- Unit
- Payload
- Contract
- Integration
- E2E

Additional evidence throughout the extraction included focused application/CLI suites, quality and Fallow regression checks, generated validation, structure validation, deterministic repeated dual-bundle generation, and architecture/spec/security/error-handling/test-quality reviews.

Explicit convergence now passes across both external source roots. Human-reviewed drift was accepted individually for `pi:APPEND_SYSTEM.md`, `claude:plugins/mp/statusline-projects.json`, and `claude:settings.json`; no unrelated entry was accepted implicitly.

## Integrated Commits on This Branch

- `a4f98af refactor(application): extract account orchestration`
- `a886cc3 refactor(application): extract session resume launch workflow`
- `cd37f10 refactor(application): move sandbox adapters to node`
- `5adc611 refactor(application): extract view and doctor workflows`
- `6b6049f refactor(application): extract install protocol service`
- `6a14365 refactor(application): extract phase-j migration service`
- `bf2db4c refactor(application): move provider adapters to node`
- `cb871b5 refactor(application): move session adapters to node`
- `fb7ec03 refactor(application): move launch adapters to node`
- `7b37f5c refactor(application): compose session resume in node`
- `33aa28e refactor(application): compose session branch in node`
- `79feedd refactor(application): compose launch workflow in node`
- `4767c7d refactor(application): extract ports workflow`
- `b7a9f0f chore(test): enforce final repository structure`
- `dff624c docs(portability): document verification boundaries`
- `40e08ca chore(convergence): accept reviewed Pi prompt drift`

## Remaining HITL and Live Gates

### F2 live proof

- Retain a launch-bound V2 plan/report for pinned standalone `sbx` v0.39.0.
- Observe mounts, version, ports, real traffic, containment limits, cleanup, and zero remaining sandboxes.
- Verify live Claude sandbox and host-Pi OAuth routes without credentials entering the sandbox.

### Real targets and interactive observation

- Run every named real project/template target.
- Observe Windows Terminal profile, start-directory, and alias behavior interactively.
- Verify Linux on Linux and macOS on macOS using `docs/PORTABILITY.md`.

### Installation and account routes

- Review/install user-local configuration.
- Apply and verify the immutable live installation.
- Verify Claude/Pi registration and personal/work Claude/Pi routes.
- Verify the installed scheduled reconcile task.
- Evidence real Git author/SSH, Obsidian, Raycast, provider, and native session-resume routes.

### Observation, cutover, and rollback

- Complete the required observation window.
- Pass the zero-legacy activation/config audit.
- Obtain explicit user approval and perform cutover.
- Prove live rollback.
- Retire legacy activation/repositories/migration-only state only after all prior gates pass.

## Critical Files

- `MPX_MIGRATION.md` — authoritative acceptance ledger.
- `packages/application/src/` — provider-neutral application operations.
- `packages/application/src/node/` — concrete Node/runtime/provider/Windows composition.
- `packages/application/test/unit/architecture.test.ts` — application and CLI boundary gates.
- `scripts/validate-structure.mjs` — public workspace/layout enforcement.
- `scripts/bundle-cli.mjs` — deterministic explicit bundle generation and non-mutating check mode.
- `scripts/validate-generated.mjs` — generated/provenance/bundle validation.
- `docs/PORTABILITY.md` — Linux/macOS evidence requirements without support claims.
- `docs/history/CONVERGENCE_MANIFEST.json` — protected immutable historical evidence.
- `fallow-baselines/regression.json` — protected baseline; never refresh to conceal findings.

## Safety Notes

- Use pnpm exclusively for repository package commands.
- Do not run explicit convergence until external drift is reviewed.
- Do not mutate credentials, native account roots, installer state, scheduled tasks, Terminal settings, provider remotes, or legacy activation without explicit human approval.
- Do not hand-edit generated bundles, convergence evidence, or Fallow baselines.
- Treat transient Windows `EPERM`/`EBUSY` failures as resource ownership problems; do not mask them with larger timeouts.

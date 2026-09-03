# MPX migration authority

**Status:** Cleanup-first execution is active. Recovery, authority, and safe-cleanup Gates 0–2 are complete. No later gate is accepted unless its checkbox and evidence are updated here.

**Authority:** This file is the sole active migration plan. Git history is the archive. User instructions override this file; this file overrides superseded phase documents and generated reports.

## Execution rules

- Preserve native `pi`, `piw`, `cc`, `ccd`, `ccw`, and `ccwd` launch paths.
- Use `pnpm` exclusively for package commands.
- Run `pnpm run typecheck` before every commit.
- Run narrow tests before integration and the full required checks before pushing a gate.
- Push only verified coherent gate checkpoints to `origin/main`; never force-push or amend published commits.
- Start feature work from clean `main` with no auxiliary worktrees and return to that state at every gate.
- Use isolated worktrees only for disjoint scopes with an explicit ownership map. Remove each integrated worktree and branch immediately.
- Only the orchestrator edits this file or generated artifacts.
- Every replacement removes the obsolete code, tests, documentation, and generated references it supersedes.
- Preserve unrelated user changes and stop at a persisted clean checkpoint if context becomes unsafe.

## Fixed decisions

- MPX is a private-first, skills-first TypeScript monorepo with one CLI and provider-neutral contracts.
- `mpxconfig.json` is the only committed project integration manifest. Credentials, identities, launch defaults, and machine state remain user-local.
- Canonical skills live under `content/skills`; public runtime identity is `/mpx:<skill>`.
- Native account roots remain authoritative. MPX must not copy secrets or shadow native launcher names.
- Docker Sandboxes through standalone `sbx` is the target whole-agent executor. Host execution is explicit compatibility, never sandbox isolation or silent fallback.
- Initial sandbox work uses a private clone. Linked host worktrees are not mounted with repository-wide Git administration state.
- The selected network baseline is `open`/global `allow-all`; it is not an egress-isolation boundary.
- Local Markdown issues do not depend on Obsidian and remain supported.
- The installer never inspects or edits Windows Terminal settings. Explicit `project-register` automation may manage a project profile when invoked by the user.
- No Task Scheduler runtime machinery remains; any future scheduled capture requires a separately designed and confirmed feature.
- `agent-resurrect` remains the standalone daily session UI. MPX owns a small compatibility protocol rather than duplicating its tab-management interface.
- Ports and host worktrees remain first-class MPX capabilities.
- Keep GitHub, GitLab, KanbanFlow, local Markdown, and a minimal Gerrit adapter. Do not build a generalized Gerrit platform.
- Raycast and Obsidian installer integration are not core installation requirements.

## Current implementation inventory

| Area                | Repository state                                                                                                                       | Decision                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Config and launch   | Identity, mode, preset, grants, skill exposure, immutable descriptors, host approval, runtime argv, and fail-closed resolution exist   | Keep and simplify around accepted routes                   |
| Skills and runtimes | Canonical content, projection plans, generated Claude/Pi artifacts, model mapping, footer/status foundations, and runtime guards exist | Keep; complete curated parity                              |
| Local issues        | Local Markdown provider and view generation exist                                                                                      | Keep without Obsidian dependency                           |
| Ports               | Allocation, locking, leases, conflict inspection, release, reconciliation, and `.worktree-ports.json` exist                            | Keep                                                       |
| Worktrees           | Host create/remove/prepare/trust and CLI behavior exist                                                                                | Keep; defer linked-worktree sandbox integration            |
| Sessions            | Lifecycle, discovery, registry, resume planning, reconciliation, and legacy import exist                                               | Retain only what resurrection requires                     |
| Providers           | GitHub, GitLab, KanbanFlow, and local adapters exist                                                                                   | Keep; add minimal Gerrit and live verification             |
| Installer           | Immutable release, plan/apply/verify/uninstall, rollback, native launcher registration, and Windows resource adapters exist            | Keep base installer; narrow ownership                      |
| Windows Terminal    | Safe `wt.exe` tab launching and explicit profile scripts exist                                                                         | Keep outside installer ownership                           |
| Sandbox             | Standalone-sbx contracts, proof machinery, split host-Pi bridge, fake workers, and clone planning exist                                | Replace only after feasibility spike                       |
| Raycast             | Runtime skill, export/audit, and installer integration removed                                                                         | Deferred product integration has no active implementation  |
| Obsidian installer  | Installer planning removed; optional manual registration reference remains                                                             | Keep outside installer; local Markdown remains independent |
| Task Scheduler      | Scheduled-capture authority, adapter, receipts, and Windows machinery removed                                                          | Any future feature starts from a new explicit design       |

## Retained scope

- Local Markdown issue operations.
- Port allocation and reconciliation.
- Host worktree lifecycle and preparation.
- Project registration and explicit Windows Terminal project profiles.
- Safe `wt.exe` tab launching.
- Shared skill, agent, prompt, runtime, status, and provider contracts.
- Session data and resume behavior required by `agent-resurrect` compatibility.
- Current explicit host Pi compatibility bridge until whole-agent sandbox replacement passes.
- Native launcher continuity and immutable installed MPX launchers.

## Deferred scope

- Any future Raycast deployment and audit integration.
- Broad Obsidian vault automation beyond the retained optional manual registration reference.
- Any future background scheduled capture feature.
- Sandbox access to linked host worktrees.
- Sandbox port forwarding for initial acceptance.
- Linux and macOS acceptance suites.
- React Native template changes.
- Generalized Gerrit features beyond the named workflows.

## Deletion ledger

| Item                                                    | Removal condition                                                            | State                              |
| ------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------- |
| Raycast runtime and installer integration               | Dependency audit identifies all consumers                                    | Removed in `c27d181`               |
| Obsidian installer orchestration                        | Local Markdown remains independent; optional registration reference reviewed | Removed in `c27d181`               |
| Task Scheduler activation paths and dedicated machinery | Session ownership audit confirms no resurrection dependency                  | Removed in `c27d181`               |
| Linux/macOS acceptance plans                            | Windows-only migration target is documented                                  | Removed in `c27d181`               |
| Installer-owned Windows Terminal assumptions            | Generic explicit profile automation remains available                        | Removed; regression tests retained |
| Superseded phase documents and duplicate reports        | Durable contracts are linked from current docs                               | Removed in `c27d181`               |
| Abandoned generated/provenance inputs                   | Validators and bundle consumers are migrated or removed                      | Removed in `c27d181`               |
| Conflicting project-registration branches               | Current explicit-profile policy is preserved                                 | None found; current path retained  |
| Old split Pi bridge/worker and fake-worker tests        | Whole-agent sandbox Pi passes model/tool/resume acceptance                   | Gate 8 blocked on replacement      |
| Superseded F2 proof machinery                           | Whole-agent sandbox evidence replaces it                                     | Gate 8 blocked on replacement      |
| Old repository imports and legacy activation state      | Route acceptance and rollback pass                                           | Gate 8 blocked on acceptance       |

## Curated parity inventory

| Capability                            | Personal Pi                 | Work Claude          | Work Pi                     | Personal Claude          |
| ------------------------------------- | --------------------------- | -------------------- | --------------------------- | ------------------------ |
| Native fallback                       | Present                     | Present              | Present                     | Present                  |
| Installed MPX route                   | Host compatibility accepted | Host route accepted  | Host compatibility accepted | Installed; OAuth expired |
| Model response                        | Passed historically         | Passed historically  | Passed historically         | Blocked by OAuth renewal |
| Model-triggered file read             | Passed historically         | Passed historically  | Passed historically         | Blocked by OAuth renewal |
| Expected UI/footer/settings/shortcuts | Revalidation pending        | Revalidation pending | Revalidation pending        | Revalidation pending     |
| Common skill invocation               | Pending                     | Pending              | Pending                     | Pending                  |
| Shell/Git tool and identity route     | Pending                     | Pending              | Pending                     | Pending                  |
| Session resurrection                  | Pending                     | Pending              | Pending                     | Pending                  |
| Whole-agent sandbox containment       | Pending                     | Pending              | Pending                     | Pending                  |

Route acceptance order is Personal Pi, Work Claude, Work Pi, then Personal Claude. Each route must prove UI/footer, settings and shortcuts, common skill invocation, model response, file tool, shell/Git tool, correct account, session resurrection, native fallback, and sandbox containment where applicable.

## Session-resurrection contract

`agent-resurrect` remains the standalone UI and must consume stable MPX JSON that identifies:

- runtime and native session ID;
- personal/work identity;
- host or sandbox executor;
- host-owned session reference;
- launcher and bounded resume argv;
- sandbox name/workspace and translated sandbox session path when applicable;
- process/activity evidence and resumability state.

MPX must:

- expose host MPX Claude/Pi sessions even when Pi starts with `--no-extensions`;
- mirror compatible active-session metadata when safe;
- select `pi-mpx`, `piw-mpx`, `cc-mpx`, or `ccw-mpx` for MPX sessions;
- keep sandbox session files in a dedicated host-owned MPX directory;
- translate host references to sandbox paths during resume;
- preserve native Pi and Claude discovery unchanged.

Acceptance requires native Pi and Claude save/resurrect, host MPX Pi and Claude save/resurrect, sandbox MPX Pi and Claude save/resurrect, and mixed native/MPX Windows Terminal groups. One narrowly scoped change in `${MPX_PROJECTS}/agent-resurrect` is allowed.

## Milestones

- [x] **Gate 0 — recovery baseline:** recovery patch and untracked copies saved; all dirty files inventoried; four disjoint read-only reviews completed; retained baseline committed; full tests, typecheck, repository check, generated validation, and diff check passed; clean `main` remained the sole worktree.
- [x] **Gate 1 — migration authority:** this concise tracker replaces obsolete migration prose and is the sole active status authority.
- [x] **Gate 2 — safe cleanup:** Raycast and Obsidian installer paths, scheduled-capture machinery, obsolete migration tools/reports/provenance, and deferred portability plans removed; retained bundles regenerated; reviews resolved; full tests, typecheck, check, convergence verification, generated validation, and diff check pass; clean `main` is the sole branch and worktree.
- [ ] **Gate 3 — sandbox feasibility:** real Linux `sbx shell` runs packaged Pi with interactive TTY, ephemeral personal credential profile, model response, model-triggered file operation, persisted/resumed session, inspected mounts, and verified destruction. Evaluate Docker only if Pi fails.
- [ ] **Gate 4 — curated parity:** content, Pi, Claude, and session protocol work integrated from disjoint ownership and accepted on host routes.
- [ ] **Gate 5 — whole-agent sandbox:** selected identity, private workspace, sessions, exact mounts, no opposite identity, no host fallback, export/apply-back, and cleanup are proven.
- [ ] **Gate 6 — route acceptance:** all four routes pass in the fixed order with native fallback and resurrection.
- [ ] **Gate 7 — providers and utilities:** KanbanFlow live tests, minimal Gerrit, GitHub/GitLab, host worktrees, ports, and Terminal project registration pass.
- [ ] **Gate 8 — final cleanup:** old bridge/workers/proofs/imports/inventories removed; all checks and rollback pass; clean `main` is the only branch and worktree.

## Installed and repository evidence

- Recovery archive: `${MPX_PROJECTS}/mpx-recovery/2026-09-03-gate0-897918f`; original patch SHA-256 `a7780cc07fa68b39275c75862911a0d29d0ec6d17ef2535704bef55da9a3e528`.
- Recovery implementation baseline: `1734b08`.
- Recovery documentation checkpoint: `3f719e0`, pushed to `origin/main`.
- Concise authority checkpoint: `6e49364`, pushed to `origin/main`.
- Safe-cleanup implementation: `c27d181`.
- Gate 2 verification: `pnpm test`, `pnpm run typecheck`, `pnpm run check`, `pnpm run convergence:verify`, `pnpm run validate:generated`, and `git diff --check` passed on Windows. A timing-sensitive worktree lock test failed once under parallel load, then passed narrowly and in the final full run.
- Immutable MPX installation was previously applied and strictly verified without shadowing native commands.
- Installed work Claude passed a model response and model-triggered read.
- Installed personal and work Pi host-compatibility routes passed model responses and model-triggered reads.
- Personal Claude native and MPX routes reported expired OAuth and require interactive renewal before acceptance.
- No repository evidence yet accepts whole-agent sandbox execution or complete session resurrection.

## Active blockers

1. The real whole-agent `sbx` feasibility spike has not run.
2. Personal Claude OAuth requires interactive renewal before that route can pass.
3. `agent-resurrect` does not yet consume the MPX compatibility protocol.
4. Whole-agent Pi sandbox, session-path translation, and apply-back are not implemented or accepted.
5. Live provider credentials and Gerrit implementation remain pending.
6. Real Git author/SSH routing, complete route parity, rollback, and zero-legacy audit remain pending.

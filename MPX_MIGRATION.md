# MPX migration authority

**Status:** Cleanup-first execution is active. Recovery, authority, cleanup, and sandbox-feasibility Gates 0–3 are complete. No later gate is accepted unless its checkbox and evidence are updated here.

**Authority:** This file is the sole active migration status and evidence authority. User instructions override it; it overrides superseded phase documents and generated reports. The temporary [migration execution guide](MPX_MIGRATION_EXECUTION.md) preserves the recovered gate rationale, detailed acceptance instructions, and autonomous handoff until Gate 8 deletes it.

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

| Area                | Repository state                                                                                                                           | Decision                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Config and launch   | Identity, mode, preset, grants, skill exposure, immutable descriptors, host approval, runtime argv, and fail-closed resolution exist       | Keep and simplify around accepted routes                    |
| Skills and runtimes | Canonical content, projection plans, generated Claude/Pi artifacts, model mapping, footer/status foundations, and runtime guards exist     | Keep; complete curated parity                               |
| Local issues        | Local Markdown provider and view generation exist                                                                                          | Keep without Obsidian dependency                            |
| Ports               | Allocation, locking, leases, conflict inspection, release, reconciliation, and `.worktree-ports.json` exist                                | Keep                                                        |
| Worktrees           | Host create/remove/prepare/trust and CLI behavior exist                                                                                    | Keep; defer linked-worktree sandbox integration             |
| Sessions            | Lifecycle/discovery/resume plus a strict resurrection export and one-step approved resume route exist; agent-resurrect v3 consumes it      | Live mixed-group acceptance remains                         |
| Providers           | GitHub, GitLab, KanbanFlow, and local adapters exist                                                                                       | Keep; add minimal Gerrit and live verification              |
| Installer           | Immutable release, ownership-safe upgrade, plan/apply/verify/uninstall, rollback, native launcher registration, and Windows adapters exist | Keep base installer; narrow ownership                       |
| Windows Terminal    | Safe `wt.exe` tab launching and explicit profile scripts exist                                                                             | Keep outside installer ownership                            |
| Sandbox             | Real standalone-sbx Pi feasibility passed; legacy proof/bridge machinery remains and whole-agent containment is not accepted               | Replace after host parity; block Docker socket and VM OAuth |
| Raycast             | Runtime skill, export/audit, and installer integration removed                                                                             | Deferred product integration has no active implementation   |
| Obsidian installer  | Installer planning removed; optional manual registration reference remains                                                                 | Keep outside installer; local Markdown remains independent  |
| Task Scheduler      | Scheduled-capture authority, adapter, receipts, and Windows machinery removed                                                              | Any future feature starts from a new explicit design        |

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
- [x] **Gate 3 — sandbox feasibility:** pinned standalone `sbx` created a Linux shell; packaged Pi ran under a pseudo-TTY, authenticated from an ephemeral personal profile, returned a model response, performed a model-triggered write, persisted and resumed one session from conversation context, exposed its effective mounts, and was destroyed with zero remaining sandboxes.
- [ ] **Gate 4 — curated parity:** content audit is complete; Pi invocation now consumes its immutable profile; Claude projects a forced canonical output style with valid plugin settings; MPX produces strict resurrection exports; agent-resurrect consumes them. An ownership-safe immutable upgrade installed and strictly verified the integrated runtime checkpoint, but Pi registry timestamp compatibility now blocks reconciliation and mixed native/MPX host-route acceptance remains pending.
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
- Gate 3 live spike: standalone `sbx` v0.39.0 build `def8cb0523a77e757bdd6ef52b459fe374f3783e` matched the pinned SHA-256; daemon, authentication, virtualization, storage, and global `allow-all` policy checks passed.
- Gate 3 Pi evidence: `@earendil-works/pi-coding-agent` `0.84.3` installed in the Linux VM; `gpt-5.6-sol` returned `GATE3_MODEL_OK`, used the `write` tool to create the exact marker, and resumed the persisted session without tools to return the prior marker from context.
- Gate 3 TTY and cleanup evidence: Pi ran on `pts/0`; the process was terminated after its TUI handled the timeout interrupt; `sbx delete -f mpx-pi-gate3` succeeded; final `sbx ls --json` returned an empty inventory; all host spike files, including the temporary credential copy, were deleted.
- Effective mount observation: only the isolated spike workspace was intentionally mounted read/write and no native `.pi` or `.claude` directory was mounted, but the `shell-docker` template exposed `/var/run/docker.sock`. A Git-Bash path-conversion mistake also redirected one temporary credential copy beneath the isolated spike workspace before cleanup. Future `sbx` commands carrying Linux absolute paths must set `MSYS_NO_PATHCONV=1`, and Gate 5 must reject Docker-socket and credential-visible mounts.
- Gate 4 implementation checkpoint: MPX commits `e147f12`, `ca7480c`, and `376a0da` add resurrection export/approval, Pi profile-bound argv, and Claude forced output-style projection. Focused tests and typechecks passed in isolated worktrees.
- agent-resurrect commit `f4ee889`, pushed to its `origin/main`, adds strict MPX export scanning, schema v3 saves, collision-safe mixed groups, and exact argv reopening; its full test suite and typecheck pass.
- Installer upgrade checkpoint: the prior installation was strictly healthy at release `7af4f49646c46c1c4ee62de643e60a22d818b77d254a7aa167f4c279ee1d75ee`; receipt-bound upgrade plan `10efdcd754596769e053b7c5cd2cfe8795050f259f8fff97ed9c321b17fbc2bc` applied release `5aee3b3e0fd73717b388ce198913905a89bad1d1854164ba0301963a64419b69`; the installed selector changed to that exact key; strict installed verification reports all system and four runtime-registration components healthy. Native and `-mpx` shell functions remain distinct.
- Installed `session resurrect-export` returns the strict empty v1 DTO, but `session reconcile` fails on maintained native Pi records whose PowerShell round-trip `processStartedAt` uses seven fractional digits while the MPX parser incorrectly permits only JavaScript's three-digit form. The parser must normalize the known producer format without weakening PID/start-fingerprint matching; known legacy v1 files must not poison v2 discovery.
- No repository evidence yet accepts whole-agent sandbox containment or complete session resurrection.

## Active blockers

1. The available `shell-docker` sandbox template exposes `/var/run/docker.sock`; whole-agent acceptance requires a template or policy with no Docker socket.
2. Real Pi OAuth inside the VM proved feasibility but is not acceptable architecture; Gate 5 must keep credentials outside model-visible sandbox authority.
3. The integrated Gate 4 runtime checkpoint was installed and strictly verified, but native Pi registry timestamp compatibility blocks `session reconcile`; mixed native/MPX save and reopen acceptance has not run.
4. Personal Claude OAuth requires interactive renewal before that route can pass.
5. Whole-agent Pi sandbox, session-path translation, and apply-back are not implemented or accepted.
6. Live provider credentials and Gerrit implementation remain pending.
7. Real Git author/SSH routing, complete route parity, rollback, and zero-legacy audit remain pending.

## Next-session handoff

Start from clean `main` after reading this file completely. Gate 4 implementation is integrated; do not redesign it or begin Gate 5 yet.

1. Fix native Pi registry discovery to normalize the known seven-digit PowerShell process-start timestamp to the Windows inspector's millisecond fingerprint and safely ignore known legacy v1 entries; keep malformed/unknown v2 input fail-closed.
2. Regenerate and upgrade the installed release through the now-proven ownership-safe immutable flow, then confirm `mpx --json session resurrect-export` emits the strict privacy-safe v1 DTO after `session reconcile`, including active host MPX records and no native session paths.
3. Configure/verify agent-resurrect's MPX executable route, then test native Pi, native Claude, host MPX Pi, host MPX Claude, and one mixed Windows Terminal save/reopen group. Native launch behavior must remain unchanged.
4. Revalidate Pi footer/profile/keybindings/common skill behavior and Claude hooks/forced `mpx-terse` style/main native status line on personal and work host routes. Personal Claude OAuth may remain the explicit blocker.
5. Resolve findings, run `pnpm test`, `pnpm run typecheck`, `pnpm run check`, `pnpm run convergence:verify`, `pnpm run validate:generated`, and `git diff --check`, then update and close Gate 4 only if live host acceptance passes.

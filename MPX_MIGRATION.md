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
- Canonical runtime-neutral skills and agents live under `content`; public skill identity is `/mpx:<skill>`. Only shared runtime-neutral content and launch data are generated or projected.
- The Gate 4 target makes `runtimes/pi/extensions` the canonical home for Pi-specific extension source shared by native host Pi and sandbox Pi. The former `mpx-pi` repository is deprecated after source and behavior migration.
- The Gate 4 target restores native Pi extension discovery, trusted project extensions, and `/reload`. MPX will not generate alternative implementations of Pi-native tools, hooks, commands, footer, editor, widgets, or lifecycle behavior.
- Native account roots remain authoritative and MPX does not shadow native launcher names. Releases and public state never contain credentials, while a selected sandbox identity may access its own credentials and services.
- Convenience and native runtime compatibility are design requirements. Integrity machinery must not duplicate stable native behavior or prevent user-owned extensions without protecting a retained trust boundary.
- Docker Sandboxes through standalone `sbx` is the target whole-agent executor. Pi and its extensions run inside it; host execution is explicit compatibility, never sandbox isolation or silent fallback.
- Initial sandbox work uses a host-owned standalone private clone mounted as `/workspace`. The original checkout and linked-worktree Git administration state are not mounted, and changes return only through explicit apply-back.
- The selected network baseline is `open`/global `allow-all`; it is not an egress-isolation boundary.
- The sandbox protects the opposite identity, original checkout, unrelated host paths and processes, and the host Docker socket. Trusted selected-identity extensions share the selected identity's authority.
- Local Markdown issues do not depend on Obsidian and remain supported.
- The installer never inspects or edits Windows Terminal settings. Explicit `project-register` automation may manage a project profile when invoked by the user.
- No Task Scheduler runtime machinery remains; any future scheduled capture requires a separately designed and confirmed feature.
- `agent-resurrect` remains the standalone daily session UI. MPX owns a small compatibility protocol rather than duplicating its tab-management interface.
- Ports and host worktrees remain first-class MPX capabilities.
- Keep GitHub, GitLab, KanbanFlow, local Markdown, and a minimal Gerrit adapter. Do not build a generalized Gerrit platform.
- Raycast and Obsidian installer integration are not core installation requirements.

## Current implementation inventory

| Area                | Repository state                                                                                                                                                         | Decision                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Config and launch   | Identity, mode, preset, grants, skill exposure, immutable descriptors, host approval, runtime argv, and fail-closed resolution exist                                     | Keep and simplify around accepted routes                                                                                    |
| Skills and runtimes | Canonical shared content and a generated Pi adapter exist; the complete Pi-native extension source still lives in `mpx-pi` and the in-progress footer port duplicates it | Move retained Pi-specific source into `runtimes/pi/extensions`; generate only shared skills, agents, and launch data        |
| Local issues        | Local Markdown provider and view generation exist                                                                                                                        | Keep without Obsidian dependency                                                                                            |
| Ports               | Allocation, locking, leases, conflict inspection, release, reconciliation, and `.worktree-ports.json` exist                                                              | Keep                                                                                                                        |
| Worktrees           | Host create/remove/prepare/trust and CLI behavior exist                                                                                                                  | Keep; defer linked-worktree sandbox integration                                                                             |
| Sessions            | Lifecycle/discovery/resume plus a strict resurrection export and one-step approved resume route exist; agent-resurrect v3 consumes it                                    | Live mixed-group acceptance remains                                                                                         |
| Providers           | GitHub, GitLab, KanbanFlow, and local adapters exist                                                                                                                     | Keep; add minimal Gerrit and live verification                                                                              |
| Installer           | Immutable release, ownership-safe upgrade, plan/apply/verify/uninstall, rollback, native launcher registration, and Windows adapters exist                               | Keep base installer; narrow ownership                                                                                       |
| Windows Terminal    | Safe `wt.exe` tab launching and explicit profile scripts exist                                                                                                           | Keep outside installer ownership                                                                                            |
| Sandbox             | Real standalone-sbx Pi feasibility passed; production still uses legacy host-Pi remote-tool machinery and whole-agent containment is not accepted                        | Replace with whole-agent Pi using the same native extensions; block Docker socket, original checkout, and opposite identity |
| Raycast             | Runtime skill, export/audit, and installer integration removed                                                                                                           | Deferred product integration has no active implementation                                                                   |
| Obsidian installer  | Installer planning removed; optional manual registration reference remains                                                                                               | Keep outside installer; local Markdown remains independent                                                                  |
| Task Scheduler      | Scheduled-capture authority, adapter, receipts, and Windows machinery removed                                                                                            | Any future feature starts from a new explicit design                                                                        |

## Retained scope

- Local Markdown issue operations.
- Port allocation and reconciliation.
- Host worktree lifecycle and preparation.
- Project registration and explicit Windows Terminal project profiles.
- Safe `wt.exe` tab launching.
- Shared skill, agent, prompt, runtime, status, and provider contracts.
- Gate 4 canonical checked-in Pi extension source for native host Pi, reused by sandbox Pi at Gate 5.
- Gate 4/5 restoration of native Pi extension discovery, trusted project extensions, and `/reload`.
- Session data and resume behavior required by `agent-resurrect` compatibility.
- Current explicit host Pi compatibility route only until whole-agent sandbox replacement passes.
- Native launcher continuity and immutable installed MPX launchers.

## Deferred scope

- Any future Raycast deployment and audit integration.
- Broad Obsidian vault automation beyond the retained optional manual registration reference.
- Any future background scheduled capture feature.
- Sandbox access to linked host worktrees.
- Linux and macOS acceptance suites.
- React Native template changes.
- Generalized Gerrit features beyond the named workflows.

## Deletion ledger

| Item                                                                 | Removal condition                                                              | State                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------- |
| Raycast runtime and installer integration                            | Dependency audit identifies all consumers                                      | Removed in `c27d181`               |
| Obsidian installer orchestration                                     | Local Markdown remains independent; optional registration reference reviewed   | Removed in `c27d181`               |
| Task Scheduler activation paths and dedicated machinery              | Session ownership audit confirms no resurrection dependency                    | Removed in `c27d181`               |
| Linux/macOS acceptance plans                                         | Windows-only migration target is documented                                    | Removed in `c27d181`               |
| Installer-owned Windows Terminal assumptions                         | Generic explicit profile automation remains available                          | Removed; regression tests retained |
| Superseded phase documents and duplicate reports                     | Durable contracts are linked from current docs                                 | Removed in `c27d181`               |
| Abandoned generated/provenance inputs                                | Validators and bundle consumers are migrated or removed                        | Removed in `c27d181`               |
| Conflicting project-registration branches                            | Current explicit-profile policy is preserved                                   | None found; current path retained  |
| Old split Pi bridge/worker and fake-worker tests                     | Whole-agent sandbox Pi and native extensions pass model/tool/resume acceptance | Gate 8 blocked on replacement      |
| Generated Pi footer, tools, UI, and duplicate vendor trees           | Canonical `runtimes/pi/extensions` source passes host and sandbox parity       | Gate 8 blocked on replacement      |
| Superseded F2 proxy proof machinery                                  | Whole-agent sandbox evidence replaces it                                       | Gate 8 blocked on replacement      |
| Live `mpx-pi`/`mpx-claude-code` source imports and legacy activation | Retained Pi source is migrated, both routes pass, and rollback succeeds        | Gate 8 blocked on acceptance       |

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

- expose host and sandbox MPX Claude/Pi sessions while preserving normal Pi extension discovery;
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
- [ ] **Gate 4 — curated parity:** migrate retained Pi-specific source into canonical `runtimes/pi/extensions`, remove `--no-extensions` and generated feature duplicates, then prove the same native extensions on personal/work host routes. Existing content audit, deterministic profiles, ownership-safe upgrades, native discovery, and host Pi lifecycle/export work is retained; Windows argv-only subprocess routing, exact reopen, host Claude, and mixed native/MPX acceptance remain pending.
- [ ] **Gate 5 — whole-agent sandbox:** run Pi and the same canonical native extensions inside `sbx` with selected-identity services, a host-owned private clone, open network, published development ports, host path/editor translation, sessions, exact mounts, no opposite identity/original checkout/Docker socket, no host fallback, explicit apply-back, and cleanup.
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
- Native Pi compatibility checkpoint: commit `83f269b` normalizes the known seven-digit PowerShell process-start timestamp to the Windows inspector's millisecond fingerprint and ignores only known Pi v1 entries while malformed or unknown v2 input remains fail-closed. The sessions package passed 105 tests and typecheck.
- Host Pi resurrection checkpoint: commits `e813ca9`, `384641a`, and `82ae95e` defer lifecycle capture until Pi creates its session file, pass only the two trusted lifecycle variables through the executor, and align MPX's strict DTO with agent-resurrect. Installed release `0fc0ca51facbe908f099bc9af3689dc62ee1ee315fefc3c309041ad984d29454` is strictly healthy. A real personal `pi-mpx` model run returned `GATE4_HOST_PI_EXPORT_OK`; reconcile passed; export produced one inactive privacy-safe host record and exact approved argv with no native session reference. agent-resurrect parses that live output correctly.
- No repository evidence yet accepts whole-agent sandbox containment or complete session resurrection.

## Active blockers

1. The available `shell-docker` sandbox template exposes `/var/run/docker.sock`; whole-agent acceptance requires a template or policy with no Docker socket.
2. Retained Pi-specific source still lives in `mpx-pi`; migrate it into `runtimes/pi/extensions`, remove cross-repository imports, and make it the single host/sandbox implementation before deprecating that repository.
3. Selected Pi, Git, SSH, GitHub, and GitLab identity state is not yet staged for whole-agent sandbox use. Gate 5 may expose only the selected identity to trusted extensions and must keep it out of releases, logs, public state, and opposite-identity reach.
4. On Windows, agent-resurrect's `shell:false` subprocess cannot execute the installed `.cmd` selector directly, so live scanning returns no MPX records even though its strict parser accepts the live export. Add a stable argv-only Node entry route; do not weaken to shell command strings.
5. Personal Claude OAuth requires interactive renewal before that route can pass.
6. Whole-agent Pi sandbox, private-clone path/editor mapping, port publication, session-path translation, and apply-back are not implemented or accepted.
7. Live provider credentials and Gerrit implementation remain pending.
8. Real Git author/SSH routing, complete route parity, rollback, and zero-legacy audit remain pending.

## Next-session handoff

Start from clean `main` after reading this file and [the native Pi extension migration plan](docs/PI_EXTENSION_MIGRATION.md) completely. Gate 4 remains active; do not begin Gate 5 implementation before host parity passes.

1. Preserve and finish the unrelated argv-only Node-entry work from the active Gate 4 worktree, but do not merge its generated footer renderer, Git collector, or reduced status-envelope replacement.
2. Move retained Pi-specific source and focused tests from `mpx-pi` into canonical `runtimes/pi/extensions`. Replace absolute cross-repository imports with package-relative dependencies; do not rewrite the native behaviors.
3. Register the static canonical package once through Pi discovery, remove generated duplicate feature registrations plus the temporary explicit generated extension, remove `--no-extensions`, and prove normal discovery plus `/reload` on personal and work host routes.
4. Prove agent-resurrect live scanning and exact-argv reopen, host MPX Claude, and one mixed native/MPX Windows Terminal group. Preserve native launcher behavior.
5. Revalidate the complete Pi footer, profile, keybindings, common skills, subagents, development services, provider/Git integrations, and Claude host behavior. Personal Claude OAuth may remain the explicit blocker.
6. Resolve findings, run `pnpm test`, `pnpm run typecheck`, `pnpm run check`, `pnpm run convergence:verify`, `pnpm run validate:generated`, and `git diff --check`, then update and close Gate 4 only if live host acceptance passes.

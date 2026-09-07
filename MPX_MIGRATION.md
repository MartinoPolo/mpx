# MPX cleanup execution authority

**Status:** Native-first Pi daily-driver acceptance passed for personal and work identities, including preserved cross-release sessions. Repository gates pass apart from explicitly deferred Fallow. Personal Claude authentication, live-provider limitations, interactive certification and deferred cleanup remain separate; setup before-image evidence has the qualification recorded below.

**Authority:** This file is the sole active migration status and evidence authority. User instructions override it. Durable architecture remains in [CONTENT_COMPILER_ARCHITECTURE.md](docs/CONTENT_COMPILER_ARCHITECTURE.md), [ADR 0004](docs/adr/0004-canonical-native-pi-extensions.md), and [PI_EXTENSION_MIGRATION.md](docs/PI_EXTENSION_MIGRATION.md).

## Execution rules

- Preserve native `pi`, `piw`, `cc`, `ccd`, `ccw`, and `ccwd` behavior and names.
- Native Pi and Claude own credentials, sessions, configuration roots, extensions or plugins, and runtime behavior.
- MPX owns identity selection, compiled shared content, routing, bounded lifecycle metadata, provider-neutral operations, workspace coordination, and optional orchestration.
- The content compiler owns final skill and agent bytes. Runtime adapters copy those bytes without rewriting them.
- Use `pnpm` for MPX package commands.
- Run narrow tests first and `pnpm run typecheck` before every commit.
- Use isolated worktrees with exclusive file ownership. Return to one clean `main` after each integrated checkpoint.
- Only the orchestrator edits generated bundles, generated CLI references, the lockfile, and this authority.
- Preserve unrelated user changes. Stop when worktree ownership is ambiguous.
- Never manually rewrite credentials, native histories or native launcher files. Authorized setup may change only verified receipt-owned resources; native runtimes persist their own sessions. Preserve recovery evidence and unrelated settings.
- Host daily-driver acceptance precedes optional sandbox work.
- Do not retain removed behavior behind hidden help or compatibility aliases.

## Fixed architecture

```text
apps/cli
  parsing, command registry, progressive help, rendering, exits

@mpx/application
  deep operation facade and Node composition

@mpx/content-compiler
  canonical skills and agents, profiles, final runtime bytes, inspection

@mpx/runtime-pi and @mpx/runtime-claude
  thin native launch adapters

@mpx/pi-extensions
  checked-in canonical Pi-specific implementation

@mpx/providers
  fixed built-in provider contracts and adapters

@mpx/sessions
  bounded lifecycle metadata, resurrection export, exact resume argv

@mpx/ports, @mpx/worktrees, @mpx/dev-services
  independent deep domain modules

@mpx/setup and @mpx/windows
  idempotent setup and platform operations

@mpx/sandbox
  optional whole-agent containment, absent from normal host launch
```

## Human CLI contract

Human help must remain below thirty justified leaf commands:

```text
mpx setup
mpx doctor
mpx init
mpx launch pi
mpx launch claude
mpx content inspect
mpx content check
mpx issue list
mpx issue view
mpx issue create
mpx issue edit
mpx issue comment
mpx issue finish
mpx review view
mpx review create
mpx review merge
mpx ci status
mpx ci logs
mpx session list
mpx session resume
mpx workspace list
mpx workspace show
mpx workspace create
mpx workspace remove
mpx workspace start
mpx workspace stop
mpx workspace logs
mpx port kill
```

`pi-mpx`, `piw-mpx`, `cc-mpx`, and `ccw-mpx` are installed shortcuts, not additional leaves.

Agent-only reference may retain only commands consumed by canonical skills:

- issue label, move, and dependency add or remove;
- review update, comment, and ready;
- CI watch and retry;
- generic provider operations with a demonstrated shipped-skill consumer.

Internal routes stay out of human and agent help:

- resurrection export and exact resume entry;
- necessary bounded workspace recovery;
- optional sandbox lifecycle integration.

Delete rather than hide migration commands, account ceremony, installer intent or plan ceremony, config/provider/runtime inspection groups, the old skill inspection group, public recovery and reconciliation commands, compatibility aliases, and unused session workflows. `doctor` absorbs diagnostics; normal operations perform bounded automatic recovery.

## Gate 4 disposition

**State: complete.** The mixed Gate 4 worktree was preserved, narrowly salvaged, verified live, and removed. It was not merged as a whole.

Retained:

- strict stable Windows `mpx-node.mjs` entry;
- absolute `reg.exe`, exact argv, `shell:false`, and bounded registry hydration;
- active-release and release-manifest validation;
- hash, containment, and reparse-point checks;
- ownership-safe installer upgrade support;
- request-scoped one-step resurrection approval after final plan and policy verification;
- direct agent-resurrect Node transport and Windows Terminal argv reopening.

Discarded:

- generated footer, Git, status, subagent, and UI replacements;
- Gate 4 generated bundles and snapshots;
- the extra Pi TUI dependency;
- CLI help and public session routing from the mixed worktree;
- any continuation of generated `--no-extensions --extension` architecture.

Evidence:

- MPX checkpoints `d264a1a` and `09888dd` implement the stable entry and one-step resurrection authority.
- agent-resurrect checkpoints `f4b067c` and `51b6f78` implement and test direct Node transport.
- Focused installer, Windows, application, CLI, and agent-resurrect suites passed; MPX and agent-resurrect typechecks passed.
- Installed release `bac690cbbffc713cea9c3befe78832011f26759dbcb6d09e6559055ced3131d9` passed strict verification.
- A post-upgrade personal MPX Pi session returned the expected model marker, became inactive, and was reopened by agent-resurrect as exact direct argv through `mpx-node.mjs`; MPX then reported it active.
- Native Pi, Claude, and `.bashrc` hashes remained unchanged across installation. Only installer-owned MPX selector and Node-entry files changed.
- Preserved recovery archives live under `${MPX_PROJECTS}/mpx-recovery` for the former MPX and agent-resurrect Gate 4 worktrees.
- The obsolete Gate 4 worktrees and branches were removed from both repositories.

## Cleanup phases

### Phase 1 — Trustworthy baseline

**Historical state: superseded.** The baseline work established application/session boundaries and clean tests, typechecking, and lint. Its former external-source drift blocker is no longer operative because Pi extension source is canonical in this repository.

### Phase 2 — Characterize retained behavior

Add only tests that protect retained behavior:

- CLI envelopes, progressive help, TTY rendering, and redirected JSON;
- provider operations referenced by canonical skills;
- exact session export and resume;
- compiler bytes, references, and exposure modes;
- worktree, port, and development-service lifecycle;
- native Pi and Claude launch arguments;
- installer-owned resource safety.

Do not characterize migration-only behavior scheduled for deletion.

### Phase 3 — Contract CLI and application

- Add `human`, `agent`, `internal`, and `experimental` audience metadata.
- Generate basic and complete references from one registry.
- Enforce the human leaf limit in tests.
- Split handlers by domain and route composition through application operations.
- Remove obsolete handlers, services, exports, tests, docs, and aliases together.
- Preserve focused help with examples, pretty TTY output, and compact redirected JSON.

Exit requires the CLI to import application operations rather than assemble domain services directly.

### Phase 4 — Native runtime ownership

Pi:

- move retained `mpx-pi` source and tests into `runtimes/pi/extensions` without reducing behavior;
- preserve footer, guards, resurrection, subagents, development services, keybindings, themes, editor behavior, auto-title, compaction, scroll behavior, and terminal progress;
- replace cross-repository imports with package-relative dependencies;
- register the static package exactly once through native discovery;
- remove `--no-extensions` and explicit generated-extension activation;
- remove duplicate generated implementations;
- register canonical Pi `/mpx:<name>` commands through lazy, integrity-verified compiler content; preserve native `/skill:<name>` discovery for project skills without duplicate canonical discovery.

Claude:

- keep native personal and work `CLAUDE_CONFIG_DIR` roots;
- add compiled content through `--plugin-dir`;
- use transient `--settings` and route-limited strict MCP configuration where required;
- resume validated native session IDs;
- do not create an MPX-owned account universe.

Exit requires personal and work host routes to behave like native installations plus MPX content and routing.

### Phase 5 — Idempotent setup

- retain atomic writes, owned-path checks, and foreign-path refusal;
- replace installer intent, plan, digest, apply, rollback, uninstall, and external-action ceremony with one bare `mpx setup`; failed applies roll back automatically;
- make reruns idempotent;
- allow MPX-local state reset without permanent legacy readers;
- install the stable Node entry and `-mpx` aliases;
- never replace native launcher names, credentials, sessions, or roots.

### Phase 6 — Workspace facade

**State: complete.**

Ports, worktrees, and development services remain separate deep packages. The provider-neutral application facade now exposes workspace list, show, create, remove, start, stop, and logs with bounded automatic recovery; Node composition supplies target-scoped project, process, filesystem, port, status, and service adapters. `workspace show` joins Git identity and path, assigned ports, configured or managed services, listener or conflict state, and bounded redacted diagnostics. Removal stops managed checkout-scoped services before durable Git removal and identity-bound lease release. `port kill` remains delegated to verified port-service termination. The replaced top-level status, worktree, dev, and ports routes were deleted rather than retained as aliases. The final human-leaf count remains a Phase 8 acceptance item and is not claimed here.

### Phase 7 — Provider consolidation

**State: complete.**

GitHub, GitLab, KanbanFlow, local Markdown, and minimal Gerrit are fixed, internally separated adapters in the private providers package. Dynamic provider injection is removed, fixed registry/adapter agreement fails closed, and provider, application, CLI, and contract tests verify the provider-neutral operations referenced by canonical issue, review, and CI skills. Gerrit's review operations are covered against recorded command/response contracts; live Gerrit acceptance remains a separate environment-dependent check because no live server is available in the repository gate.

### Phase 8 — Obsolete architecture deletion

**State: in progress.**

Completed:

- removed the obsolete public Phase-J migration commands, application services, dedicated tests, temporary handoff, and reconciliation documentation;
- deleted the obsolete F2 proof, runtime-tool inventory, host-Pi proxy, sandbox worker, persisted-proof resume, and generated evidence stacks;
- made Docker launch and resume fail closed without host fallback while retaining only optional whole-agent sandbox planning primitives;
- regenerated the CLI references and bundles without retaining hidden migration aliases.

Completed work includes deletion of the public installer uninstall/rollback and external-integration protocol; `mpx setup` is bare and idempotent, with receipt-safe upgrades and automatic failed-apply rollback retained internally. The external-source convergence checks and manifest remain deleted by explicit user decision: current implementation is validated against required behavior, not external repository hashes. Retained legacy detach and migration-safety tests protect existing installations; they do not restore external repositories as implementation authorities. Remaining work includes dead services, superseded tests and docs, and dependencies used only by removed behavior. Run dead-code and cycle analysis after deletion instead of preserving theoretical APIs.

### Phase 9 — Optional sandbox

This is not a host-release gate. Run the same native runtime package and compiled content in `sbx`. Mount only the selected identity root, never the opposite identity or broad home. Prevent simultaneous host and sandbox use of one identity root. Exclude the original checkout and Docker socket. Never fall back silently to host. Describe the boundary as workspace/process containment, not credential isolation. Keep path, editor, and port bridging narrow and sandbox-local.

### Phase 10 — Documentation and context pruning

**State: in progress.**

Completed:

- deleted the obsolete Phase-F manual rollback guide now superseded by internal automatic installer recovery and current launch documentation;
- corrected active content CLI prose; the later user-approved namespace integration uses `/mpx:<name>` for canonical Pi skills and native `/skill:<name>` for project skills;
- removed external `mpx-pi` deployment authority wording from runtime-tools provenance while preserving its dated package provenance.

Keep the README, AGENTS instructions, short operating guides, durable ADRs, compiler architecture, native Pi ownership, and generated CLI references. Delete or archive temporary handoffs, gate narratives, TDD journals, F2 proofs, Phase-J documents, obsolete installer prose, historical source-repository instructions, and generated evidence with no consumer.

## Acceptance

The user confirmed host-first completion: the host matrix and repository gate below are required; sandbox execution is deferred. Unavailable live-provider checks remain explicitly documented rather than reported as passed. Historical implementation checkpoints do not establish acceptance of the current release.

The user confirmed canonical Pi skills use `/mpx:<name>`, while project skills retain native `/skill:<name>`. The compiler remains the sole owner of final skill bytes; namespace registration must preserve lazy loading and manifest integrity.

The user transferred ownership of the existing `fix/pi-skill-command-namespace` worktree to this migration session, with all uncommitted changes preserved before integration. Notification repair originated in a separate session. The user now authorizes evaluating all MPX worktrees, completing unmerged work and integrating it into main. Preserve each worktree's unique changes and verify active ownership before resolving overlaps; do not overwrite concurrent work or discard dirty worktrees. After disposable tests pass, receipt-authorized host setup changes are permitted on personal and work runtime roots, preserving native credentials, sessions, launchers, and unrelated settings. Stop on ambiguous ownership.

The user's latest completion requirement includes a clean integrated repository after evaluating every worktree, and working MPX or fully functional native fallback in affected projects. The reported `pi-mpx` failure in `${MPX_PROJECTS}/prejemesi` (`PROJECT_SKILL_INVALID: YAML tags, anchors, aliases, and merge keys are forbidden`) was an immediate usability blocker and is resolved in installed acceptance. The scalar punctuation fix and native-versus-managed discovery boundary are implemented. Native skills without MPX metadata retain native interpretation; explicit managed declarations remain fail-closed. Pi receives exact classified native `SKILL.md` entrypoints to prevent ignore-driven nested discovery bypass. Focused skills, invocation and real native-loader regressions passed, followed by the full repository gate and actual host launches. Historical session evidence exposed canonical-workflow leakage and native specialist-directory discovery failures; native/managed separation and exact specialist routing are now verified. Investigate relevant native Pi session evidence for partial-migration skill-discovery and identity failures; verify fixes against actual affected launch paths, not only disposable fixtures. Use Luna for exploration and primarily Astra for implementation, review and acceptance.

Daily-driver acceptance for personal and work Pi and Claude must cover:

- correct native account and unchanged native fallback;
- expected extensions or plugins, footer/status, theme, and keybindings;
- common compiled skill and subagent;
- file read/write, shell, Git identity, and provider route;
- native session persistence and exact resurrection.

### Current integration checkpoint

The namespace, native lifecycle and root-source structure validation checkpoints are committed and integrated into main. Focused namespace tests, disposable setup tests and Pi launch/discovery E2E passed before the restart. Security review completed without concrete findings. The name-only command description fix passed focused tests. The tracked lockfile now includes the compiler workspace dependency; the frozen-lockfile command succeeded. Installer fixture builders now copy the required compiler package and clean failed setup allocations; targeted installer tests passed. Independent fixture review found no unsafe cleanup or weakened rollback assertions; additional sibling-byte preservation coverage passed.

The combined functional gate passed all stages of `pnpm test`, including integration and E2E, plus typecheck, formatting, generated verification, structure and recursive workspace checks. Mechanical lint fixes subsequently passed lint, focused skills and extension tests, and typecheck; the orchestrator regenerated and validated the final bundles. Both integration shared writers now use independent repository snapshots, resolving the release-freshness test race without weakening production checks. Notification repair is integrated from byte-verified preserved files; its imported deployment report remains historical. Combined logs are under `${LOCALAPPDATA}/Temp/mpx-acceptance-4OBTyP`.

Actual setup attempts exposed and safely rejected an already-partially-detached native layout, then ordinal-based projection ownership drift. The resulting fix admits an independently verified current installation before reset/detach, validates the state boundary before recovery, and reconciles projection files by logical identity. Obsolete projected files remain inactive and receipt-owned; no deletion or reconstruction occurs. Fresh installations retain the strict legacy-detachment path. Focused preservation/recovery tests and independent review passed. The subsequent host retry succeeded twice with strict health and no issues on release `985fe3f3f567bc0b631986aa55226d25ec9e22bcf733c6aa81c1eee79a833523`. Installed artifacts, selector, receipt and manifest agree; native repair, links, target bytes and unrelated settings were preserved. Evidence is under `${MPX_PROJECTS}/mpx-recovery/host-setup-2026-09-06T21-37-54-179Z`. Failed-attempt evidence remains under `${MPX_PROJECTS}/mpx-recovery/host-setup-2026-09-06T18-58-15-529Z` and `host-setup-2026-09-06T19-57-09-182Z`.

The latest candidate passed the complete `pnpm test` chain, including unit, payload, contract, integration and E2E stages, plus typecheck, formatting, lint, generated verification, structure validation and diff checks. The independent release-input assertion includes the runtime-contracts dependency sources. Fallow remains the explicitly deferred exception below.

Native workflow separation was repaired with public settings locking and atomic writes: canonical MPX source exposure was removed from both Pi skill arrays and the exact shared source link was archived. Classic MP discovery is retained for both identities and GH for personal only; unrelated settings, packages and legacy links were preserved. Evidence is under `${MPX_PROJECTS}/mpx-recovery/native-fallback-2026-09-06T20-03-20-278Z`. Real native RPC probes authenticated, read project files, preserved sessions and showed no canonical MPX workflow leakage. The subsequent installed-package probes fixed specialist routing: actual `pi-mpx` in `prejemesi`, `piw-mpx`, and both plain native profiles authenticated and completed tools with the exact requested specialist. The compiled common skill and native project skill were discovered and exercised. Current Pi evidence is under `${MPX_PROJECTS}/mpx-recovery/pi-installed-acceptance-2026-09-06T21-45-49-799Z`; earlier native-only evidence is under `${MPX_PROJECTS}/mpx-recovery/native-rpc-acceptance-2026-09-06T20-11-16-410Z`.

The canonical Pi lifecycle-event producer, scoped discovery, batched process inspection and resume child-exit propagation are deployed and verified on both identities. Prospective resume planning displays effective authority, binds current artifacts and historical provenance into confirmation, and revalidates before execution. Preserved cross-release sessions passed explicit confirmation; subsequent unchanged resumes passed the shortcut. Repeated dry-runs returned identical envelopes without changing native bytes. Native session replacement is not cancelled: tracking closes the original launch binding and leaves a replacement unbound rather than inventing ownership. The separate installed tool-display override now forwards execution context; its external source/test patch passed the complete suite and typecheck, and generated package-manager residue was archived. That external patch is preserved uncommitted in its existing feature checkout and backed up under `${MPX_PROJECTS}/mpx-recovery/tool-display-context-2026-09-06T22-13-05-130Z`. Work Claude, native fallback, content validation and prompted resume passed. Personal Claude fails with expired OAuth in both native and MPX routes; authentication remains user-owned. Provider probes have explicit authentication/configuration failures, not passing live evidence. Claude evidence is under `${MPX_PROJECTS}/mpx-recovery/claude-installed-2026-09-06T21-45-32-479Z`. Interactive visuals, keybindings and audible notifications remain unverified by headless probes.

Unused compiler re-exports were removed; extension re-exports used by release artifact tests were retained. The Fallow regression remains unresolved and is deferred to a separate cleanup run by the user's latest usability-first direction. The proposed full-migration comparison gate will not be implemented in this acceptance work. Preserve the existing Fallow command and baseline, report its failure explicitly, and do not claim the aggregate `check` command passes. Functional tests, installer safety, typecheck, formatting, lint, generated verification and structure validation still gate host setup. The earlier verified namespace, discovery and notification checkpoint was committed as `36049d1` and fast-forwarded into clean main; the original main payload remains preserved in recovery and a named stash. The verified upgrade checkpoint `29b1a1b` is also integrated into main. The superseded namespace, notification-repair and notification-deploy worktrees were removed only after backup and active-owner checks; their disposition ledger is in `${MPX_PROJECTS}/mpx-recovery/worktree-consolidation-20260906T181233Z/cleanup-disposition-ledger.json`. Main and the acceptance checkout remain pending final checkout retirement. The formerly separate validator branch was formally merged and deleted after byte-equivalence checks. Recovery archives and the original-main stash remain intentionally preserved.

### Latest installed acceptance

Installed release: `86c6754f55070ec65c4e0226ee3e0f9930e8cd702453c9a987d751b2c92c4a1f`.

Evidence: `${LOCALAPPDATA}/mpx/recovery/final-authorized-20260907/acceptance-matrix.json`.

- Personal `pi-mpx` in `prejemesi` and work `piw-mpx` in `yoursafe-components` loaded current-release commands, persisted valid launch bindings and shut down inactive.
- Public listing completed in roughly one to two seconds. Preserved personal and work sessions completed explicit cross-release resume, then unchanged shortcut resume, with exact markers, successful child/outer exits and original headers and byte prefixes preserved.
- Plain native metadata and the external execution-context repair passed. Earlier installed evidence covers compiled/native skills and exact specialist routing; interactive appearance, keybindings and audio were not certified.
- Setup runs were healthy with the same release key. A reused recovery harness executed on import, causing extra runs and overwriting initial named before-images. Retained settings bytes and hashes recover settings comparison; extended history/credential-metadata comparisons start after upgrade. Preserve this qualification: the initial upgrade does not have pristine before-image coverage. The recovery-only import guard was corrected; no receipt or native history was fabricated.
- The full repository suite passed without exclusions, followed by typecheck, generated verification and diff checks; formatting, lint and structure also passed on unchanged source. A preceding disposable setup run encountered a staged-release Windows `EPERM`; the identical narrow test and subsequent full run passed without code changes. Its cause remains unknown. Original and rerun evidence remains in `${LOCALAPPDATA}/Temp/mpx-final-gates-DvBm6o` and `mpx-gate-rerun-dkk7xb`.
- Personal Claude still requires user login. Provider authentication/configuration failures, unperformed interactive certification, Fallow cleanup and optional sandbox work are not claimed complete.

Repository gate:

```bash
pnpm test
pnpm run typecheck
pnpm run format:check
pnpm run lint
pnpm run validate:structure
pnpm run validate:generated
git diff --check
```

Stop and redesign if:

- shell command strings become necessary for resurrection;
- a runtime adapter rewrites compiler-owned skill or agent bytes;
- Pi requires duplicate extension activation or native-root replacement;
- setup touches native credentials, sessions, roots, or launcher names;
- sandbox mounts the original checkout, opposite identity, broad home, or Docker socket;
- sandbox silently falls back to host;
- obsolete behavior survives only behind hidden help.

## Ongoing skill and extension development

Safe now:

- general skills under `content/skills` using canonical compiler schema and semantic capabilities;
- ordinary agents under `content/agents` using semantic model classes and canonical identities.

Do not create separate Claude and Pi copies.

Pi-specific implementation belongs in the canonical static package under `runtimes/pi/extensions`; external repositories are not runtime or test authorities.

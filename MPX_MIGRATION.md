# MPX cleanup execution authority

**Status:** Cleanup execution is active. The obsolete Phase-J command slice has been removed. The repository baseline is not yet accepted because the clean `mpx-pi` migration source has advanced beyond the reviewed convergence manifest. Do not hide that drift; resolve it by moving retained Pi source into the canonical static extension package.

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
- Never mutate native credentials, native sessions, native configuration roots, or native launcher files. MPX-local state may be reset.
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

**State: in progress.**

Completed:

- the neutral application root no longer imports a runtime value from `@mpx/sessions`;
- Node composition injects the session-resurrection projector;
- application architecture and session tests pass;
- full tests and typecheck pass;
- lint is clean.

Open acceptance item:

- `convergence:verify` reports legitimate drift because clean `mpx-pi` source changed after the reviewed manifest. A generated refresh would mark retained source as semantically incomplete, so it was not committed. Resolve this through canonical Pi-extension migration, not a baseline refresh that conceals missing mappings.

Exit requires one clean main worktree, a clean build from source, and the complete repository gate passing.

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
- remove transitional Pi `/mpx:` skill aliases after dependency audit; native Pi uses `/skill:`.

Claude:

- keep native personal and work `CLAUDE_CONFIG_DIR` roots;
- add compiled content through `--plugin-dir`;
- use transient `--settings` and route-limited strict MCP configuration where required;
- resume validated native session IDs;
- do not create an MPX-owned account universe.

Exit requires personal and work host routes to behave like native installations plus MPX content and routing.

### Phase 5 — Idempotent setup

- retain atomic writes, owned-path checks, and foreign-path refusal;
- replace installer intent, plan, digest, apply, rollback, and uninstall ceremony with `mpx setup` preview and `mpx setup --confirm`;
- make reruns idempotent;
- allow MPX-local state reset without permanent legacy readers;
- install the stable Node entry and `-mpx` aliases;
- never replace native launcher names, credentials, sessions, or roots.

### Phase 6 — Workspace facade

**State: complete.**

Ports, worktrees, and development services remain separate deep packages. The provider-neutral application facade now exposes workspace list, show, create, remove, start, stop, and logs with bounded automatic recovery; Node composition supplies target-scoped project, process, filesystem, port, status, and service adapters. `workspace show` joins Git identity and path, assigned ports, configured or managed services, listener or conflict state, and bounded redacted diagnostics. Removal stops managed checkout-scoped services before durable Git removal and identity-bound lease release. `port kill` remains delegated to verified port-service termination. The replaced top-level status, worktree, dev, and ports routes were deleted rather than retained as aliases. The final human-leaf count remains a Phase 8 acceptance item and is not claimed here.

### Phase 7 — Provider consolidation

Move GitHub, GitLab, KanbanFlow, local Markdown, and minimal Gerrit into one private providers package while keeping adapters internally separated. Move conformance tests before deleting old packages. Remove dynamic provider injection and verify every operation referenced by canonical issue, review, and CI skills.

### Phase 8 — Obsolete architecture deletion

**State: in progress.**

Completed:

- removed the obsolete public Phase-J migration commands, application services, dedicated tests, temporary handoff, and reconciliation documentation;
- regenerated the CLI references and bundles without retaining hidden migration aliases.

Remaining work includes F2 proof and inventory machinery, host-Pi remote-tool replacement, sandbox worker or proxy bridge, root-attestation and account commands, generated Pi feature source, duplicate Pi vendor trees, old installer protocol, dead services, superseded tests and docs, and dependencies used only by removed behavior. Convergence checks and their manifest remain until their final migration-source consumer is deleted. Run dead-code and cycle analysis after deletion instead of preserving theoretical APIs.

### Phase 9 — Optional sandbox

This is not a host-release gate. Run the same native runtime package and compiled content in `sbx`. Mount only the selected identity root, never the opposite identity or broad home. Prevent simultaneous host and sandbox use of one identity root. Exclude the original checkout and Docker socket. Never fall back silently to host. Describe the boundary as workspace/process containment, not credential isolation. Keep path, editor, and port bridging narrow and sandbox-local.

### Phase 10 — Documentation and context pruning

Keep the README, AGENTS instructions, short operating guides, durable ADRs, compiler architecture, native Pi ownership, and generated CLI references. Delete or archive temporary handoffs, gate narratives, TDD journals, F2 proofs, Phase-J documents, obsolete installer prose, historical source-repository instructions, and generated evidence with no consumer.

## Acceptance

Daily-driver acceptance for personal and work Pi and Claude must cover:

- correct native account and unchanged native fallback;
- expected extensions or plugins, footer/status, theme, and keybindings;
- common compiled skill and subagent;
- file read/write, shell, Git identity, and provider route;
- native session persistence and exact resurrection.

Repository gate:

```bash
pnpm test
pnpm run typecheck
pnpm run check
pnpm run convergence:verify
pnpm run validate:generated
git diff --check
```

Remove convergence checks only when their final migration-source consumer is deleted.

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

Wait until the static Pi package exists before major nested-subagent or Pi-extension production work. Requirements, failure models, parent-child protocol, depth and concurrency limits, cancellation semantics, UI mockups, and characterization tests are safe now. Avoid significant work in deprecated `mpx-pi`; final Pi-specific implementation belongs in `runtimes/pi/extensions`.

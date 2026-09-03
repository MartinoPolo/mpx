# MPX migration execution guide

**Temporary companion:** Keep this file beside `MPX_MIGRATION.md` until Gate 8 completes, then delete it. `MPX_MIGRATION.md` remains the status and evidence authority; this file preserves the recovered execution rationale and acceptance instructions that should survive session compaction.

**Recovery source:** The original autonomous handoff is preserved in Git at `3f719e0:MPX_MIGRATION.md`. This guide restores its operational instructions without restoring the superseded legacy migration record.

## How to continue in a fresh session

1. Read `AGENTS.md`, this file, and `MPX_MIGRATION.md` completely.
2. Treat the first unchecked gate in `MPX_MIGRATION.md` as the only active gate.
3. Do not begin a later gate because part of it can be implemented early.
4. Preserve native launcher continuity and all user-owned state.
5. End each gate at a verified, pushed, clean `main` with no auxiliary worktrees or branches.
6. Record exact evidence and remaining blockers in `MPX_MIGRATION.md` before checking a gate.

## Autonomous execution authorization

The user authorizes the orchestrator to complete this plan autonomously, including modifying and deleting in-scope MPX files, creating temporary isolated worktrees and branches, integrating verified work, creating conventional commits on local `main`, and pushing verified commits to `origin/main`.

This authorization is limited by these rules:

- Preserve unrelated user changes and native `pi`, `piw`, `cc`, `ccd`, `ccw`, and `ccwd` continuity paths.
- Never force-push, amend published commits, use destructive Git reset/checkout/clean commands, or bypass repository safety hooks.
- Use `pnpm` exclusively for MPX package commands.
- Run `pnpm run typecheck` before every commit.
- Run narrow relevant tests before integration and repository-wide required checks before pushing a gate.
- Use conventional commit messages and push only coherent, verified checkpoints.
- Start feature implementation from clean `main` with no auxiliary worktrees and return to that state at every gate.
- Use isolated worktrees only for disjoint scopes with an explicit non-overlapping ownership map.
- Only the orchestrator edits `MPX_MIGRATION.md`, this guide, or generated artifacts.
- Every replacement removes the obsolete code, tests, documentation, and generated references it supersedes.
- Continue independent work when credentials, OAuth, or manual observation block one route. Ask the user only when no safe autonomous route remains.
- Do not add implementation-time estimates to tracked planning files.

## Migration invariants

- `mpxconfig.json` is the only committed project integration manifest.
- Credentials, identities, launch defaults, native account roots, and mutable machine state remain user-local.
- Native account stores remain authoritative. MPX does not copy secrets, auth, sessions, cache, or trust state into a release.
- Installed MPX launchers use the `-mpx` suffix and never shadow native launchers.
- Host execution is explicit compatibility, never sandbox isolation or a silent fallback.
- Standalone Docker Sandboxes `sbx` is the target whole-agent executor.
- Initial sandbox work uses a private clone. Linked host worktrees are not mounted with repository-wide Git administration state.
- The selected `open` network baseline is global `allow-all`; it is not an egress-isolation boundary.
- The installer never owns Windows Terminal settings, Task Scheduler, Raycast, or Obsidian orchestration.
- `agent-resurrect` remains the standalone daily UI; MPX owns only a stable compatibility protocol.
- Local Markdown issues, ports, host worktrees, explicit project registration, and safe `wt.exe` tab launching remain supported.

## Gate operating model

There are two cleanup waves. Gate 2 removes dependency-safe obsolete scope before feature work. Gate 8 removes compatibility machinery only after its replacement passes live acceptance.

### Gate 0 — preserve and understand the dirty checkout

**Purpose:** Establish a recoverable, classified, verified baseline before deleting or redesigning anything.

**Work:**

1. Save a recovery patch and untracked-file copies outside the repository.
2. Inventory every dirty file.
3. Run disjoint read-only reviews of launch/runtime, installer/Windows, sandbox/executor, and documentation/generated changes.
4. Classify each change as retain, superseded, delete, or replacement-required.
5. Run the complete tests, typecheck, generated validation, and diff check.
6. Commit retained changes in logical conventional commits.
7. Confirm clean `main` is the only branch and worktree.

**Acceptance:** Recovery material exists outside the checkout; all changes are classified; the retained baseline is verified, committed, pushed, and clean.

### Gate 1 — establish migration authority

**Purpose:** Replace conflicting historical prose with one concise status and evidence authority while preserving this execution guide separately.

**Work:** Keep fixed decisions, implementation inventory, retained/deferred scope, deletion ledger, parity inventory, resurrection contract, gate checkboxes, evidence, and blockers in `MPX_MIGRATION.md`.

**Acceptance:** `MPX_MIGRATION.md` is the sole active status authority, links to this temporary guide, and contains no conflicting active plan.

### Gate 2 — safe cleanup

**Purpose:** Remove obsolete scope whose consumers are already understood, without deleting compatibility code that still lacks a proven replacement.

**Remove after dependency validation:** Raycast runtime/installer integration, Obsidian installer orchestration, Task Scheduler activation and unused dedicated machinery, Linux/macOS acceptance plans, installer-owned Windows Terminal assumptions, duplicate reports, superseded phase documents, abandoned generated/provenance inputs, and conflicting stale registration branches.

**Retain:** Local Markdown, ports, host worktrees, minimal provider architecture, project registration, safe `wt.exe` launching, resurrection dependencies, and the host Pi bridge until replacement passes.

**Acceptance:** Regenerate once; run every required check; integrate cleanup; remove its worktree and branch; finish on clean `main`.

### Gate 3 — standalone sandbox feasibility

**Purpose:** Prove real Pi can run in standalone `sbx` before rewriting executor architecture.

**Work:**

1. Launch a Linux `sbx shell`.
2. Package or install Pi inside it.
3. Prove interactive TTY operation.
4. Supply only an ephemeral personal credential profile for the spike.
5. Complete a model response.
6. Perform a model-triggered file operation.
7. Persist and resume a session.
8. Inspect effective mounts and dangerous capabilities.
9. Destroy the sandbox and all temporary host material.

**Failure rule:** If Pi fails, stop and evaluate Docker rather than building more `sbx` abstractions.

**Acceptance:** Real model, tool, persisted-context, TTY, mount-inspection, and complete cleanup evidence exists. Feasibility does not imply containment acceptance.

### Gate 4 — curated host parity and resurrection

**Purpose:** Make canonical content and host MPX Claude/Pi routes deterministic, then preserve daily session resurrection before changing the executor architecture.

**Implementation ownership:**

- Content: canonical skills, agents, prompts, output style, and inventory.
- Pi: footer, extensions, immutable profile, keybindings, theme, settings, and explicit invocation argv.
- Claude: plugin, hooks, forced output style, status, and supported settings.
- Sessions: privacy-safe MPX export, approved resume route, and narrow `agent-resurrect` compatibility.

The orchestrator alone integrates generated files and migration evidence.

**Host acceptance:**

1. Install and strictly verify the current immutable MPX release without changing native launcher names, Windows Terminal, or Task Scheduler.
2. Reconcile MPX sessions and validate the strict bounded resurrection export contains no native paths, IDs, transcripts, prompts, credentials, model data, or launch evidence.
3. Prove native Pi, native Claude, host MPX Pi, host MPX Claude, and a mixed native/MPX Windows Terminal save/reopen group.
4. Revalidate Pi profile/footer/keybindings/common skill and Claude hooks/forced output style/native status line on personal and work routes.
5. Prove model response, model-triggered file read/write as appropriate, shell/Git identity route, correct account, and unchanged native fallback.

**Acceptance:** The implementation and installed host behavior pass. A credential-blocked final route remains explicitly unchecked rather than being inferred from another account.

### Gate 5 — whole-agent sandbox

**Purpose:** Replace host compatibility with real whole-agent sandbox execution, not merely a sandboxed shell tool.

**Required design and proof:**

- Ephemeral selected-identity profile with credentials outside model-visible sandbox authority.
- Private sandbox clone workspace and durable session persistence.
- Exact mount allowlist with no opposite identity, native account root, Docker socket, or unintended host path.
- Model-visible file, shell, process, browser, Git, and development tools execute only inside the sandbox.
- No host fallback under any failure.
- Explicit export/apply-back flow for changes.
- Host-to-sandbox session-path translation and verified cleanup.

**Acceptance:** Real Claude and Pi whole-agent launches prove selected identity, model response, tools, Git, session resume, exact mounts, apply-back, denial/failure behavior, and zero residual sandboxes. Host compatibility cannot be labeled sandbox isolation.

### Gate 6 — all-route acceptance

**Purpose:** Validate the complete system in a fixed order so easier routes do not hide account-specific failures.

**Order:** Personal Pi, Work Claude, Work Pi, Personal Claude.

**Every route proves:**

- Expected UI/footer, settings, and shortcuts.
- Common skill invocation.
- Model response.
- File tool.
- Shell/Git tool and correct author/SSH route.
- Correct native account identity.
- Session resurrection.
- Native fallback.
- Sandbox containment where applicable.

**Acceptance:** All four routes pass. Personal Claude OAuth is renewed interactively before that route can be accepted.

### Gate 7 — providers and retained utilities

**Purpose:** Complete the retained operational surface after runtime architecture is stable.

**Work and acceptance:**

- KanbanFlow live create/view/update/move/comment/finish operations.
- Minimal Gerrit query, `refs/for/<branch>` upload, patchset, review/comment/vote, and submit workflows—no generalized platform.
- GitHub and GitLab verification through provider-neutral contracts.
- Host worktree create/remove/prepare/trust behavior.
- Port allocation, lease, conflict, release, and reconciliation behavior.
- Explicit user-invoked Windows Terminal project registration without installer ownership.

### Gate 8 — replacement cleanup and final cutover

**Purpose:** Remove the second wave of legacy compatibility only after live replacements and rollback are proven.

**Remove:** Old split Pi bridge/worker implementation, fake-worker tests, superseded F2 proof machinery, old repository imports and activation state, stale generated inventories, and temporary migration-only artifacts—including this guide.

**Final acceptance:**

1. Verify installation, route behavior, providers, utilities, migration observation, rollback, and native continuity.
2. Run `pnpm test`, `pnpm run typecheck`, `pnpm run check`, `pnpm run convergence:verify`, `pnpm run validate:generated`, and `git diff --check`.
3. Delete every completed worktree and branch.
4. Confirm clean, pushed `main` is the sole worktree and `sbx ls --json` is empty.
5. Delete this temporary guide and reduce `MPX_MIGRATION.md` to durable final documentation/evidence.

## Session-resurrection boundary

MPX exports bounded metadata and an argv route, never a shell command string. It must not expose native session references, native file paths, bindings, prompts, transcripts, credentials, model data, or launch evidence.

`agent-resurrect` must:

- continue reading native Claude and Pi sessions unchanged;
- tolerate unavailable or malformed MPX output without disrupting native scanning;
- preserve older save schemas while writing the current mixed-session schema;
- skip active sessions and reopen closed MPX sessions through the exact validated exported argv;
- support mixed native/MPX Windows Terminal groups without ID collisions.

Sandbox acceptance later adds dedicated host-owned MPX session storage and host-to-sandbox path translation; Gate 4 proves host MPX resurrection only.

## Worktrees, ports, and parallel agents

- Host worktrees remain available and use sibling `<repo>.worktrees` directories.
- Initial sandbox acceptance uses a private clone because linked worktree `.git` files reference repository-wide host Git administration state.
- Port allocation remains independent; sandbox port forwarding is not required for initial sandbox acceptance.
- Read-only exploration may fan out broadly.
- At most a few implementation agents operate simultaneously with exclusive path ownership.
- No two agents edit generated files or migration authority files.
- Integrate one worktree at a time and remove it immediately after integration.
- Every gate ends with no auxiliary worktrees or branches.

## Blocker behavior

- A blocked credential or OAuth route does not authorize bypass, copied secrets, API-token substitution, or weaker acceptance claims.
- Continue independent verification and implementation while blocked.
- Record the exact blocker and the unaccepted criterion.
- Request interactive help only when it is the sole remaining safe action for the active gate.

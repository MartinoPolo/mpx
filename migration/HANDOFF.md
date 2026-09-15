# Final MPX migration handoff

This is the current-state record and remaining migration checklist. Use [account recovery](ACCOUNT_ROLLOUT.md)
for applied transactions and backup locations, [Orca integration](ORCA_INTEGRATION.md) for installed
ownership boundaries, and [DECISIONS.md](../DECISIONS.md) for durable product choices.

## Current state

- `pi`, `piw`, and `ccw` route to `$MPX_PROJECTS/mpx2` and passed real-project native fresh/resume
  acceptance. Personal Claude is configured; live acceptance remains deferred without a subscription.
- Personal Pi resolved the canonical MPX skill after the obsolete Prejemesi project override was
  compared and removed. Work Pi also passed linked-worktree coverage. Work Claude preserved Git Bash
  hook execution, observed Manual default, and reported no owned hook failures.
- Installed-MPX `xpi`, `xpiw`, and `xccw` shell routes were removed. Bare `mpx`, personal `cc`, and
  suffixed `*-mpx` functions still reach `$MPX_APPS/mpx`; these are active residues, not recovery-only.
- `lpi`, `lpiw`, and `lccw` remain temporary direct recovery routes. Pi recovery still depends on
  `mpx-pi` and its external `pi-tool-display` worktree. Native account data remains shared in place.
- Orca installs no model instructions or skills. Its owned Pi extensions are mirrored across the
  personal/work profiles; work Pi fresh/resume passed afterward without extension errors.
- The existing dirty checkout was preserved in grouped local commits before removing superseded
  migration scripts and records. No remote is configured. External legacy repositories, shell
  profiles, installed registrations, protected backups, and ignored local evidence were not changed.

## Maintained tooling

`migration/` retains account rollout, protected single-file changes, their standalone recovery
implementations, and native acceptance runners. `pilot-backup.mjs` remains a shared protection helper
used by the current transactions; its name does not mean the retired pilot installer is required.
`upstream-probe.mjs` verifies the pinned native dependency contract.

Historical transfer generators, one-off probes, pilot installation scripts, and superseded status
reports are archived in Git history, not maintained runtime APIs. Tests specific only to those retired
implementations were removed with them. Product behavior, current transaction safety, and native
acceptance checks remain tested. Protected external recovery copies remain untouched; the older
personal-pilot rollback has a concurrency limitation documented in [account recovery](ACCOUNT_ROLLOUT.md).

## Remaining work

### Preserve external history and reconcile consumers

1. Inventory branch, HEAD, remotes, status, stashes, reflogs, worktrees, and unreachable objects for
   `$MPX_PROJECTS/mpx`, `$MPX_PROJECTS/mpx-pi`, and `$MPX_PROJECTS/mpx-claude-code` before retirement.
   Preserve dirty/untracked source separately from Git bundles; do not reset or clean those checkouts.
2. Classify shell functions, PowerShell equivalents, native registrations, links, patches, Orca/project
   setup commands, and project resources as MPX, native/third-party, project-owned, recovery-only, or
   removable. Disconnect active consumers before archiving their sources.
3. Keep credentials, settings, histories, and transcripts in their native account roots. Do not inspect
   or copy those roots broadly. Preserve unrelated packages and project-authored resources; a name
   collision alone is not permission to remove a project skill.

### Finish command cutover

Use a reviewed protected shell/config transaction to route bare `mpx` to the unified implementation,
remove obsolete suffixed functions, and update PowerShell equivalents. Decide whether configuration-only
personal-Claude acceptance is sufficient before moving `cc`. Keep direct `l*` recovery routes through
restart acceptance. Do not alter Orca hooks merely as part of launcher cleanup.

### Validate the active installation

- Run `pnpm run typecheck`, `pnpm build`, `pnpm test`, and `git diff --check` after repository changes.
- Verify fresh Git Bash and PowerShell resolution, active accounts' real-project fresh/resume routes,
  selected physical skill sources, native resources, safeguards, and scoped synchronization convergence.
- Exercise representative authenticated child-agent, MCP, web, browser, and normal workflows during
  ordinary use. Marker probes disabled tools/MCP; Claude probes used an explicit low effort override,
  so they do not prove those workflows or saved-effort recovery.
- Check interactive keys, scrolling, questions, footer layout/links, compaction presentation, and actual
  authenticated quota retrieval. Fixture tests do not prove terminal or provider behavior.
- Verify close/reopen and one coordinated reboot/resurrection cycle, including account, project,
  native session, model, and recoverable effort. Report unknown state rather than substituting silently.
- Observe Orca's installed status/attention behavior. Normal cancellation notifications are acceptable;
  deploy no optional compatibility patch without a demonstrated live defect and a reviewed Orca change.

### Publish and retire separately

1. Confirm the intended `MartinoPolo/mpx` remote URL and default branch before adding a remote or pushing.
   Publish to a new migration branch without force, scan staged additions for secrets, and review any
   unrelated-history integration while preserving the old default-branch history.
2. After restart acceptance closes the rollback window, remove `l*` routes, `src/legacy.ts` and the
   `legacy-launch` route, stale legacy profile registrations, and the old installed MPX.
3. Archive legacy repositories intact with preservation records. Branch promotion, folder renaming,
   archival, and deletion require separate explicit approval; none follows automatically from sync.

## Next action

Inventory external legacy consumers and preservation state. This checkout is consolidated; do not
combine that inventory with remote publication, shell cutover, or recovery-source deletion.

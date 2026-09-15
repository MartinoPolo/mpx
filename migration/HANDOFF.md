# Final MPX migration handoff

## Objective

Make this implementation the only active MPX installation, preserve native account data and legacy
history, merge it into `MartinoPolo/mpx`, then archive old repositories after restart acceptance.

## Current state

- `pi`, `piw`, and `ccw` route to `C:/_MP_projects/mpx2` and passed real-project native acceptance.
- `xpi`, `xpiw`, and `xccw` have been removed through a protected `.bashrc` transaction.
- Bare `mpx`, personal `cc`, and suffixed `*-mpx` shell functions still route through
  `C:/_MP_apps/mpx`; they are active residues.
- `lpi`, `lpiw`, and `lccw` remain direct recovery routes. Pi recovery requires `mpx-pi` and the
  external `pi-tool-display` worktree.
- Personal Claude live acceptance remains deferred; its MPX configuration and recovery are present.
- The obsolete Prejemesi `mp-board-to-issues` override was removed after comparison. The canonical
  annotation contract was repaired, and real personal Pi fresh/resume now selects the MPX skill.
- Orca installs no model instructions or skills. Its three Orca-owned Pi extensions are mirrored
  byte-for-byte across personal/work profiles; native work Pi fresh/resume passed afterward with zero
  extension errors. See [the Orca audit](ORCA_INTEGRATION.md).

## Preservation constraints

- Do not reset, clean, rename, archive, delete, or merge directly from dirty working trees.
- Preserve tracked changes, untracked files, stashes, branches, reflogs, unreachable commits, and remote
  identity for `mpx`, `mpx-pi`, and `mpx-claude-code` before retirement.
- Do not read/copy credentials or transcripts. Native account roots remain in place.
- Preserve project-authored skills/instructions and native third-party packages.
- Publication and deletion are explicit operations; do not force-push the existing default branch.

## Known residues to reconcile

### Active old installation

- `$HOME/.bashrc`: `mpx`, `cc`, `cc-mpx`, `ccw-mpx`, `pi-mpx`, and `piw-mpx` still reach
  `C:/_MP_apps/mpx/bin/mpx.cmd`.
- `C:/_MP_apps/mpx`: installed old MPX binary/runtime.
- PowerShell profile: inspect and replace equivalent old launch functions during the same cutover.

### Recovery-only legacy

- `$HOME/.bashrc`: `lpi`, `lpiw`, `lccw`, `_pi_account_launch`, and supporting legacy paths.
- `src/legacy.ts` and the `legacy-launch` CLI route.
- `C:/Users/snapy/.pi/agent-work-legacy` old skill registrations.
- Protected migration backups and evidence.

### Preserve as native/project-owned

- Current personal/work account roots, settings, credentials, histories, and transcripts.
- Native Pi web, MCP, question, and external tool-display packages unless separately retired.
- Project-local `.agents`, `.claude`, and `.mpx` resources after provenance checks.
- Orca's installed local hooks and application state.

### Historical source

- `C:/_MP_projects/mpx`
- `C:/_MP_projects/mpx-pi`
- `C:/_MP_projects/mpx-claude-code`
- Historical Agent Resurrect fixtures and migration evidence

## Execution plan

### 1. Freeze and preserve

1. Record branch, HEAD, remotes, status, stashes, reflogs, worktrees, and unreachable objects for all
   repositories.
2. Create reviewed local checkpoint commits or protected snapshots for dirty and untracked source.
3. Create Git bundles/refs for committed history. Keep working-tree snapshots separate and private.
4. Run staged-secret checks before any publication.

### 2. Prepare the unified repository

1. Checkpoint this checkout's owned migration/runtime/documentation changes without blanket-staging
   unrelated work.
2. Add the existing `MartinoPolo/mpx` remote only after confirming URLs and default branch.
3. Push MPX2 history to a new migration branch without force.
4. Build an integration branch that records both histories while retaining the MPX2 tree as the product
   result. Review the unrelated-history merge before publication.
5. Keep old default-branch history reachable; promote through an explicit reviewed operation.

### 3. Big-bang command cutover

Apply one protected shell/config transaction:

1. Route bare `mpx` to the unified repository installation.
2. Route personal `cc` to MPX after deciding whether configuration-only acceptance is sufficient while
   unsubscribed.
3. Remove old suffixed `*-mpx` functions and stale project-navigation aliases.
4. Keep `l*` recovery routes only through the restart window, clearly labeled legacy.
5. Update PowerShell equivalents and native registrations to the unified path.
6. Do not alter Orca hooks unless their separate live behavior requires it.

### 4. Validate

- Fresh Git Bash and PowerShell command resolution.
- Personal/work Pi and work Claude fresh/resume in representative real projects.
- Personal Claude structural startup without requiring paid inference, if supported safely.
- Selected packs, project resources, native packages, safeguards, and owned hook evidence.
- Orca event delivery where currently installed; no duplicate attention writer.
- Repository typecheck, build, full tests, and diff checks.
- Close/reopen, then one coordinated reboot/resurrection cycle.

### 5. Retire

1. Remove `l*` routes, `legacy-launch`, stale legacy profile registrations, and installed old MPX after
   the rollback window closes.
2. Archive old repositories intact with preservation records.
3. Keep provenance/evidence available without active runtime references.
4. Delete local archives or repositories only through a separate explicit approval.

## Immediate next action

Perform the freeze/preservation inventory and produce an exact ownership-aware checkpoint list. Do not
start remote operations, rename folders, or remove recovery routes in the same step.

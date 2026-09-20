# Applied account rollout

This records the already-applied account rollout and its recovery locations, not authorization for
another apply. Current acceptance and remaining work are tracked only in [HANDOFF.md](HANDOFF.md).

## Routing and preservation

The unified implementation owns `mpx`, `pi`, `piw`, `cc`, and `ccw`. Installed legacy MPX, suffixed
launchers, and direct `l*` recovery functions were removed by the later final cutover. Fresh shells
are required after routing changes. Native account data remains in place; backups are not independent
account profiles. Current location and remaining acceptance are in [HANDOFF.md](HANDOFF.md).

Ignored `.local/final-cutover-pointer.json` identifies protected shell/config/link recovery.
`.local/legacy-archive-pointer.json` identifies the archived installed/local/roaming copies.
`.local/legacy-preservation-pointer.json` identifies the latest verified Git bundles and full `.git`
snapshots, including stashes and reflogs, for the legacy source repositories. Preserve any later
uncommitted files separately. These pointers and their private artifacts must not be published.

The final location move requires its own protection. Older recovery plans target the paths that
existed when prepared; do not apply them after relocation without reviewing those targets.

## Evidence

Machine-local bounded artifacts are under checkout `.local/`:

- `native-pi-work-03` and `native-pi-work-linked-01`: fresh/native catalog and managed resume.
- `native-pi-personal-clean-01`: personal account with exact selected-pack sources.
- `native-pi-personal-preserved-01`: real Prejemesi fresh/managed resume with the former explicitly
  recorded project override. It preserves evidence of the pre-removal native precedence.
- `native-pi-personal-prejemesi-canonical-01`: after approved removal of the older clean tracked
  workaround, real Prejemesi fresh/managed resume resolves `mp-board-to-issues` from the MPX pack.
- `native-pi-work-project-01`: real Yoursafe Components fresh/managed resume.
- `native-claude-work-02/managed-resume.json`: actual `prepareResumeLaunch` continuity evidence;
  earlier explicit permission/effort overrides are not default-state evidence.
- `native-claude-work-project-01`: persisted native executable, real project, fresh/resume, observed
  Manual default without a permission-mode flag, and successful owned-transcript hook evidence.
- `native-claude-work-shell-01`: actual fresh Git Bash `ccw` function, selected work account/project,
  native model/catalog, observed Manual default, and no hook failures.

Claude marker probes disable tools/MCP and explicitly request low effort. Saved Claude effort is
not claimed as recovered. Personal Claude authentication/inference is an accepted adoption exception while the subscription
is inactive; repeat authenticated acceptance if it returns. These checks do not establish physical reboot, interactive keyboard behavior, or Orca restart
and notification acceptance.

The work manifest change is mechanical: project ID, GitLab repository, KanbanFlow board/states, and
Yarn remain intact. The sibling workspace marker and project-authored native skills are untouched.

## Protected recovery

Current account and single-file recovery scripts default to preview and refuse newer edits detected
by their checks. Add `--apply` only for deliberate recovery. Recover routing before configurations
and account surfaces; preserve protected artifacts through restart acceptance. The older personal
pilot uses a separate recovery implementation with the concurrency limitation below.

1. **Removal of installed-MPX `x*` launchers**:
   `$MPX_APPS/_backups/mpx2-remove-x-launchers-2026-09-15T13-27-11.764Z/`
2. **Work launcher routing**:
   `$MPX_APPS/_backups/mpx2-work-launchers-2026-09-15T09-54-43.810Z/shell/`
3. **Work project manifest, then MPX2 user configuration**:
   `$MPX_APPS/_backups/mpx2-work-configuration-2026-09-15T09-52-56.839Z/`
   uses `project-config/` then `user-config/`.
4. **Claude hook repair before initial Claude account rollout**:
   work hook repair `mpx2-work-claude-hooks-2026-09-15T08-20-04.880Z`, then initial work account
   `mpx2-work-claude-rollout-2026-09-15T08-03-48.316Z` under `$MPX_APPS/_backups`.
   Personal hook repair `mpx2-personal-claude-hooks-2026-09-15T08-20-04.884Z`, then personal account
   `mpx2-personal-claude-rollout-2026-09-15T08-03-48.309Z`.
5. **Work Pi account**:
   `$MPX_APPS/_backups/mpx2-work-pi-rollout-2026-09-15T08-02-11.229Z`.

Preview the shell recovery without changing anything:

```bash
node "$MPX_APPS/_backups/mpx2-remove-x-launchers-2026-09-15T13-27-11.764Z/protected-file-change-recovery.mjs"
```

Single-file directories contain `protected-file-change-plan.json` and the standalone script.
Account directories contain their separate account-rollout plan/recovery script. Machine-local
`work-launchers-pointer.json`, `work-configuration-pointer.json`, and Claude recovery-order records
under `.local` identify the applied transactions. Do not restore whole account directories over
new authentication or conversation data.

An initial configuration preparation stopped before live writes because the protection helper used
directory inheritance flags on a file. File-specific flags and real Windows protection tests fixed
that defect. The incomplete preparation at `mpx2-work-configuration-2026-09-15T09-51-25.790Z`
contains no applied transaction and is retained, not silently deleted. Recovery candidates use
unique attempt names so a Windows sharing failure cannot permanently block retry.

## Original personal pilot recovery

The original protected pilot backup remains at:

`$MPX_APPS/_backups/mpx2-personal-pilot-2026-09-14T14-03-39.437Z`

It contains its own standalone Node recovery script and manifests; it does not require the retired
repository pilot installer or checkout dependencies. Resolve later personal-account transactions
before considering this older rollback. Never restore the whole native profile over newer settings,
authentication, or conversations.

```bash
backup="$MPX_APPS/_backups/mpx2-personal-pilot-2026-09-14T14-03-39.437Z"
node "$backup/rollback-personal-pilot.mjs" "$backup"
```

**Legacy limitation:** this script can delete a newer file if another writer replaces a pilot-owned
file between verification and removal. The protected copy has not been upgraded. Do not automate its
`--apply`: stop affected sessions/editors and review current targets and the transaction before a
manual recovery. Preview is not a concurrency guarantee. Original directory links are restored only
when unrelated private changes would not be lost; the private pilot agent copy is retained.

Historical installer sources remain in Git. Use [HANDOFF.md](HANDOFF.md), not an older transaction's
launcher table, to establish the current adoption scope.

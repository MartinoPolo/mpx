# Applied account rollout

The automated structural rollout is authorized in `DECISIONS.md`. It does not authorize source
repository deletion, publication, or Orca deployment.

## Current routing

| Command | Route |
| --- | --- |
| `pi` | MPX2 personal, accepted pilot |
| `piw` | MPX2 work |
| `ccw` | MPX2 work Claude |
| `cc` | Unchanged; personal Claude live checks deferred |
| `lpi`, `lpiw` | Temporary direct legacy Pi recovery launchers |
| `lccw` | Temporary direct work-Claude recovery launcher |
| `xpi`, `xpiw`, `xccw` | Removed; previously installed MPX is no longer exposed |

A fresh Git Bash shell loads these functions. Existing shells retain their old definitions until
refreshed. Installed MPX strips Git Bash shell markers, causing Claude's Bash-style hooks to be
parsed by PowerShell. MPX2 preserves them; Orca commands were not modified to hide this defect.
Installed MPX also does not understand converted project manifests. Original direct launchers are
the retained fallback, not evidence that installed MPX supports the new manifest. They retain original
routing, not independent profile snapshots: account data is shared by approval. Exact pre-migration
resource state requires the scoped recovery below.

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
not claimed as recovered. Personal Claude authentication/inference was explicitly deferred by the
user. These checks do not establish physical reboot, interactive keyboard behavior, or Orca restart
and notification acceptance.

The work manifest change is mechanical: project ID, GitLab repository, KanbanFlow board/states, and
Yarn remain intact. The sibling workspace marker and project-authored native skills are untouched.

## Protected recovery

Each protected single-file script defaults to preview. Add `--apply` only for deliberate recovery;
newer file edits are refused rather than overwritten. Recover routing before configurations and
account surfaces. Preserve all protected artifacts until migration acceptance is complete.

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

## Remaining retirement boundaries

Continue semantic review during ordinary work. Retain original sources, dirty/untracked legacy
state, native histories, and direct fallback launchers. Legacy dependency reconciliation, publication,
source archival/deletion, physical resurrection, and paired Orca changes remain separate gates.

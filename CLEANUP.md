# Legacy cleanup follow-up

Review after a week of normal use, fresh launches, and session restoration. This is a temporary
machine-local cleanup checklist; remove it when retirement is complete. Resolve `${MPX_*}` from the
environment. Do not publish backup contents, credentials, or transcripts.

## Current routing

- Canonical source: `${MPX_PROJECTS}/mpx`; remote `MartinoPolo/mpx` remains active.
- `mpx2` also points to that remote: never archive the remote based on its local folder name.
- `MartinoPolo/mpx-claude-code` and `MartinoPolo/mpx-pi` are already archived on GitHub.
- The project rule links in `low-poly-2d-trees` and `template-sveltekit` now target
  `mpx/dist/claude/rules/projects`. Differences were formatting, scope/selector metadata, and
  MPX helper naming, not substantive rules. Grovekeeper was deliberately left unchanged.
- Legacy Pi profile links and `~/.pi/LEGACY-PROFILES.md` were removed. Profile data remains;
  these profiles are not supported launch targets.
- Claude uses only `mpx-terse`; the old account-local `mp-terse.md` styles were removed.
- User `MPX_PATH_PREPEND` was removed. Existing processes may retain inherited values.
- `mpx-ports` and `mpx-worktrees` are standalone utilities, not retired-runtime dependencies.
  Keep `wtr`; its list and picker-row smoke checks passed. Their shell/Terminal routes remain.
- Noninteractive `pi` can resolve to an fnm native shim before the MPX wrapper. Automation needing
  MPX should invoke `${MPX_PROJECTS}/mpx/bin/pi` explicitly.

## Deferred locations

| Location | Disposition / preservation requirement |
| --- | --- |
| `${MPX_PROJECTS}/mpx2` | Archive intact after preserving untracked `HANDOFF.md`, ignored evidence, and the nested `.local/personal-acceptance-project` fixture. Its remote is the current MPX repository. |
| `${MPX_PROJECTS}/mpx-claude-code` | Archive intact; retain the `codex try` stash. Grovekeeper still has rule links into this folder; breakage there is accepted, not an active-project migration task. |
| `${MPX_PROJECTS}/mpx-pi` | Archive intact. Its local final commit is preserved remotely on `legacy/final-local-state`, not remote `main`. |
| `${MPX_PROJECTS}/_archive/mpx-source-20260920-141912` | Old source checkout includes a notification-payload stash, an installer branch, and ignored editor/build material. Compare against the Git bundles and retain unique ignored files before deletion. |
| `${MPX_PROJECTS}/_archive/mpx-legacy-2026-09-15T19-46-11.143Z` | Archive-record-only directory; keep the record with the retained recovery inventory before removing it. |
| `${MPX_PROJECTS}/_archive/mpx-legacy-2026-09-15T19-46-45.356Z` | Retired installation plus local/roaming state, including sessions and configuration. Do not treat it as only reproducible dependencies. |
| `${MPX_PROJECTS}/mpx-recovery` | Older recovery snapshots and patches, not a Git repository. Preserve unique patches/configuration before removal. |
| `${MPX_APPS}/_backups/mpx-legacy-git-*` | Verified Git bundles plus full Git snapshots preserve branches, stashes, and reflogs. Keep a verified recovery copy; matching bundle refs alone do not prove full snapshots redundant. |
| `${MPX_APPS}/_backups/mpx2-*` | Pilot, account rollout, hook, configuration, and launcher transactions. May contain unique native/profile data and modified legacy files. Retire after comparing with the final cutovers. |
| `${MPX_APPS}/_backups/mpx-final-cutover-*`, `mpx-location-cutover-*`, `mpx-native-name-cutover-*`, `mpx-adoption-sync-*` | Keep through acceptance. They preserve protected configuration/registration changes; review targets before any recovery. |
| `${MPX_APPS}/_backups/mpx-cleanup-retained/local-evidence` | Former canonical `.local/`, moved intact and hash-verified. Contains recovery pointers/scripts and acceptance evidence. Sibling `local-evidence.sha256.json` records hashes. No live runtime depends on it. |
| `~/.pi/agent-legacy`, `~/.pi/agent-work-legacy` | Retired profile wiring removed. Preserve remaining auth/session data unless explicitly choosing to discard it. Do not merge whole profiles over current accounts. |
| `~/.pi/agent/extension-backups`, `extensions-disabled` | Review inactive extensions for unique local work before deletion. |
| `~/.agents/skills.bak`, `~/.agents/native-skill-exports` | Compare legacy skill content with canonical content before deleting. Preserve unrelated `~/.agents/private` resources. |
| Native account `*.mpx2-*-original`, `skills.mpx2-*-original`, and shell backup files | Historical rollback material. Review individually; avoid broad account-directory cleanup. |
| `${MPX_AI_GENERATED}/_MPX/launch-registration-2026-09-16` | Historical reports, configuration backups, and old verification scripts. Do not rerun scripts against current configuration without updating them. |
| `${MPX_PROJECTS}/Grovekeeper` | Intentionally excluded. Old rule links and `src/lib/tauri_mock.ts` references can disappear with retirement of this outdated project. |

Orca and agent-resurrect backups are outside MPX cleanup. Current native sessions/transcripts and
historical path names are deliberately untouched. Existing sessions are not a retirement blocker
for this checklist. Do not rewrite saved transcript paths to make them look current.

## Before deleting retained material

- Verify fresh personal/work Pi and available Claude launches, then representative session
  restoration. Check cancellation and Orca attention behavior; previews alone do not establish them.
- Preserve unique untracked/ignored files separately from Git. A bundle does not contain them;
  `--all` includes the current stash ref but is not a replacement for all reflog history.
- Verify retained bundles with `git bundle verify`, inspect refs, and test recovery outside active
  account directories before deleting the only remaining copy.
- Move legacy source folders intact into the existing `${MPX_PROJECTS}/_archive` before permanent
  deletion. Do not create compatibility links that make old runtime paths silently active again.
- Recheck launch previews, current native links, `mpx status`, and `wtr --list`. Do not run historical
  installers or rollbacks as a cleanup mechanism.

Recovery guidance: [migration/ACCOUNT_ROLLOUT.md](migration/ACCOUNT_ROLLOUT.md).

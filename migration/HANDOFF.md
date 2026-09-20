# Final MPX adoption

## Accepted scope

- Canonical source is `$MPX_PROJECTS/mpx`, published to `MartinoPolo/mpx` on `main` with both
  repository histories preserved. PR #6 is merged; the legacy runtime GitHub repositories are archived.
- Use `mpx-` for MPX-owned skills and agents. Pi invokes `/skill:mpx-<name>`; Claude invokes
  `/mpx-<name>`. Preserve project resources and native discovery precedence.
- Current product branding, configuration, and registrations use MPX naming. Native account roots,
  credentials, historical backups, Git history, and saved transcripts are not renamed or rewritten.
- Keep the retained source checkout and protected backups until its sessions stop and replacement
  restart/resurrection acceptance passes. Agents must not move a running checkout or create worktrees.
- Personal Claude authentication is an accepted exception while its subscription is inactive.
  Recheck authenticated fresh/resume behavior if the subscription returns.
- `mpx-ports` and `mpx-worktrees` remain outside this retirement scope.

## Installed state

Protected routing targets canonical `mpx`: Bash/PowerShell launcher definitions, user PATH,
configured Pi executable, native instruction/agent/runtime links, Claude hooks/status lines, and the
owned Windows Terminal profile. Configuration lives at `$APPDATA/mpx/config.json`; native Pi uses
`extensions/mpx.ts` and Claude uses `rules/mpx`. Existing processes can retain old environment values
and loaded code until restarted; they are not evidence of fresh-launch routing.

Legacy installed MPX and direct `l*` recovery routes remain removed. `bin/xpi` is the native-only
launcher, not a legacy installation. Protected transaction pointers in canonical `.local/` identify
both the retained source checkout and recovery artifacts; see [account recovery](ACCOUNT_ROLLOUT.md).
Do not replay historical transactions against current paths without reviewing their targets.

## Remaining acceptance

1. Reopen a canonical `mpx` development session in Orca. Other projects retain their own working
   directories; launch replacement agents there rather than changing those projects to `mpx`.
2. Verify live cancellation and desktop attention. Orca remains the sole attention writer.
3. Save work, restart Orca, and restore representative personal/work sessions. Separately coordinate
   a Windows reboot and repeat restoration. Verify account, project, conversation, model, and
   recoverable effort; record unavailable state explicitly.
4. Stop sessions using the retained source checkout before moving or archiving it. Audit active
   routes and restore entries before retirement; keep protected backups through acceptance.

Saved transcripts and Orca restore entries can legitimately retain their original working directory.
Verify an explicit native resume at the new location or start a fresh session; never silently
substitute transcript paths. Naming recovery and source-version rollback must be coordinated.

## Verification boundaries

- Run typecheck, build, tests, and diff checks against final source. Verify fresh-shell routing,
  account/harness launch previews, physical skill sources, and scoped synchronization convergence.
- Native fresh/resume marker probes verify selected account/project/model continuity and catalogs,
  not unrestricted tools or saved Claude effort. Machine-local summaries record their tested revision.
- Fresh-process subagent waits, steering, resume, Context7, web search, and browser page listing have
  bounded acceptance evidence. Recheck after runtime changes; do not infer every provider or browser
  workflow from those probes.
- Close/reopen, cancellation, desktop attention, and reboot/resurrection require live acceptance.
- Orca aggregate patches are optional and remain undeployed without a demonstrated live defect;
  see [Orca integration](ORCA_INTEGRATION.md).

Mid-prompt skill autocomplete is a separate follow-up. Port cursor-aware behavior without restoring
retired runtime infrastructure; distinguish completion from submitted inline skill expansion.

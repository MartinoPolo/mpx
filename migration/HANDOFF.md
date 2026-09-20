# Final MPX adoption

## Accepted scope

- Publish this implementation into `MartinoPolo/mpx`, preserving both repository histories. Keep
  `main` as the destination branch; do not force-push or publish private recovery artifacts.
- Use `mpx-` for MPX-owned skills and agents. Pi invokes `/skill:mpx-<name>`; Claude invokes
  `/mpx-<name>`. Preserve project-owned resources and native discovery precedence.
- Make `$MPX_PROJECTS/mpx` the canonical checkout. Preserve the old source checkout intact before
  occupying its path. Use a clean user-created checkout and a protected routing switch rather than
  moving a running checkout and its dependencies.
- Retire `mpx-pi` and `mpx-claude-code` after preservation and dependency checks. `mpx-ports` and
  `mpx-worktrees` are outside this retirement scope.
- Personal Claude has no active subscription. Configuration, executable, hook, and launch checks
  are sufficient for adoption; authenticated inference is an accepted exception, not a blocker.
  Recheck authenticated fresh/resume behavior if the subscription returns.

## Installed state

`mpx`, `pi`, `piw`, `cc`, and `ccw` use the unified implementation in `$MPX_PROJECTS/mpx2` until the
location cutover. Inspected native instruction/agent links, hooks, and status lines use that checkout.
Legacy installed MPX and direct `l*` recovery routes have been removed. The remaining `bin/xpi` is
this implementation's native-only launcher, not a legacy installation. Scoped work-profile runtime
and Orca synchronization converged after protected backups. Fresh personal/work Pi catalog checks
resolved the renamed physical skill sources without extension errors; Claude hook checks passed
without provider requests.

Protected copies of legacy installations and Git state exist outside the checkout. Current backup
pointers and bounded acceptance evidence are in ignored `.local/`; see [account recovery](ACCOUNT_ROLLOUT.md).
Do not infer current installation state from the historical account-rollout transactions.

## Final location gate

1. Confirm publication through the configured Git remote and native GitHub PR state. Preserve current
   legacy branches, stashes, reflogs, unreachable objects, and any uncommitted files before archival.
2. Stop sessions using the old `$MPX_PROJECTS/mpx`, preserve that directory in the source archive, and
   have the user create/select a clean checkout of published `main` at that path through Orca. Agents
   must not create or switch worktrees. Keep the working `mpx2` installation intact for rollback.
3. From the selected canonical checkout, install pinned dependencies and rebuild. Prepare and review
   protected changes to Bash/PowerShell launchers, persistent PATH, configured Pi executable, native
   resource links, runtime forwarders, Claude hooks/status lines, and owned terminal/project paths.
   Ordinary sync cannot rebind links or forwarding modules owned by another checkout; do not force it.
4. Apply only proven-owned replacements, with drift-checked backups and recovery. Keep
   `$APPDATA/mpx2/config.json` and internal registration names stable. Preserve unrelated packages,
   project resources, and native account data.
5. Verify fresh-shell routing, all account/harness launch previews, physical skill sources, and scoped
   synchronization convergence. Reopen Orca terminals from `mpx`. Keep `mpx2` intact until its sessions
   stop and close/reopen plus coordinated reboot/resurrection acceptance passes for the replacement.

Native transcripts are not rewritten to disguise a changed checkout path. Old `mpx2` sessions and
Orca resurrection entries may retain their original working directory; verify an explicit native
resume at the new location or start a fresh session rather than silently substituting paths.

## Verification boundaries

- Historical native fresh/resume acceptance exists for personal Pi, work Pi, and work Claude. Those
  probes do not establish the relocated installation or unrestricted tool/provider workflows.
- Run typecheck, build, tests, and diff checks against the final source. Verify discovery uses physical
  `mpx-` skill sources and preserves selected packs and project precedence.
- Complete fresh-process subagent waits, steering, resume, cancellation, and desktop attention checks.
  Exercise authenticated MCP/web/browser workflows through ordinary use.
- Close/reopen and coordinated reboot/resurrection acceptance remains a physical check. Preserve
  account, project, session, model, and recoverable effort; report unavailable state explicitly.
- Orca remains the only attention writer. Its optional aggregate patches are not required for adoption
  without a demonstrated live defect; see [Orca integration](ORCA_INTEGRATION.md).

Mid-prompt skill autocomplete is a separate follow-up after naming and location cutover. Port the
cursor-aware behavior without restoring the retired manifest/runtime infrastructure; distinguish
completion from submitted inline skill expansion.

# Pi notification repair — September 2026

## Outcome

The native personal and work profiles use repaired immutable release
`6cb1f17b99fc6ad42d53a0ace45a83d6f5d0dd7dadecdc924d66a900fe16df7f`.
The release-matched installer applied a reviewed receipt-bound upgrade and strict verification
reported healthy. Both profiles contain the new package exactly once; unrelated settings and
package entries were compared with pre-upgrade backups and preserved.

Restart existing Pi sessions to replace their loaded notification handlers. Restoring the missing
account WAVs also restored Ta-da for sessions still running the previous package.

## Root causes and attribution

The Pi port changed the lookup from the existing Claude WAV to an account-local Pi WAV, but did
not migrate that asset. Both Pi copies were absent, selecting the retained C5/E5 beep fallback.
The original Claude WAV and Windows `Media/tada.wav` have identical SHA-256 hashes.

The successful path edit is recorded at `2026-09-04T21:35:10.117Z` in parent Pi session
`01a06cc4-5008-7227-8708-26be8ce0f0f9`, worker `d4350567-f82a-4e8`, task
“Port canonical Pi package”. The resulting current-history commit is
`845a5f0084dc0d64dfaa420d3bb8c60b2589439d`, `feat(pi): vendor native extension sources`.
This was a migration omission, not an intentional new sound selection.

Completion notification previously depended only on a module-local child-context marker captured
at extension construction. It did not require a user-facing session, distinguish human requests
from automatic background-result runs, or notify for blocking UI prompts. The replacement policy
uses Pi's session UI/mode and input-origin contracts, waits for `agent_settled`, and allows later
settled handlers to enqueue continuations before checking final idle state.

## Deployment boundary

Current main is ahead of the installed migration and its `mpx setup` rejects the materialized
profiles without a legacy-detachment receipt. No receipt was fabricated, installer check bypassed,
or installed immutable file edited. No legacy-detachment code was changed.

Every payload hash in the prior release matched the dirty `fix/pi-skill-command-namespace`
worktree. Its source was copied to isolated detached worktree `pi-notification-deploy`, leaving the
original untouched. The release-matched `install intent`, `install plan`, confirmed `install apply`,
and `install verify --strict` route performed the upgrade. The private request was reconstructed
from the verified live receipt, preserving identity, executable, and projection selections.

The package verifier in that source snapshot also depended on the caller's working directory.
The existing main fix, `absWorkingDir: packageRoot`, was backported with its regression test.
The resulting release changes only Pi extension files; existing skill behavior is preserved.

## Source and evidence

- Canonical forward fix: `runtimes/pi/extensions/notifications.ts`, its guard-hook registration,
  PowerShell asset, and regression tests in this main checkout.
- Release-matched source: sibling worktree `mpx.worktrees/pi-notification-deploy`.
- Current-main verification worktree: sibling `mpx.worktrees/pi-notification-repair`.
- Private upgrade request, plan, result, strict verification, and pre-upgrade settings/receipt:
  `%LOCALAPPDATA%/mpx/notification-repair`.

The focused notification suite, complete release-matched Pi extension suite, package typechecking,
reproducible build/verification, and actual Windows playback script passed. Release payload and
account-settings comparisons found no unrelated changes. Existing interactive sessions still need
a restart and human confirmation of the audible completion/question behavior.

Do not rebuild the original namespace worktree over this release without carrying forward the
notification changes and cwd-independent release verification fix. No commits were made by this
repair. The broader migration handoff remains unresolved and was not accepted by this hotfix.

## Prevention

Before repairing a live runtime, resolve its installed package and source provenance from the
receipt rather than assuming the current checkout owns it. Test notification asset availability,
headless child silence, main completion, and blocking questions in the packaged configuration.

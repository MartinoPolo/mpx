# Migration status

## Summary

- **Daily routing:** personal Pi, work Pi, and work Claude use MPX and passed real-project native
  fresh/resume checks. Personal Claude is configured but live acceptance is intentionally deferred.
- **Content:** canonical skills, specialists, rules, and shared/provider instructions compile to
  committed Pi/Claude projections with structural validation.
- **Verification:** the full repository suite, typecheck, deterministic build, and diff checks pass.
  Provider marker probes verified selected account, project, session continuity, model, catalog, and
  owned hook evidence. Probe tools/MCP were disabled, so this is not every workflow's live acceptance.
- **Preservation:** native credentials/history, unrelated resources, legacy repositories, dirty state,
  temporary direct recovery launchers, and protected recovery artifacts remain intact. Installed-MPX
  `xpi`, `xpiw`, and `xccw` shell routes have been removed.
- **Orca parity:** personal and work Pi contain byte-identical Orca-owned status, prefill, and title
  extensions. Work Pi passed native fresh/resume afterward with no extension errors.
- **Retirement:** active legacy-consumer reconciliation, close/reopen and reboot/resurrection checks,
  publication, archive, and deletion remain separate work.

## Installed acceptance

| Route | State | Evidence |
| --- | --- | --- |
| Personal Pi / Prejemesi | Accepted | Real fresh/resume after removal of the obsolete project skill override |
| Work Pi / Yoursafe Components | Accepted | Real fresh/resume plus linked-worktree coverage |
| Work Claude / Yoursafe Components | Accepted | Real and fresh-shell `ccw` fresh/resume; observed Manual default; zero owned hook failures |
| Personal Claude | Deferred | Configuration and recovery retained; no active subscription |

Prejemesi's tracked project-local `mp-board-to-issues` was an older GitHub-specific workaround that
shadowed the canonical provider-neutral skill. After explicit approval, its three clean tracked files
were removed. Comparison exposed and repaired MPX's stale `→ #<N>` write-back wording so the skill now
uses the shared `issue:<id>` convention expected by `batch-execute`. A real Prejemesi fresh/resume probe
then resolved `mp-board-to-issues` from the MPX development pack.

Exact machine-local artifacts and rollback order are documented in
[ACCOUNT_ROLLOUT.md](ACCOUNT_ROLLOUT.md). The protected recovery scripts preview by default and refuse
to overwrite newer edits. Do not restore whole native profile directories.

## Issues found and resolved

- Claude's Windows Node loader required `file:` import URLs.
- The previous installed-MPX `ccw` route lost Git Bash identity and caused PowerShell to parse Bash hook
  syntax. MPX launchers preserve it; Orca commands were not weakened.
- A real request exposed expired work-Claude authentication even though status reported logged in. Later
  authenticated probes passed.
- Native Pi command provenance and resume-marker assumptions in the acceptance runner were corrected.
- Protected writes were hardened against concurrent edits, linked ancestors, tampered plans/backups,
  partial compensation, bounded-read failures, Windows ACL differences, and retry-blocking candidates.
- A Windows cleanup fixture was intermittent during development. Scoped survivor checks and final reruns
  passed without weakening production cleanup policy.

## Remaining work

1. Inventory and disconnect active dependencies on `mpx`, `mpx-pi`, and `mpx-claude-code` while retaining
   recovery-only sources and native account data.
2. Verify close/reopen and one coordinated reboot/resurrection cycle.
3. Perform representative authenticated child-agent, MCP/web/browser, and normal workflow checks during
   ordinary use. Claude saved-effort recovery remains unproven because acceptance used an explicit low
   override.
4. Decide publication, branch promotion, archive, and deletion as separate operations.

## Optional Orca work

The undeployed aggregate candidate prevents Orca from treating a parent as complete while native child,
background, or follow-up work remains. The receiver candidate preserves Pi cancellation as **stopped**
instead of **finished**. Normal stopped notifications are acceptable, so quiet-cancellation behavior is
not required. Deploy nothing unless current live Orca behavior demonstrates a problem worth fixing.

## References

- [Completion plan](../MIGRATION_PLAN.md)
- [Applied routing and recovery](ACCOUNT_ROLLOUT.md)
- [Canonical content coverage](COVERAGE.md)
- [Source inventory](INVENTORY.md)
- [Final migration handoff](HANDOFF.md)
- [Orca integration audit](ORCA_INTEGRATION.md)
- [Orca aggregate evidence](evidence-orca-compat.md)
- [Orca receiver evidence](evidence-orca-receiver.md)

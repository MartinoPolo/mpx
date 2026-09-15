# Migration completion plan

This plan tracks the remaining transition from legacy MPX repositories to this checkout. Durable
product choices are in [DECISIONS.md](DECISIONS.md); current evidence and recovery are under
[`migration/`](migration/PROGRESS.md).

## Acceptance already required for daily routing

A launcher may select MPX only after its account/harness passes:

- exact account and registered project resolution;
- native fresh launch and session resume;
- selected-pack discovery with exact physical skill sources;
- native project/account resources retained alongside MPX packs;
- model and observable permission/effort state reported without silent substitution;
- installed hook startup without transport failures;
- owned-process cleanup and bounded evidence collection; and
- protected, scoped recovery that preserves newer account data.

Fixture output or model self-report alone is insufficient. Personal Claude live acceptance may remain
deferred while that account has no subscription.

## Complete the active installation

1. Keep personal/work Pi and work Claude on their accepted MPX launchers.
2. Update generated content and installed account resources only through deterministic build and scoped
   synchronization.
3. Keep direct recovery launchers and protected backups until restart/recovery acceptance is complete.

## Reconcile legacy dependencies

Before archiving `mpx`, `mpx-pi`, or `mpx-claude-code`, classify every remaining consumer:

- shell launcher or function;
- native extension, hook, skill, agent, or settings entry;
- filesystem link or copied file whose update/recovery source is legacy;
- Orca registration or project setup command;
- project-local workflow or documentation reference;
- runtime import, package patch, test fixture, or recovery script; and
- credential/history location that merely shares a profile and must not be moved.

For each consumer, record **MPX**, **native/third-party**, **project-owned**, **recovery-only**, or
**remove**. Disconnect active legacy imports and registrations; do not delete project-owned resources
or account data. A legacy checkout is archivable only when daily launchers, native startup, project
configuration, and recovery no longer require its working tree.

## Operational verification

Automate where practical:

- fresh shell routing and versions;
- real-project fresh/resume for each active account/harness;
- status/synchronization convergence and conflict reporting;
- representative native child-agent and selected-pack propagation;
- installed safeguards and hook error inspection; and
- close/reopen session continuity.

Human checks are limited to behavior automation cannot establish reliably:

- interactive terminal keys, scrolling, links, questions, and footer presentation;
- real desktop attention/status behavior in Orca;
- workflow semantics and compaction-summary quality during normal work; and
- one coordinated reboot/resurrection test.

Ordinary manual-cancellation notifications are acceptable; no quiet-cancellation feature is required.

## Orca boundary

Orca remains the sole owner of worktrees, terminals, server visibility, whole-session status, and
desktop notifications. The optional compatibility candidate aggregates parent, child, background, and
follow-up activity so Orca does not report completion while work remains. A separate candidate preserves
Pi's `interrupted` flag so Orca can label cancellation as stopped rather than finished.

Do not deploy either candidate merely to silence cancellation notifications. Deploy aggregate status
only if live behavior demonstrates premature or duplicate completion with the current installation.
Any deployment must update the sender and receiver as one reviewed change and verify that there is still
exactly one attention writer.

## Retirement and publication

1. Checkpoint each legacy repository's committed and dirty/untracked state without rewriting history.
2. Verify the dependency inventory has no unexplained active consumers.
3. Run the repository gate: `pnpm run typecheck`, `pnpm build`, `pnpm test`, and `git diff --check`.
4. Perform close/reopen and coordinated reboot/resurrection checks.
5. Publish this repository only to the explicitly confirmed remote/branch; do not force-push by default.
6. Archive legacy checkouts intact before considering deletion. Repository rename, remote promotion,
   archive, and deletion are separate explicit operations.

## Evidence

- [Current status](migration/PROGRESS.md)
- [Installed routing and recovery](migration/ACCOUNT_ROLLOUT.md)
- [Content provenance](migration/COVERAGE.md)
- [Initial source inventory](migration/INVENTORY.md)
- [Orca integration audit](migration/ORCA_INTEGRATION.md)
- [Final migration handoff](migration/HANDOFF.md)
- [Orca aggregate candidate](migration/evidence-orca-compat.md)
- [Orca cancellation receiver candidate](migration/evidence-orca-receiver.md)

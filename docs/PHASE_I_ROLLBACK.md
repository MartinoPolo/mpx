# Phase I rollback and uninstall

## Automatic installer rollback

Installer operations are ordered and snapshot before mutation. On failure, restore completed and attempted targets in reverse order, preserve the applying journal until restoration succeeds, then mark/remove the rolled-back journal. File snapshots are exact bytes. Native resources are removed only when their MPX owner marker and desired digest still match.

The active-release selector is not a normal transaction operation. The production orchestrator atomically activates it only after every release-bound operation commits and actual-state verification passes, so a crash or failure before commit cannot expose the release. Atomic replacement preserves the prior selector if activation fails. Uninstall removes the exact owned selector after receipt-owned resources are removed; a drifted selector or owned target is never force-deleted.

A machine lock serializes apply, recovery, rollback, and uninstall across processes. A lock may be reclaimed only when its structured PID owner no longer exists. Malformed locks and locks for live or inaccessible processes fail closed.

## Uninstall procedure

1. Run `mpx install verify --strict` and retain the structured result.
2. Produce the uninstall plan and review every exact target.
3. Supply the plan's exact confirmation digest.
4. Remove only receipt-owned resources. Legacy scheduled tasks are outside current ownership and remain untouched.
5. Confirm the receipt, journal, temporary files, lock, and active selector are absent; immutable release directories may remain as content-addressed evidence.
6. Re-run `mpx install verify`. Expected uninstalled state is structured unhealthy with `receipt-missing`.

If any target is missing, foreign, or digest-drifted, stop. Preserve it and restore from the recorded byte/native snapshot only after ownership is established.

## Manual integrations

External integrations are never included in automatic rollback:

- **Git remotes:** identify the repository-scoped confirmation digest, restore the exact reviewed `.git/config` bytes, then run argv-only `git remote -v`.
- **Authentication and hosted repository changes:** use provider-native recovery and re-run the bounded route/checklist verifier.

Never infer ownership over credentials, sessions, native runtime roots, unrelated Terminal entries, shell profile bytes outside the MPX block, notes, remotes, or application settings.

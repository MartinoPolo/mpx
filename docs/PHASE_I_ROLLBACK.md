# Phase I rollback and uninstall

## Automatic installer rollback

Installer operations are ordered and snapshot before mutation. On failure, restore completed and attempted targets in reverse order, preserve the applying journal until restoration succeeds, then mark/remove the rolled-back journal. File snapshots are exact bytes. Native resources are removed only when their MPX owner marker and desired digest still match.

The active-release selector is an owned transaction operation, not an after-commit callback. Consequently failed apply removes/restores it and uninstall removes it under the same lock as other resources. A selector or owned target that drifted is never force-deleted.

A machine lock serializes apply, recovery, rollback, and uninstall across processes. A lock may be reclaimed only when its structured PID owner no longer exists. Malformed locks and locks for live or inaccessible processes fail closed.

## Uninstall procedure

1. Run `mpx install verify --strict` and retain the structured result.
2. Produce the uninstall plan and review every exact target.
3. Supply the plan's exact confirmation digest.
4. Remove only receipt-owned resources. Scheduled capture is removed before earlier automatic resources as reverse restoration requires.
5. Confirm the receipt, journal, temporary files, lock, and active selector are absent; immutable release directories may remain as content-addressed evidence.
6. Re-run `mpx install verify`. Expected uninstalled state is structured unhealthy with `receipt-missing`.

If any target is missing, foreign, or digest-drifted, stop. Preserve it and restore from the recorded byte/native snapshot only after ownership is established.

## Manual integrations

External integrations are never included in automatic rollback:

- **Git remotes:** identify the repository-scoped confirmation digest, restore the exact reviewed `.git/config` bytes, then run argv-only `git remote -v`.
- **Obsidian:** restore every reviewed path from its byte-or-absence snapshot as one batch, including rename destinations, then verify only that reviewed list.
- **Raycast:** use Raycast's native restore workflow and produce a fresh encrypted derivative containing only reviewed IDs/categories for comparison.
- **Authentication and hosted repository changes:** use provider-native recovery and re-run the bounded route/checklist verifier.

Never infer ownership over credentials, sessions, native runtime roots, unrelated Terminal entries, shell profile bytes outside the MPX block, notes, remotes, or application settings.

# Migration baseline

The consolidated [migration authority](../MPX_MIGRATION.md) records acceptance. Historical snapshots use schema-2 immutable file capture; native-integration gates remain pending.

The first migration snapshot was captured before source or machine integration changes. The latest verified snapshot is under `%LOCALAPPDATA%/mpx/migration-snapshots`; its `manifest.json` records source revisions, remotes, working-tree state, selected integration files, environment bootstrap paths, and scheduled-task metadata. Repository history bundles, tracked binary patches, and untracked-file archives make dirty source state recoverable without changing the source repositories.

## Source boundaries

| Source            | Captured revision                          | Migration role                                  | Baseline state                                      |
| ----------------- | ------------------------------------------ | ----------------------------------------------- | --------------------------------------------------- |
| `mpx-claude-code` | `418b11e586cb93c29ee6a690210b2380179e82ac` | Claude content, hooks, status, worktree modules | Dirty; archived, left untouched                     |
| `mpx-pi`          | `95d64232f1a4563bec8c1a819eed5b299f136d11` | Pi adapters and lifecycle events                | Dirty and ahead of remote; archived, left untouched |
| `mpx-ports`       | `be104c48180ca08694f8cd5a9c6e437008e6ab8c` | Windows process inspection reference            | Clean                                               |
| `mpx-worktrees`   | `6cdf8f8c2731015789f93abd687c834091c1c661` | Worktree selection and removal reference        | Clean                                               |
| `agent-resurrect` | `30184715798938aaf76966f1a796b96c3b53e2cf` | Session migration source                        | Dirty; archived, left untouched                     |
| `kanbanflow-cli`  | `84bc4b859bdfcf95f0112d817d55621454b6bbec` | Independent KanbanFlow credential owner         | Clean and ahead of remote                           |

Dirty source repositories are intentionally archived rather than cleaned or committed by this migration. MPX must not overwrite or normalize user-owned changes.

## Recovery

1. Verify the snapshot `VERIFIED` marker and hashes in `manifest.json`.
2. Restore committed history from `repositories/<name>/history.bundle` when the original repository is unavailable.
3. Apply `tracked.patch` to the captured revision for tracked working changes.
4. Restore files from `repositories/<name>/untracked` only to their recorded relative paths.
5. Restore machine integration files only through a reviewed installer inverse operation.

Native credentials, provider tokens, Claude/Pi session stores, and unrelated private notes are deliberately excluded from copied snapshot content.

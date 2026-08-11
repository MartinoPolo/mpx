# Migration rollback

MPX installation changes are preceded by timestamped snapshots under `%LOCALAPPDATA%/mpx/migration-snapshots`.

Rollback remains component-specific until cutover:

- Keep legacy repositories and remotes unchanged and read-only from MPX.
- Keep legacy shell/plugin/runtime activation in place until `mpx install verify` passes.
- Restore managed files from the snapshot manifest only after verifying the destination path and hash.
- Re-import scheduled-task XML through Windows Task Scheduler.
- Preserve native Claude and Pi credentials, sessions, and caches; MPX must never overwrite them.

Each installer mutation must document its inverse in the install plan before apply is allowed.

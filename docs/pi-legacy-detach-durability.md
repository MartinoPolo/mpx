# Pi legacy detach durability boundary

`PiLegacyDetachService` is a standalone migration service. It is intentionally not
registered with the generic production installer or uninstaller.

The service reduces process- and power-interruption risk by:

- syncing every staged regular file after its bytes are written;
- writing journals and receipts to a new temporary file, syncing that file, and then
  atomically renaming it;
- syncing containing directories after creates, renames, and removals where the host
  supports directory handles; and
- recording completion only after the corresponding filesystem mutation returns.

Directory fsync is not portable on Windows. Node/libuv can report `EISDIR`, `EINVAL`, or
`EPERM` when opening or syncing a directory there; only those unsupported-operation
results are tolerated, and other directory-sync failures fail the migration closed.
Regular-file sync failures are never tolerated.

These measures do **not** promise survival from every power loss. Atomic rename and
flush behavior ultimately depends on the filesystem, storage driver, device write
cache, and operating system. Portable Node APIs cannot force Windows directory
metadata to stable storage when directory handles are unsupported.

The unit crash matrix exercises every journal/mutation boundary at early and late
entries in both roots and verifies deterministic recovery. It simulates abrupt process
termination after an operation returns; it is not a hardware power-cut or storage-cache
test.

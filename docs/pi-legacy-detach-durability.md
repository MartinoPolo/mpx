# Pi legacy detach durability boundary

`PiLegacyDetachService` is a standalone migration service. It is intentionally not registered with the generic
production installer or uninstaller.

Setup invokes this service only on the initial path after confirming the absence of current-installation evidence. An
authenticated current package installation instead uses receipt-owned installer operations and preserves native legacy
links outside that ownership boundary. This routing does not broaden the exact legacy inventory or add a mixed-state
detacher. Partial or inconsistent current evidence blocks setup before obsolete-state reset or detachment; it is never
treated as an initial installation.

Installer transaction recovery runs under its existing lock before setup admission. After recovery, strict receipt,
release, selector, native registration, and package checks determine the route. The admitted evidence is bound to the
subsequent plan and checked again under the apply lock. Existing Pi settings locator compatibility remains unchanged;
legacy ownership receipt migration still requires its separate authority.

The service reduces process- and power-interruption risk by:

- syncing every staged regular file after its bytes are written;
- writing journals and receipts to a new temporary file, syncing that file, and then atomically renaming it;
- syncing containing directories after creates, renames, and removals where the host supports directory handles; and
- recording completion only after the corresponding filesystem mutation returns.

Directory fsync is not portable on Windows. Node/libuv can report `EISDIR`, `EINVAL`, or `EPERM` when opening or syncing
a directory there; only those unsupported-operation results are tolerated, and other directory-sync failures fail the
migration closed. Regular-file sync failures are never tolerated.

These measures do **not** promise survival from every power loss. Atomic rename and flush behavior ultimately depends on
the filesystem, storage driver, device write cache, and operating system. Portable Node APIs cannot force Windows
directory metadata to stable storage when directory handles are unsupported.

The unit crash matrix exercises every journal/mutation boundary at early and late entries in both roots and verifies
deterministic recovery. It simulates abrupt process termination after an operation returns; it is not a hardware
power-cut or storage-cache test.

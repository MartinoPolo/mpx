# Installation

Configure `%APPDATA%/mpx/config.json`, set the required `MPX_*` machine roots, then run:

```bash
mpx setup
```

`mpx setup` validates and repairs the currently installed immutable release. It does not build changes from the directory where you run it. Installed releases are checked against their complete content-addressed manifest without requiring development dependencies.

## Install changes from the Windows checkout

From the MPX repository in Git Bash, run:

```bash
pnpm run setup
```

This builds and verifies the Pi extension, bundles the CLI, then publishes, selects, and strictly verifies the new immutable release. A failed build stops before installation. The setup wrapper reads missing MPX values from your existing Windows user environment; it does not add or persist environment variables. Repository dependencies must already be installed (`pnpm install` for a fresh checkout).

Use `pnpm run setup`, not `pnpm setup`: the latter is pnpm's own shell-configuration command. After setup succeeds, restart your MPX runtime to load the new release. Native account data and credentials remain untouched.

## Ownership and safety

- Setup changes only receipt-owned MPX resources.
- Native credentials, sessions, account roots, launchers, extensions, settings, Windows Terminal profiles, and unrelated files remain user-owned.
- Existing evidence is validated before mutation. Missing, corrupt, stale, foreign, partial, or concurrently changed ownership fails closed.
- The sole mutable exception is an existing receipt-owned `%APPDATA%/mpx/config.json`: setup may adopt exact, fully valid requested config bytes at the same ownership-bound path without rewriting them. Concurrent edits and all other drift still fail closed.
- Pending authorized transactions recover under the installer lock. Failed applies roll back automatically from durable journals and snapshots.
- Planning, rollback, recovery, and legacy detach are internal to `mpx setup`; there are no public rollback, uninstall, or external-action commands.

A fresh installation may perform the narrow legacy Pi-link detach defined in [ADR 0002](adr/0002-no-permanent-legacy-readers.md) and [the durability contract](pi-legacy-detach-durability.md). Normal operation never reads legacy configuration.

## Installed entrypoints

Production releases contain the bundled CLI and use `%MPX_APPS%/mpx/bin/mpx.cmd` as the stable selector for the active immutable release. Managed aliases are `cc-mpx`, `ccw-mpx`, `pi-mpx`, and `piw-mpx`; native `cc`, `ccd`, `ccw`, `ccwd`, `pi`, and `piw` are never replaced.

The standard aliases currently select explicit Windows host execution with one-use approval. Host mode is not sandbox isolation. Docker execution is unavailable and never falls back to host.

The production installer does not own Windows Terminal settings or Task Scheduler activation. Tests and simulations must use isolated temporary filesystems and platform fakes, never live profile or registry state.

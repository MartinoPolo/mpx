# Installation

Configure `%APPDATA%/mpx/config.json`, set the required `MPX_*` machine roots, then run:

```bash
mpx setup
```

`mpx setup` validates and repairs the currently installed immutable release. It does not build changes from the directory where you run it. Installed releases are checked against their complete content-addressed manifest without requiring development dependencies and are fully self-contained; installed selectors do not depend on local checkout `bin/mpx.mjs` or `bin/claude-gateway.js` artifacts.

`bin/mpx.mjs` and `bin/claude-gateway.js` in the source checkout are ignored generated files. The documented setup/build flow regenerates them before checkout binaries are used in release creation.

## Install changes from the Windows checkout

From the MPX repository in Git Bash, run:

```bash
pnpm run setup
```

This builds and verifies the Pi extension, bundles the CLI, then publishes, selects, and strictly verifies the new immutable release. A failed build stops before installation. The setup wrapper reads missing MPX values from your existing Windows user environment; it does not add or persist environment variables. In a fresh checkout, first install the exact locked dependency graph with `pnpm install --frozen-lockfile`; `pnpm run setup` already performs the required build and bundling, including regenerating `bin/mpx.mjs` and `bin/claude-gateway.js` for the release artifacts.

Use `pnpm run setup`, not `pnpm setup`: the latter is pnpm's own shell-configuration command. After setup succeeds, restart your MPX runtime to load the new release. Native account data and credentials remain untouched.

### Verify Pi startup after deployment

Setup verification and `mpx doctor` do not exercise native extension loading. Before reporting Pi loader startup healthy, launch the installed runtime and require a successful RPC `get_state` response without extension errors:

```bash
printf '{"id":"startup-check","type":"get_state"}\n' | mpx launch pi \
  --identity personal --executor host --workspace direct \
  --reason 'Verify installed Pi extension startup' --approve-host \
  --runtime-arg=--mode --runtime-arg=rpc
```

Use the intended configured identity. This no-prompt check proves that the installed extension loader reached RPC startup, but it does not prove managed-registry persistence or replace interactive UI verification. Pi defers session persistence until an assistant message is recorded; `set_session_name` alone is insufficient. Verify lifecycle registration only after a real assistant response through the normal account session path. `--no-session` and temporary session directories cannot satisfy managed lifecycle binding.

## Ownership and safety

- Setup changes only receipt-owned MPX resources.
- Native credentials, sessions, account roots, launchers, extensions, settings, Windows Terminal profiles, and unrelated files remain user-owned.
- Existing evidence is validated before mutation. Missing, corrupt, stale, foreign, partial, or concurrently changed ownership fails closed.
- The sole mutable exception is an existing receipt-owned `%APPDATA%/mpx/config.json`: setup may adopt exact, fully valid requested config bytes at the same ownership-bound path without rewriting them. Concurrent edits and all other drift still fail closed.
- Pending authorized transactions recover under the installer lock. Failed applies roll back automatically from durable journals and snapshots.
- Planning, rollback, recovery, and legacy detach are internal to `mpx setup`; there are no public rollback, uninstall, or external-action commands.

A fresh installation may perform the narrow legacy Pi-link detach defined by the [current-only contracts and migration policy](../decisions.md#current-only-contracts-and-migration) and [the durability contract](pi-legacy-detach-durability.md). Normal operation never reads legacy configuration.

## Installed entrypoints

Production releases contain the bundled CLI and use `%MPX_APPS%/mpx/bin/mpx.cmd` as the stable selector for the active immutable release. Managed aliases are `cc-mpx`, `ccw-mpx`, `pi-mpx`, and `piw-mpx`; native `cc`, `ccd`, `ccw`, `ccwd`, `pi`, and `piw` are never replaced.

The standard aliases currently select explicit Windows host execution with one-use approval. Host mode is not sandbox isolation. Docker execution is unavailable and never falls back to host.

The production installer does not own Windows Terminal settings or Task Scheduler activation. Tests and simulations must use isolated temporary filesystems and platform fakes, never live profile or registry state.

# Vendored `@tintinweb/pi-subagents` provenance

- Upstream: <https://github.com/tintinweb/pi-subagents>
- Upstream commit: `8976c63f9857fb308926dd1d7369c2b7e059ffdc`
- Upstream version: `0.14.3`
- License: MIT; reviewed full text is retained in [`LICENSE`](LICENSE).
- Maintained source: `MPX_PROJECTS/mpx-pi/extensions/subagents`
- Maintained repository snapshot: `9807adb547c64ecedf0091aec20e82627842da33`
- Content hashes: [`SHA256SUMS`](SHA256SUMS) (SHA-256 over every retained source/license file).

This is an inert, reviewed source snapshot for Phase F1. It is deliberately outside the
`@mpx/runtime-pi` TypeScript root and is not imported or registered by the runtime index.
Runtime activation must adapt the provider-neutral `@mpx/subagents` contracts rather than
register this extension directly.

The maintained source had uncommitted reviewed model-snapshot work. That work is included
in this content-addressed snapshot: `VENDORED.md`, `agent-manager.ts`, `agent-runner.ts`,
`index.ts`, `invocation-config.ts`, `model-resolver.ts`, `types.ts`,
`ui/agent-widget.ts`, and new `invocation-config.test.ts`.

The source package declares `croner` and `nanoid`, but this inert snapshot is neither built
nor executed and therefore installs neither dependency. If activation later proves they
are required, the reviewed versions are `croner@10.0.1` and `nanoid@5.1.16`; activation
must pin exact versions through the workspace lockfile.

`worktree.ts` is retained solely as provenance. It is unsafe for MPX activation because it
executes Git and performs source-specific cleanup. Supported execution uses
`StrictWorktreeIsolation` from `@mpx/subagents`, which delegates only to durable
`@mpx/worktrees` lifecycle adapters, treats isolation/cleanup failures as fatal, never
falls back to a shared CWD, never commits, and never bypasses hooks.

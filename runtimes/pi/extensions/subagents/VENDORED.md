# Vendored source: `@tintinweb/pi-subagents`

#### : Upstream

- **:** https://github.com/tintinweb/pi-subagents

#### : Commit

- **:** `8976c63f9857fb308926dd1d7369c2b7e059ffdc` (2026-07-31,
  `feat: add opt-in nested subagent delegation (#164)` )

#### : Version

- **:** 0.14.3

#### : License

- **:** MIT © 2026 tintinweb — full text in [`LICENSE`](./LICENSE)

This fork is maintained in place so upstream or Pi releases cannot silently change subagent
behavior. The files in this directory are the canonical MPX source; generated installations must
project them from this repository rather than downloading or maintaining another copy.

## Package layout

The parent `@mpx/pi-extensions` package owns the runtime:

- [`../index.ts`](../index.ts) imports and registers the subagent component as part of the static
  root composition. This directory is not independently discovered as a Pi extension.
- Dependencies are declared and lockfile-managed by the workspace through
  [`../package.json`](../package.json). There is no nested `package.json` or separately managed
  dependency tree here.
- Tests live under [`../test/unit/subagents`](../test/unit/subagents), alongside the package's other
  unit suites rather than inside this vendored directory.
- The package contains no `agents` symlink. Agent definitions are resolved from the configured
  project, workspace, and Pi agent directories at runtime.

## MPX changes

Every edit to upstream TypeScript carries a `VENDOR EDIT (mpx-pi, …)` comment, so searching this
directory for `VENDOR EDIT` identifies the maintained diff surface.

The fork adds MPX model-resolution and invocation snapshots, model/thinking display in the agent
widget, completion notification gating, grouped cancellation handling, nested delegation policy, and
integration with the root extension's shared lifecycle bus. The root footer consumes only the
published `subagents:completed` and `subagents:failed` events; live manager state remains private to
the subagent component.

## Re-syncing with upstream

```bash
git clone --depth 1 https://github.com/tintinweb/pi-subagents.git /tmp/pi-subagents
diff -r /tmp/pi-subagents/src ./subagents \
  --exclude=LICENSE --exclude=VENDORED.md
```

Review every difference against the MPX changes above and update the pinned upstream commit after a
re-sync.

# Pi extension prototype — not installed

The MPX2 package pins Pi **0.85.1** and upstream `@tintinweb/pi-subagents` **0.19.0** locally.
The running migration bootstrap uses its separate installed 0.14.3 artifact; neither that artifact
nor global settings/extensions were modified. The 0.19.0 npm artifact was resolved explicitly,
not assumed from GitHub metadata. No upstream source has been forked or patched in MPX2 yet.

## Demonstrated gap

```bash
node migration/upstream-probe.mjs
```

This creates a disposable Git repository/account, loads the published upstream named-preload
helper through Pi's native extension loader, and contributes a selected skill through
`resources_discover`. No prompt or provider request is made.

Observed:

- Before binding: `native-project` only.
- After binding: `native-project` and `mp-selected`.
- Upstream named preload: `mp-selected` **not found**.

Upstream calls `preloadSkills(skills, configCwd)` before creating/binding the child
`DefaultResourceLoader`. Its private named lookup uses fixed native roots and rejects links;
the later resource event cannot populate that earlier lookup. A resource-discovery adapter alone
therefore cannot meet the mandatory named-preload contract. A narrowly approved upstream change
must propagate selected paths into both discovery and named preloading while retaining native
project trust/resources. This is an open acceptance gate, not approval to replace installed forks.

The first draft probe's direct tsx/CJS import failed; that was not proof of native incompatibility.
The corrected probe uses native extension loading. A first non-Git fixture also exposed ancestor
user skill metadata; adding the fixture Git boundary prevented that. The final probe asserts the
exact two-skill catalog and never executes legacy skills or extensions.

## Still untested or unimplemented

- New-runtime background/steering/result/cancellation lifecycle and actual named model/effort.
- Selected packs in actual child conversations, named preloading, and concurrent children.
- Finished footer metrics, running-agent display, compaction visibility and cancellation.
- Canonical compaction/style/machine-root transports and their fallback behavior.
- Native-account MCP/web/question effective loading for both accounts.
- Title generation/fallback/manual names, physical wheel behavior and newline bindings.
- One aggregate Orca activity/attention path, hook mirroring, and duplicate-alert disconnection.

Native tool rendering is the approved V1 choice; no tool-display fork, dev-server manager,
worktree service, scheduler, session registry, or status/notification authority was added.

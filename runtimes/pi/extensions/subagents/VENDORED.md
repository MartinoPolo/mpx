# Vendored: `@tintinweb/pi-subagents`

|          |                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| Upstream | https://github.com/tintinweb/pi-subagents                                                                     |
| Commit   | `8976c63f9857fb308926dd1d7369c2b7e059ffdc` (2026-07-31, `feat: add opt-in nested subagent delegation (#164)`) |
| Version  | 0.14.3                                                                                                        |
| License  | MIT © 2026 tintinweb — full text in [`LICENSE`](./LICENSE)                                                    |

Forked rather than installed (`pi install npm:@tintinweb/pi-subagents`) so that a pi or
upstream release cannot silently change subagent behaviour, and so Phase 7 can add the
model/thinking columns to the widget in place.

## Edits made to upstream

Every edit to upstream TypeScript carries a `VENDOR EDIT (mpx-pi, …)` comment, so
`grep -rn "VENDOR EDIT" .` lists the full diff surface at any time.

1. **Layout** — upstream `src/*` is vendored flat into this directory, so the pi
   extension-discovery rule `extensions/*/index.ts` picks it up. All intra-package imports are
   relative and survive the move unchanged.
2. **`package.json`** — reduced to the fields pi reads plus the two runtime dependencies.
   `pi.extensions` points at `./index.ts` instead of `./src/index.ts`; the local `test` script runs
   the fork's regression tests with Node's TypeScript stripping.
3. **Resolved model display** — `model-resolver.ts`, `invocation-config.ts`, and
   `invocation-config.test.ts` cover model resolution and display snapshots, while
   `agent-manager.ts` and `agent-runner.ts` share that policy across spawn paths.
   `types.ts` defines the `AgentRecord` invocation contract, and `index.ts` preserves it in
   completion lifecycle events and scheduled jobs. Inherited, pinned, scheduled, nested, and RPC
   runs all retain their actual model in the invocation snapshot.
4. **`ui/agent-widget.ts`** — new exported `buildModelThinkingCells()`, called from both
   `renderFinishedLine()` and the running-agent header in `renderWidget()`. A glance at the
   panel shows which model is running and at what thinking level. The gauge vocabulary is
   imported from `../../footer.js` rather than redefined, keeping the panel and the main
   footer bar on one definition. The finished line's stats now go through
   `fgPreservingNestedStyles` (the cells carry their own colour).

5. **Completion notification gate** — `notification-gate.ts` holds background completion
   notifications while the parent agent or any top-level background agent is active. `index.ts`
   wires it to the parent lifecycle and live agent records, allowing `get_subagent_result` to
   consume results before unread notifications are sent as follow-ups. A concurrent background
   batch produces one continuation only after the final active agent settles; only the final
   message triggers that turn. `AgentManager` reports queued cancellations and `GroupJoinManager`
   removes canceled members so they cannot strand peer results. This replaces the upstream 200 ms
   timer, which could enqueue stale, unrecallable follow-ups during a long parent turn. The focused
   tests cover consumed, unread, grouped, canceled, active-background, idle, and shutdown behavior.

**Route taken (Phase 7 row 11).** The fork keeps its `AgentManager` and `AgentWidget`
private to the default export and its cross-extension RPC surface is only
`subagents:rpc:ping|spawn|stop`, so no outside extension can read live agent state. A
separate `extensions/subagent-panel.ts` was therefore impossible for the live columns, and
these in-place edits are the minimum diff. The footer's Σ tally needs no fork state: it
accumulates from the `subagents:completed` / `subagents:failed` events already published on
the shared bus.

**No path edit was needed for agent discovery.** `custom-agents.ts` already reads
`join(getAgentDir(), "agents")` → `~/.pi/agent/agents/`, which is the symlink to this repo's
`agents/`.

## Dependencies

`@earendil-works/*` and `@sinclair/typebox` are aliased by pi's own extension loader
(`dist/core/extensions/loader.js` → `getAliases()`), so they resolve with no `node_modules`.
`croner` and `nanoid` are not, and must be installed here:

Runtime dependencies are declared by the parent `@mpx/pi-extensions` package.

`node_modules/` is gitignored; re-run the install after a fresh clone.

## Re-syncing with upstream

```bash
git clone --depth 1 https://github.com/tintinweb/pi-subagents.git /tmp/pi-subagents
diff -r /tmp/pi-subagents/src ./subagents \
  --exclude=node_modules --exclude=package.json --exclude=LICENSE --exclude=VENDORED.md
```

The differences should be exactly the ones listed above — every one of them is marked with a
`VENDOR EDIT` comment except the `index.ts` header. Update the commit hash above after any
re-sync.

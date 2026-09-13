# Checkout-local Pi runtime — not deployed

MPX2 pins Pi **0.85.1** and `@tintinweb/pi-subagents` **0.19.0**. The migration's installed
0.14.3 bootstrap and active native accounts remain unchanged. Native Pi tool rendering is the V1
choice; the dirty tool-display fork is preserved, not selected for managed cutover.

## Composition and ownership

`pi-runtime.ts` composes canonical context, shared safeguards, awaited native edit/write formatting,
Pi UI, and the checkout-local upstream subagent package. It reads the optional `piTitle` selection
from the existing MPX2 user configuration. It adds no session registry, generated session content,
credential router, development-server manager, worktree service, or desktop-notification fallback.

| Component | Local implementation/evidence | Acceptance remaining |
| --- | --- | --- |
| Subagents | Pinned upstream; native parser and selected-pack child-loader tests | Real named model/effort, background steering/results/cancellation and interactive visibility |
| Context | `pi-context.ts`; shared manual/automatic compaction guidance, style, seven roots | Live generated summaries, installed accounts and child inheritance |
| Safeguards | `pi-safeguards.ts`; shared dangerous/package/staged-secret/Fallow policy | Installed interception and real permission/trust UI |
| Formatting | `pi-format.ts`; public native tool operations retain the native per-file queue | Physical terminal/account acceptance; optional at cutover |
| UI | `pi-ui.ts`; finished footer, aggregate event state, bounded configured title/fallback, terminal-specific wheel policy | Physical wheel/newline and real provider/title acceptance |
| Native packages | Read-only inspector and disposable native probes; native ownership preserved | Authenticated services and human question UI |
| Orca | Owned-hook mirroring; aggregate sink is injectable, not a second writer | Hook adaptation approval and single-writer live attention matrix |

The native installer previews/merges `treeFilterMode: "no-tools"`, upstream `showModel: true`, and
Shift+Enter/Ctrl+J/Ctrl+Enter newline bindings. It never disables unrelated packages automatically.
Project settings can still override native global subagent settings. Ctrl+Enter's known Orca routing
fix remains deferred; use Shift+Enter or Ctrl+J.

## Approved selected-pack patch

Tracked in `patches/@tintinweb__pi-subagents@0.19.0.patch`, applied using pnpm 11's
`pnpm-workspace.yaml` `patchedDependencies`. Only upstream `agent-runner.ts` and `skill-loader.ts`
change. Parent-native `getCommands()` skill provenance beneath stable `MPX_ACTIVE_CONTENT_ROOT`
supplies selected pack roots to both child `additionalSkillPaths` and named `preloadSkills`.
`isolated`/`skills: false` still disables skills. There is no shared-link mutation or per-session
selection environment protocol.

The unpatched native experiment demonstrated that `resources_discover` arrived too late for named
preloading. The patched probe drives real `runAgent` child sessions with only model streaming
stubbed: concurrent alpha/beta/empty selections, a disposable linked Git worktree, native project,
shared-global, account and unrelated-package resources, plus separate named-body assertions.

```bash
pnpm install --frozen-lockfile --ignore-scripts
node migration/upstream-probe.mjs
node --import tsx --test test/subagent-packs.test.ts
```

Frozen installation, inspected checkout-local applied source, and native fixture tests are evidence
of this local correction—not provider execution, physical UI acceptance, or authorization to replace
the installed bootstrap. See `migration/PROGRESS.md` and the linked per-slice evidence for current
verification and human gates.

# Pi runtime

`pi-runtime.ts` composes MPX context, safeguards, formatting, UI, and the checkout-local subagent
package for native Pi. It adds no credential router, session registry, development-server manager,
worktree service, or notification fallback.

## Components

| Component | Entry point | Purpose |
| --- | --- | --- |
| Context | `pi-context.ts` | Shared instructions, style, machine-root context, and compaction guidance |
| Safeguards | `pi-safeguards.ts` | Native transport for dangerous-command, Git, package-manager, staged-secret, and Fallow policy |
| Formatting | `pi-format.ts` | Awaited, bounded project formatter execution after native file changes |
| UI | `pi-ui.ts` | Native lifecycle state, footer data, title fallback, and terminal-specific behavior |
| Runtime | `pi-runtime.ts` | Activation guard and component composition |

The installer writes a physical forwarding module at the native account's `extensions/mpx2.ts`.
Do not replace it with a file symlink: Pi resolves relative imports from the registration path. The
forwarder activates only for an explicitly selected MPX account and checkout.

## Selected-pack subagents

MPX pins `@tintinweb/pi-subagents` and applies the reviewed patch in
`patches/@tintinweb__pi-subagents@0.19.0.patch`. The patch propagates the parent's selected MPX skill
roots to child discovery and named-skill preloading. Native project, account, package, and unrelated
skills remain discoverable; isolated or skills-disabled children remain isolated.

Update the patch only for a demonstrated upstream compatibility gap. Verify it with:

```bash
pnpm install --frozen-lockfile
node migration/upstream-probe.mjs
pnpm exec tsx --test test/subagent-packs.test.ts
```

## Ownership

Pi owns native settings, packages, model/auth state, transcripts, interaction behavior, and tool
rendering. MPX supplies thin adapters and selected content. Orca owns terminal/worktree visibility and
desktop attention; this runtime must not become a second notification writer.

Current rollout evidence and physical-verification limits belong in
[`migration/HANDOFF.md`](../migration/HANDOFF.md), not this package document.

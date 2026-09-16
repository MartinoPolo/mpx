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

## Footer links and reviews

The Pi footer keeps file links for the project and linked checkout, places the same VS Code icon as
Claude beside the project name to open the active checkout, and bounds long checkout and branch labels
without shortening their hyperlink targets. For a
repository whose `repository.provider` is explicitly configured as `github` or `gitlab`, it uses the
matching native CLI and configured remote to discover an open pull or merge request for the current
branch. The review link follows the effort indicator on the existing model row, without adding a row.
Missing CLIs, authentication, malformed responses, and branches without an open review remain silent.

Review discovery runs at footer startup, after branch changes, and approximately once per minute. It
does not run while rendering or on ordinary session updates. Use Pi's `/reload` after changing the
extension code; changing branches or waiting for the periodic refresh is enough for review state.
Launch-provided `GH_CONFIG_DIR` and `GLAB_CONFIG_DIR` bindings are inherited unchanged.

## Native cancellation

The maintained `@earendil-works/pi-coding-agent` patch adds a synchronous `session_abort` extension
event before public idle or active cancellation. Handlers must disarm recovery before returning;
the event adds no model message or desktop notification. Reentrant handlers and diagnostic failures
cannot prevent native cancellation. SDK/RPC abort and an otherwise unclaimed empty-editor Escape
use the same boundary; modal and custom-editor key behavior remains native.

The runtime activity adapter consumes this signal without posting to Orca. Restart Pi after changing
the native dependency patch; reloading extensions alone does not replace the running core.

```bash
pnpm exec tsx --test test/native-cancellation.test.ts test/subagent-coordinator.test.ts test/pi-ui.test.ts
```

## Quiet subagents

MPX pins `@tintinweb/pi-subagents` and maintains its compatibility changes in
`patches/@tintinweb__pi-subagents@0.19.0.patch`:

- Child loading excludes parent-only Orca status, titlebar, and prefill extensions before their
  factories execute, while preserving authorized tools, safeguards, and selected skills.
- Explicit model/thinking choices override named-profile defaults. Turn limits, native model scope,
  explicit denials, and inherited tool ceilings remain effective, including after child resumption.
- Global `maxSubagentDepth` permits bounded grandchildren without editing each profile. Independent
  per-depth concurrency pools prevent waiting parents from starving their children.
- Results stay outside the prompt while the parent works. `get_subagent_result` can join one agent
  with `agent_id` and `wait: true`, or ready siblings with `agent_ids` and `wait_for: "any"`.
- Idle recovery sends bounded useful results without completion cards or preview acknowledgements.
  Native persisted result receipts prevent automatic redelivery; intentional rereads remain available.
- Cancellation disarms automatic recovery. Saved native parent entries and child sessions support
  result inspection and provenance-checked explicit continuation after reload; interrupted children
  are not automatically restarted.

The patch still propagates the parent's selected MPX skill roots to child discovery and named-skill
preloading. Native project, account, package, and unrelated skills remain discoverable; isolated or
skills-disabled children remain isolated. No separate MPX session database or notification writer is
introduced.

The active native profile's `subagents.json` can slim unused tools while retaining saved sessions:

```json
{
  "workflowsEnabled": false,
  "schedulingEnabled": false,
  "worktreeIsolation": false,
  "rememberAgents": true,
  "maxSubagentDepth": 2
}
```

Merge these keys rather than replacing unrelated preferences. Project settings can override profile
settings. Start a fresh Pi process after dependency changes so both core behavior and tool schemas
are current. This does not deploy the optional Orca aggregate sender/receiver patches.

Update the patches only for demonstrated upstream compatibility gaps. Verify them with:

```bash
pnpm install --frozen-lockfile
node migration/upstream-probe.mjs
pnpm exec tsx --test test/native-cancellation.test.ts test/subagent-coordinator.test.ts test/subagent-isolation.test.ts test/subagent-policy.test.ts test/subagent-packs.test.ts
```

## Ownership

Pi owns native settings, packages, model/auth state, transcripts, interaction behavior, and tool
rendering. MPX supplies thin adapters and selected content. Orca owns terminal/worktree visibility and
desktop attention; this runtime must not become a second notification writer.

Current rollout evidence and physical-verification limits belong in
[`migration/HANDOFF.md`](../migration/HANDOFF.md), not this package document.

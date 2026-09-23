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
| Bash | `pi-bash.ts` | Default timeout for agent Bash calls that omit it |
| UI | `pi-ui.ts` | Native lifecycle state, footer data, title fallback, and terminal-specific behavior |
| Runtime | `pi-runtime.ts` | Activation guard and component composition |

The installer writes a physical forwarding module at the native account's `extensions/mpx.ts`.
Do not replace it with a file symlink: Pi resolves relative imports from the registration path. The
forwarder activates only for an explicitly selected MPX account and checkout.

## Footer presentation, links and reviews

The footer starts with its operational summary expanded and agent history collapsed. `/footer` or
`Ctrl+Alt+F` toggles the one-line footer; `/footer details` expands finished-agent details and
`/footer compact` returns to one line. Agent and model names use stable tier colors: Astra green, Sol
blue, Luna yellow, and Terra orange. The main footer model uses the same palette. Versioned family models display as `Terra 5.6`,
`Sol 6`, or `Luna 6` in the footer and agent rows; canonical identifiers remain available in
native records.
Fullscreen disclosure arrows perform the same actions without intercepting existing hyperlinks.
Compact context and quota values retain text colouring and reset countdowns without progress bars.
Finished history is reconstructed from native branch records, grouped by model and effort, and bounded
in both summary and detail views. Tokens include cache reads; prices are estimates and absent pricing
is omitted. The upstream zero-cost placeholder is not treated as proof of a known price.

Runtime sync sets `widgetMode: "off"` and `fleetView: false` in the selected account's `subagents.json`.
MPX uses lifecycle events for a bounded running-agent widget with a queued count, removing it when idle.
Running rows show labeled elapsed time and quiet time since the native agent's last recorded activity;
missing activity timestamps display `quiet unknown`. The widget refreshes both locally once per second
while a running agent has a valid start time. `get_subagent_result` waiting output also shows these
clocks for selected agents. Quiet time reflects only recorded activity, not proof that a child is idle
or hung; neither surface reads transcripts, exposes tool contents, or controls child execution.

The expanded Pi footer keeps file links for the project and linked checkout, places the same VS Code icon as
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

## Agent Bash timeout default

`pi-bash.ts` uses Pi's supported mutable `tool_call` input to set `timeout: 120` only when a `bash`
call omits it. Explicit values are untouched and remain subject to Pi's native validation. There is
no additional override ceiling, tool replacement, settings reload, output cap, or subprocess backend.
Native tool selection, shell settings, output, and cancellation/cleanup mechanisms remain intact.
Previously unbounded calls now reach native timeout cleanup after the default deadline; successful
background launches receive no additional cleanup. Choose an explicit longer timeout for long operations.

The hook applies where the MPX extension is loaded, including non-isolated children loading it;
not extension-disabled/isolated agents, direct SDK execution, other tools, or human `!`/`!!` commands.
Another extension can modify arguments later, and a custom Bash implementation may ignore `timeout`.
This is a missing-deadline safeguard, not guaranteed containment: native Windows tree cleanup remains
best-effort, with no new guarantee of bounded cleanup or recovery after a hard parent exit.

Keep network timeouts and normal EOF/finally cleanup in diagnostics. Output does not reset the native
timeout; silence alone is not failure. Service lifetimes and join cancellation remain separate from
a command deadline. No core/subagent patch or service manager is added.

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
  "widgetMode": "off",
  "fleetView": false,
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

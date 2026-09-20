# Orca integration audit

Orca contributes operational telemetry and terminal UI. It installs no skill, agent, system prompt, or
always-on model instruction in the inspected Pi and Claude profiles.

## Installed surfaces

### Claude personal and work

Both native settings files register Orca's
`$HOME/.orca/agent-hooks/claude-hook.cmd` for session, prompt, tool, permission, subagent, compaction,
and stop events. The hook posts the native event payload to Orca over authenticated localhost HTTP and
always fails open. It returns `{}` and does not add model context or tool policy.

The event payload can contain prompt text, tool inputs, assistant state, and workspace/session metadata.
This is sent only to the local Orca process for status/dashboard behavior; it is not returned to Claude.

The same settings files separately register `src/claude-hooks.ts`. That is MPX, not Orca. MPX can add
shared instructions/machine roots, prompt style context, safeguard diagnostics, and formatting results,
and can deny unsafe tool use.

### Pi personal and work

Both Pi profiles contain the same three byte-identical Orca-owned native extensions:

- `orca-agent-status.ts` posts prompts, tool names/inputs, final assistant text, question/approval state,
  and lifecycle metadata to Orca's authenticated localhost endpoint. It does not mutate model context.
- `orca-prefill.ts` places `ORCA_PI_PREFILL` into the editor on an Orca-started fresh session. It does
  not submit the text; it reaches model context only if the user submits it.
- `orca-titlebar-spinner.ts` updates the terminal title and needs-input marker. It does not mutate model
  context.

MPX mirrors only marker-verified Orca files and refuses user-owned conflicts. Harness-scoped sync can
update Pi without reading or changing Claude settings. MPX's own Pi UI has a narrow Orca-environment/
activity boundary but does not post directly to Orca by default.

### Other Orca files

`$HOME/.orca/AGENTS.md` is guidance for maintaining Orca's own local installation. No inspected
registration loads it into Pi or Claude context. Orca's `codex-hook.cmd` is Orca-owned and outside MPX's
Pi/Claude runtime.

## MPX code coupled to Orca

- `src/orca.ts` safely mirrors Orca-marked Pi extensions and Orca-owned Claude hook registrations between
  account profiles while preserving unrelated settings.
- `src/resurrection.ts` prepares a bounded `orca terminal create` recipe for native Pi resume.
- `src/pi-ui.ts` recognizes Orca runtime state and exposes an activity-sink boundary; it does not own
  desktop notifications.
- `src/project.ts` prints optional Orca project configuration text without writing Orca configuration.
- `src/cli.ts` exposes Orca hook synchronization preview/apply operations.

These are small integration adapters that MPX maintains. The actual installed Orca hook and Pi extension
implementations remain Orca-owned.

## Subagent isolation boundary

The [maintained subagent patch](../extensions/README.md#quiet-subagents) excludes parent-only Orca
extensions before their factories execute: removing handlers after loading cannot undo factory
side effects. [Installed-package isolation tests](../test/subagent-isolation.test.ts) cover this
boundary, not installed Orca HTTP callbacks or Windows toasts.

The native Pi cancellation event disarms quiet-result recovery without adding model messages or
notifications. This integration does not deploy the aggregate-aware Orca candidates below; live
sender/receiver and desktop acceptance remain separate.

## Undeployed candidates

- `patches/orca-pi-aggregate.patch` delays whole-session completion while child, background, question, or
  follow-up activity remains.
- `patches/orca-pi-receiver-cancellation.patch` preserves Pi's interrupted flag so Orca labels a turn
  stopped rather than finished.

Both exist only as tested migration candidates. Neither changes context. Normal cancellation
notifications are acceptable, so cancellation-specific deployment is unnecessary. Do not deploy the
aggregate patch unless live use demonstrates premature or duplicate completion; deploy sender/receiver
changes only as one reviewed Orca change with a single attention writer.

# Pi UI / Orca activity evidence

Date: 2026-09-13

## Scope and ownership

This slice writes only the MPX2-owned Pi UI extension, implementation, tests, and this evidence file. It does not modify Pi, `@tintinweb/pi-subagents`, Orca, account roots, or deployed configuration. `extensions/pi-runtime.ts` remains the parent-owned composition point.

`extensions/pi-ui.ts` exposes both:

- the standalone safe-default extension; and
- `createPiUiExtension({ title, activitySink, ... })`, whose `title` accepts the already-resolved `UserConfig.piTitle` shape (`provider`, `model`, `thinking`).

The factory maps `thinking` to the Pi request effort. It deliberately does not read MPX2 account config: asynchronous config selection remains in the parent composition layer.

## Upstream-first findings

Inspected the installed/pinned sources and declarations before adapting behavior:

- Pi extension lifecycle, event bus, widgets/footer, session naming and TUI contracts in `@earendil-works/pi-coding-agent` 0.85.1 documentation, declarations, and examples.
- `@tintinweb/pi-subagents` 0.19.0 package source (`src/index.ts`, `agent-manager.ts`, `agent-types.ts`, `types.ts`, `usage.ts`, and `ui/agent-widget.ts`).
- Existing Orca Pi status extension/handler/UI-prompt source and `pi-family-events.ts`, read-only from the pinned Orca checkout.
- Retired MPX Pi UI sources (`auto-title.ts`, `footer.ts`, `fullscreen-scroll-speed.ts`, and `terminal-progress/`) for behavioral provenance only.

Findings:

1. The pinned subagent package already owns the native live panel and emits public `subagents:started`, `subagents:completed`, and `subagents:failed` lifecycle events. MPX2 therefore does not duplicate running-agent rows.
2. Completion lifecycle payloads contain authoritative duration and token totals. The public `get_subagent_result` tool result can additionally identify the actual model name and effective thinking tag. The footer correlates these sources by agent ID; absent values remain `unknown` rather than being inferred from the parent session.
3. Pi exposes native context usage, model/thinking state, active session entries, session names, and a custom-footer API. The compact footer is built from those sources and retains context plus compaction visibility.
4. Orca already owns its Pi status transport. This slice therefore contains no HTTP/socket/IPC writer and no Orca import. Its narrow integration boundary is one aggregate snapshot sink.

## Adaptation classification

### Retained and adapted

- Prompt-derived session naming, now using Pi's session APIs and one explicitly configured title model.
- Compact session/model/effort/context/compaction footer information.
- Faster fullscreen wheel movement in Windows Terminal only.
- Main/background/follow-up/human-needed activity concepts, collapsed into one state machine.

### Replaced by upstream

- Legacy custom running-subagent UI is replaced by the pinned package's live widget.
- Legacy fabricated/inherited finished-agent model and effort are replaced by public lifecycle/tool-result correlation.
- Legacy independent terminal-progress transport is replaced by `PiActivityAggregate` plus an injectable `PiActivitySink`.

### Retired

- Footer port/status transport rows.
- Shortcut-help rows.
- Separate child completion alerts and child-local aggregate ownership.
- Any second Orca network writer.

## Implemented behavior

### One aggregate activity state

`PiActivityAggregate` publishes snapshots with `idle`, `working`, `human-needed`, `done`, or `cancelled`, together with main/child/background/follow-up counts and a monotonic revision.

A `done` state is possible only after all tracked work drains and the short settle window expires. New work cancels that timer. Child completion alone cannot produce a child-local completion state. Cancellation is distinct from completion, and session start/switch/reload resets state without a false done transition. Sink failures are swallowed because status observation must not interrupt agent work.

The default sink emits only `mpx2:pi-ui:activity` on Pi's public event bus. A parent/Orca composition can inject one sink instead. Public `mpx2:pi-ui:background` and `mpx2:pi-ui:follow-up` events are the narrow extension points for work not represented by Pi's main-agent or subagent lifecycle. Question tool execution drives `human-needed` while outstanding work remains.

A process singleton guard grants aggregate ownership only to the first active/root UI instance. Child-bound instances neither construct an aggregate nor emit child alerts.

### Finished-agent footer

The upstream package continues to render running agents. MPX2 adds rows only after public completion/failure lifecycle events. Rows expose:

- subagent type;
- actual model when reported, otherwise `unknown`;
- effective thinking tag when reported, otherwise `unknown`;
- actual duration when reported, otherwise `unknown`;
- actual total token count when reported, otherwise `unknown`.

Tool-result enrichment never replaces a valid lifecycle token total with a parsed zero/unknown value. Footer lines are control-character sanitized and terminal-column bounded.

### Explicit title model

`createPiUiExtension` accepts the exact `UserConfig.piTitle` shape. Generation calls `modelRegistry.find(provider, model)` and validates configured auth for that exact result. There is no alternate/default model lookup and no alias substitution. If the exact model is absent, auth is unavailable, generation fails/times out, or no title config was supplied, naming safely falls back to a bounded title derived from the first interactive prompt.

The request is bounded (`96` output tokens, no retries, `15s` timeout) and uses the configured thinking level. Parent verified the native 0.85.1 API: ModelRegistry has no `completeSimple`; the adapter uses `getProvider` / `getApiKeyAndHeaders`, then provider `streamSimple(...).result()` with supported `reasoning`, native auth/headers/baseUrl/env, and an abort signal. An outer promise deadline also bounds hung auth/provider implementations; late auth cannot start a request after cancellation. A manual/existing name is never overwritten. Session revision checks prevent an asynchronous result from naming a switched/reloaded session.

### Wheel adjustment

The three-line override runs only in TUI mode when a positive Windows Terminal marker is present. Positive Orca pane markers take precedence over an inherited/stale `WT_SESSION`, so Orca behavior is untouched. The helper changes only a recognized fullscreen `wheelScrollLines` setting and otherwise no-ops.

## Verification

Passed:

```text
pnpm typecheck
pnpm exec tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --skipLibCheck --types node src/pi-ui.ts extensions/pi-ui.ts test/pi-ui.test.ts
pnpm exec tsx --test test/pi-ui.test.ts
# 11 tests, 11 passed

git diff --check -- extensions/pi-ui.ts src/pi-ui.ts test/pi-ui.test.ts
```

Coverage includes aggregate ordering/settling, explicit follow-ups, human-needed precedence, cancellation/reset, no child-local activity emission, lifecycle accuracy and unknown fields, tool-result enrichment, compact footer content, exact configured title model/effort, manual-name preservation, no implicit model fallback, and Windows Terminal/Orca gating.

A concurrent repository-wide `pnpm test` run executed all 164 subtests (177 tests): all 11 Pi UI tests passed. Three unrelated in-progress projection/CLI tests failed (`agents.test.ts`, `cli.test.ts`, and `content.test.ts`) against concurrent uncommitted generated-content work; this slice did not alter those files or run the build because doing so would violate its write boundary.

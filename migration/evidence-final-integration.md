# Final integration findings — 2026-09-13

This is migration evidence, not runtime authority or cutover approval.

## Orca completion: reproduced, adapter not approved

`node --import tsx migration/orca-activity-probe.mjs C:/Users/snapy/.pi/agent/extensions/orca-agent-status.ts`
loaded the unchanged installed status hook and MPX2 composition through the native Pi 0.85.1
loader into an in-memory session with disposable account/HOME/APPDATA/project. Only the model
stream and HTTP boundary were fixtures. A held child was represented by its public lifecycle
event; this was **not a provider-executed child or a physical Orca UI trial**.

After the native parent turn, the hook posted `session_start`, `before_agent_start`, `agent_start`,
`message_end`, and `agent_end`. At that point MPX2's aggregate still reported `working`,
`mainActive:false`, `activeChildren:1`, and no pending completion settle. All posts were intercepted:
zero network requests and zero installed changes. Thus native-parent completion alone cannot
provide the required aggregate completion signal.

No competing sender, deployed adapter, or Orca patch was added. Preparation of a narrow checkout-local
Orca hook patch was requested but has **not been approved**. Pending-follow-up ownership, cancellation,
human-needed state, and exactly one completion notification still require the approved single-writer
integration and subsequent physical/live acceptance. A 500 ms settle timer is not authoritative
knowledge of upstream's future follow-up queue.

## Claude compaction transport correction

The earlier claim that plain `PreCompact` stdout injects compaction instructions was incorrect.
Claude's documented stdout context channels do not include that event:
<https://code.claude.com/docs/en/hooks#exit-code-0> and
<https://code.claude.com/docs/en/hooks#precompact> (read 2026-09-13; current documentation is newer
than the previously probed installed CLI 2.1.236).

The owned registration no longer installs a misleading `PreCompact` hook. `SessionStart`, the
supported native context channel, now supplies the canonical shared COMPACT body under an explicit
manual/automatic **compaction-only** scope, alongside the shared instructions and machine roots.
User-supplied compact instructions take precedence. Missing guidance warns and retains native behavior.
No compaction engine, extra summary call, transcript rewrite, or blocking compact hook was added.
Unit transport coverage checks delivery/scoping and the absence of unsupported PreCompact output;
actual provider-generated manual/automatic summaries remain a live acceptance gate.

## Formatting and process deadlines

Pi formatting runs inside native write/edit filesystem operations and therefore inside the native
per-file mutation queue. A real native-tool fixture verifies write → format → subsequent edit ordering
and successful-write preservation when formatting fails. The visible native edit diff represents the
requested edit; reread for post-format bytes. Only configured local Prettier/Biome/Ruff tools run.
Other project formatting stays explicit/manual; no formatter is installed or downloaded automatically.

The process runner preflights Windows tree-kill infrastructure, reserves termination time, attempts
absolute `taskkill.exe`, then a bounded PowerShell CIM ancestry/Stop-Process fallback. Both failures
produce an explicit manual-stop diagnostic. Surviving descendants cannot keep the caller waiting
indefinitely on inherited pipes: those streams are detached on failed termination and the failure
returns as incomplete, never clean. This does **not** claim the OS killed a process when both mechanisms
failed; stop the project tool manually before further edits in that exceptional case.

Tests include a real descendant whose delayed write must not occur, missing-infrastructure startup
refusal, and deterministic dual-killer failure with inherited pipes. The latter explicitly cleans up its
controlled surviving child. Tiny 100 ms Windows fixture budgets were replaced by a realistic 2 s budget;
termination-failure behavior now has its own dedicated test rather than weakening clean-stop assertions.
The full suite is capped at four concurrent test workers: unbounded native-fixture startup had starved
short Windows termination budgets. Clean-stop assertions remain strict. Windows temporary-directory
cleanup retries are bounded; the dual-failure fixture injects only the killer lookup root, not a fake
SystemRoot into the child OS environment.

## Tutorial helper dependency/placeholder correction

The retained compiler statically imports YAML and Shiki, not just Node built-ins. YAML was already an
MPX2 dependency; Shiki is now pinned to **3.23.0** in the same private package. No separate installation
inside committed projections is required. The optional Mermaid renderer/browser remains an explicit
setup prerequisite, not a silently proven renderer.

An actual generated helper compiles a disposable source using the real highlighter, checks that its
adapted lowercase tutorial placeholders are filled, rejects an unknown reserved tutorial placeholder,
and preserves the previous HTML on that failure. This verifies more than JavaScript syntax. No OneDrive
file was read/written and no browser/download was started.

## Legacy isolation gate

The real retained footer's `agentDirectory()` hardcodes `~/.pi/agent`. MPX2 now refuses that known
implementation when the fixed physical root differs from the explicitly selected separate legacy
account. A disposable reproduction checks refusal before launch; safe fixture resources still produce
the expected native arguments and exclude the old alert bundle. This guard is not a legacy compatibility
fix or proof that every other retained module works with Pi 0.85.1. An approved compatibility change and
native/live acceptance are still required; no legacy repository was edited and no reduced fallback runs.

## Final automated gate

`pnpm build` reports 386 projections and no drift; typecheck passes. The final parent `pnpm test` run
passes **212/212**, with zero failures, skips or cancellations (latest run: 27.5 s). Frozen installation with
`--ignore-scripts` passes. Earlier runs exposed obsolete assertions, Windows fixture budget/cleanup
issues, and a bad fake-SystemRoot test setup; they were not reported as passing. A read-only checker
also reported an undiagnosed typecheck exit 1; the parent reran the actual command and full gate
successfully. That checker's actual model/thinking metadata was unavailable, not guessed.
A final narrow read-only reliability review found one missing legacy tool-display file exposing raw
ENOENT instead of its intended diagnostic. The parent added contextual no-fallback handling and a
regression assertion, then reran typecheck and the full 212-test suite successfully. That reviewer's
model/thinking metadata was likewise unavailable.

## Preserved repositories

Read-only check at `2026-09-13T20:32:36+02:00`:

| Source | HEAD | Dirty entries |
|---|---|---:|
| mpx | b8e323e02c734bff852766cebf2dbc897fc45c49 | 184 |
| mpx-claude-code | ab77de05843c4fde97e8483e7712c327f4cdf59f | 2 |
| mpx-pi | 8464b23f0aef5bc235699920125e04fb94b84530 | 1 |

These match the prior snapshots. No credential/history migration, installed bootstrap replacement,
account cutover, source archival/rename, remote creation, push, or reboot was performed.

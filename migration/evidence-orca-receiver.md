# Orca Pi receiver cancellation candidate

Date: 2026-09-14. The user separately approved checkout-local preparation/testing, **without deployment**.

## Patch and scope

`patches/orca-pi-receiver-cancellation.patch` changes only
`src/shared/agent-hook-listener/providers/pi-family-events.ts` in a disposable copy of Orca.
It forwards strict boolean `interrupted:true` only for Pi `agent_end`. Existing shared normalization
keeps the flag only for `done`, so active question/waiting states cannot inherit cancellation.
Ordinary completions, other events, OMP and Prime-Agent are unchanged. No sender, auth, installation,
notification settings or delivery policy changed. Existing hook candidate is unchanged.

Original Orca checkout: `729491597f33031089148bc2fba41a99e0b95de7`.
SHA-256 provenance:

- Receiver source: `c664b21afb5819e8f95e3fa8a021e05fc94d3b0ac37897cc9686f7979c64d60b`
- Patched receiver before probe-only import relocation: `2af4e4118c8e1e44806fd74ed6d729c0b7006d0f25f5e299f4926b38e19d3a3e`
- Executed receiver TypeScript after import relocation: `8d2417bb57c7f1026f0cfb5b3b1197fbf8fbf7e45d5821fe940bee1d0d4fff0f`
- Patch: `0c532a891ae9728cc3b4ddf770ae15983ba56160c2402092e5c9c561dc88210a`

## Passing verification

```bash
node --import tsx migration/orca-aggregate-probe.mjs \
  C:/Users/snapy/.pi/agent/extensions/orca-agent-status.ts \
  C:/_MP_github_cloned/orca
```

Executed with a 65-second outer process deadline. `migration/orca-receiver-candidate.mjs` copies and
`git apply --check`/applies the patch only under the disposable fixture. Six relative imports are
relocated there to read-only original dependencies; the distributable patch contains no path rewrites.
The overlay matches Orca's CommonJS compilation context. An initial ESM overlay import failure was
corrected and the entire probe rerun; the failed run was not counted as success.

`migration/orca-receiver-checks.mjs` exercises 33 scenarios against actual original/candidate normalizers:
strict booleans, malformed values, all three family providers, nonterminal/session/question events,
waiting-state precedence, and cancellation → working → normal completion without stale interruption.
Unaffected outputs are compared with the unchanged original normalizer.

The existing actual native Pi parent/child/get-result/nudge/reload fixture also passes. Captured native
abort reaches the copied receiver as `done, interrupted:true`; the original still reproduces the missing
flag. Actual renderer ingress retains it. Unchanged notification formatting logic produces **Pi stopped**
for cancellation and **Pi finished** for ordinary completion. Only its Electron/i18n dependency is replaced
with an explicit English-fallback translation fixture; no physical notification or locale integration runs.

Actual native fixture metadata: Pi 0.85.1, unchanged pi-subagents 0.19.0; seven stream calls at
`mpx-fixture/model`, reasoning `high` (two children, five parent calls). Streaming and HTTP are fixture
boundaries, not authenticated providers. Four non-cancelled aggregate completions, native result
consumption, held nudge beyond 700 ms, question/background events, stale activation rejection and fresh
post-reload listener work remain covered. Zero network requests or installed changes.

Git-visible external source/index and explicit installed-hook integrity checks wrap success and failure.
They passed; ignored caches/account stores are not scanned, and this is not an OS sandbox.
Repository gates: build 386 projections/zero drift, typecheck passed, **225 tests passed**, zero failed or
skipped. The 33 receiver scenarios are additional standalone native-probe coverage, not added to that
unit-suite count. Read-only review requested separate executed-source provenance; that hash was added
without replacing the reproducible pre-relocation candidate hash, and native/full gates were rerun.

## Important policy distinction

Preserving interruption does **not** silence Orca. Current original code routes terminal done states
through completion dispatch (`agent-completion-hook-observer.ts`), can mark unread
(`use-notification-dispatch.ts`), and deliberately formats interrupted completion as **stopped**
(`notification-options.ts`). Existing notification-formatting tests confirm that presentation.

This corrects the earlier assumption that forwarding the flag alone suppresses delivery. The approved
receiver-only patch preserves cancellation provenance and presentation, not a new attention policy.
Original Orca/app, installed hooks, native accounts, credentials and histories remain untouched. Paired
installation authorization, physical delivery/unread behavior, resumed startup and reboot acceptance
remain separate gates. No additional suppression patch, remote or push was made.

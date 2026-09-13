# Migration progress — 2026-09-13

**State: repository implementation and isolated verification; NOT cutover-ready.**
`DECISIONS.md` is authority; `MIGRATION_PLAN.md` owns acceptance. Evidence does not authorize installation.
Remote creation remains deferred (future owner: MartinoPolo).

## Local checkpoints

- `45fc3a0 docs(migration): approve local pack patch and defer remote setup` — authority only;
  typecheck passed immediately before committing.
- Implementation/content/generated outputs/evidence: final gate and local checkpoint in progress.
  No push, remote creation, installed cutover, account migration, archival, rename, or reboot.

## Implemented in MPX2

| Area | Implemented | Evidence / qualification |
|---|---|---|
| Canonical content | All 51 current skills, 21 specialists, shared/provider/harness instructions, 16 rules, terse style; 195 canonical files and 386 projections | [COVERAGE.md](COVERAGE.md), core/remaining/shared evidence. Historical `mp-to-epic` → `epic-create`, `mp-init-repo` → `init-github-repo`; no silent retirement. |
| Compiler | Deterministic source/output build, declared body placeholders, specialist projection, balanced/escaped Markdown and HTML support closure | Compiler/content tests; committed source and output must move together. |
| Native wrappers/context | Pi/Claude personal/work, native selectors/escape paths, project/account content roots, shared instructions/style, native Pi compaction guidance | Original discovery/context evidence and native composed fixture. No auth router, per-session environment protocol, or MPX registry. |
| Upstream selected packs | Pinned checkout-local 0.19.0 patch, only discovery/preload wiring in runner/skill loader | Actual native child loaders/runAgent, concurrent selections, linked worktree, named bodies. Installed 0.14.3 bootstrap untouched. |
| Shared safeguards | Dangerous command/NUL policy, bounded trusted Git metadata, staged-secret checks including no-verify, push-only opted-in Fallow | Infrastructure policy distinctions retained: dangerous inspection fails closed; incomplete secret/Fallow audits warn/allow, never clean. Opaque inline interpreters remain blocked. |
| Native formatting | Configured local Prettier/Biome/Ruff only; trusted/ignored/generated checks; edited file only, native mutation queue, bounded execution | Optional at cutover. Failure preserves successful mutation; native diff is pre-format. No lint/restage/download. |
| Native transports | Pi tool_call plus native filesystem operations; Claude native permission/result/context hooks | Claude compaction guidance uses SessionStart context, **not unsupported PreCompact stdout**. Native summary quality remains live acceptance. |
| Pi UI | Native running rows plus finished metadata footer; aggregate lifecycle boundary, bounded configured title request/fallback, Windows Terminal-only wheel trial | No Orca transport deployed. Aggregate completion is not accepted from a timer alone. Actual physical UI still pending. |
| Resume | Native discovery, project/account ordering, exact selectors, fresh metadata checks, read-only Pi RPC model/auth/effort preflight, list/preview/launch picker | Preserves transcripts. Unknown Claude effort needs explicit override. Preflight ≠ resumed startup; Claude startup verification not claimed. |
| Resurrection/Orca recipe | Adapter consumes verified prepared launch; cwd/account/selectors preserved, unrelated/credential env deltas rejected | Current Agent Resurrect disposable save/restore pilot passed unchanged. Orca terminal CLI recipe only; no new daemon/session registry or deployed restart behavior. |
| Install/status/project | Owned links, bounded optimistic native JSON merge, conflict preservation, native registrations/package readiness, optional project symlink and text-only Orca snippets | Preview and disposable merge/idempotence tests. No actual account installation. |
| Retained native packages | Exact configured package/path/version/filter inspection; native loaders for both accounts | Web 0.28.0 personal / 0.27.0 work mismatch preserved; MCP 2.32.1 and question 2.9.0 both. No upgrades. |
| Legacy access | Explicit separate existing account and complete package/tool-display dependencies required; no fallback, old alert bundle excluded | The known hardcoded footer root now blocks launch rather than crossing accounts. Fixtures are not full legacy UI compatibility acceptance. |
| Tutorial helper | Root package YAML/Shiki dependencies, adapted-placeholder validation, actual projected helper execution | Shiki 3.23.0; optional Mermaid/browser setup and other external workflow tools remain explicit prerequisites. |

## Verified and limits

- Frozen checkout install with `--ignore-scripts` passes; no retained native package/account installation.
- `pnpm build`: 386 projections, zero drift. `pnpm run typecheck`: passed. `pnpm test`:
  **212 passed, 0 failed/skipped/cancelled**, with native fixture concurrency bounded at four.
  Earlier failed runs were repaired and rerun, not counted as passing.
- Pi 0.85.1 composed native loader/session/tool-loop fixtures pass for personal/work: dangerous clean
  blocked before deletion, NUL write blocked, safe native write/edit, shared/style/root context, and one
  upstream Agent/result/steer registration. Offline provider and in-memory credentials; streaming stubbed;
  outbound fetch/socket attempts actively rejected. Not authenticated service acceptance.
- Retained web/MCP/question packages load through native Pi for both existing configurations. Native
  package manager read-only resolution independently confirms six installed source/path matches. Local
  MCP echo and question callbacks pass. Web loopback is **SSRF-blocked with zero requests**, not retrieval success.
- Native resume preflight and resurrection fixtures preserve exact account/cwd/model/effort. The current
  Agent Resurrect registration loads unchanged in a disposable account and its save/restore pilot passes.
- The unchanged installed Orca hook was loaded into an isolated native parent session. With a held public
  child lifecycle event, it posted `agent_end` while aggregate state remained working/one active child.
  Posts were intercepted: no receiver contact, deployment, provider-executed child, or physical UI claim.
- Native process tests cover real descendant termination, unavailable-killer startup refusal, and explicit
  dual-killer failure without waiting on inherited pipes. Failed OS termination is not falsely guaranteed;
  the exceptional manual-stop diagnostic must be obeyed before further edits.
- See [evidence-final-integration.md](evidence-final-integration.md) for transport/process corrections and
  [evidence-native-packages.md](evidence-native-packages.md) for package acceptance boundaries.

## Pending decisions / implementation blockers

1. **Orca hook patch approval unanswered.** Permission was requested to prepare a narrow checkout-local
   hook patch for aggregate completion/cancellation, without editing Orca source or deploying it. No patch
   or competing sender has been added. Required single-writer integration must account for children,
   background work, pending follow-ups, cancellation, and human-needed state; native-parent end is insufficient.
2. **Legacy footer isolation/compatibility.** Retained `mpx-pi/extensions/footer.ts:1817` hardcodes
   `~/.pi/agent`. Separate-root launch arguments do not fix that internal access. Do not treat `lpi` fixtures
   as permission to run the real legacy display against a managed root; compatibility needs an approved fix
   and actual native-loader/live acceptance. MPX2 now rejects that known footer before launch when its
   fixed root differs from the selected legacy account. No old repository was changed.
3. **Ctrl+Enter in Orca** retains its known deferred routing fix. Shift+Enter/Ctrl+J are the alternatives.

## Human/live acceptance — still required

- Explicit installed registration/cutover authorization and review of conflicts/version differences.
- Physical prompt scrolling/newlines/wheel/footer/title/manual-name/question UI behavior in real terminals.
- Authenticated main/child/title calls, native MCP/web/browser workflows, and manual/automatic compaction
  summary quality for both harnesses/accounts; account login/auth remains native.
- Exact real resumed startup, current-session handling, multiple project sessions, and account/model/effort
  checks after launch; an offline preflight is not that acceptance.
- Approved Orca aggregate transport, one completion/attention writer, foreground/background/follow-up and
  cancellation/human-needed lifecycle, real terminal recipes and Agent Resurrect behavior.
- Actual close/reopen and reboot matrix. No reboot or reboot acceptance has occurred.
- Optional external workflow tools (including Mermaid/browser) need explicit setup where absent; preserve
  warnings and do not claim their live workflows or rendered output have passed.

## Preservation / provenance

The original [INVENTORY.md](INVENTORY.md) is retained as an initial snapshot, not a stale implementation
backlog. [COVERAGE.md](COVERAGE.md) maps current outcomes to dirty source, including shared COMPACT.
Transfer scripts/hashes are migration-only evidence, never runtime integrity authority.

At `2026-09-13T20:32:36+02:00`, source HEADs/dirty-entry counts remained:
`mpx b8e323e… / 184`, `mpx-claude-code ab77de0… / 2`, `mpx-pi 8464b23… / 1`.
Installed accounts, credentials, histories, native packages and 0.14.3 migration bootstrap were preserved.

Parent runtime was reported as `openai-codex/gpt-6-astra/high`; implementation workers' actual metadata
was generally `gpt-5.6-sol/high`. One pinned Explore definition ran `gpt-5.6-luna/medium` despite the tool
request; it is not mislabeled Sol/high. Interrupted workers' unfinished claims were repaired and rerun by
parent/completion workers, not accepted at face value. Native fixture/probe details are evidence-scoped.

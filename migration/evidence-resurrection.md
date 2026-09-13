# Agent Resurrect / native Pi / Orca resurrection evidence

Date: 2026-09-13. Scope is the bounded disposable native-Pi resurrection pilot and pure launch adapters only. This is not cutover, reboot, Windows Terminal, or human TUI acceptance.

## Runtime identity printed before work

```text
PI_MODEL=gpt-5.6-sol
PI_PROVIDER=openai-codex
PI_REASONING_LEVEL=high
```

## Authorities and source inspected

- `DECISIONS.md` was read completely.
- `MIGRATION_PLAN.md` Resume, Resume implementation/acceptance, existing native Pi evidence, Orca integration, and Orca hooks were read.
- Current Agent Resurrect source was read at `C:/_MP_projects/agent-resurrect`: `src/scan.js`, `src/resurrect.js`, `src/lib/native-launcher.js`, save CLI/store, configuration, and Pi registry reader.
- The installed registration `C:/Users/snapy/.pi/agent/extensions/agent-resurrect.ts` was read and then loaded unchanged by the disposable Pi account.
- Orca was inspected read-only at the required source commit `729491597f33031089148bc2fba41a99e0b95de7`. At that exact commit, `orca terminal create` accepts `--worktree`, `--title`, `--command`, optional `--focus`, and `--json`; its handler passes those values to `terminal.create`. It has no separate environment argument. This interface creates a terminal and is not Run/worker restoration.

No Agent Resurrect source/save, installed registration, real account, credential, transcript, Orca source, or Orca application state was changed.

## Current workflow tried first

`node migration/agent-resurrect-probe.mjs` used only a temporary account root, native Pi v3 transcript, custom offline fixture model, registry, save directory, workspace, launcher shim, and generated launch script. The root was removed after the run.

The selected Pi executable was the absolute `MPX_PI_EXECUTABLE`. Discovery was limited to one disposable Pi account with `mpxEnabled: false`; no real Claude/Pi account was scanned. Native Pi loaded only the installed Agent Resurrect registration explicitly, with normal extension/skill/template/theme/context/tool discovery disabled and offline mode enabled.

The current workflow passed:

1. Native Pi opened the disposable session and the installed extension registered it as native.
2. Current `runHeadlessSave` and `scanAllSessionsAsync` captured exactly one Pi session into the disposable save.
3. Save completeness was `complete`; the sole source was `native/pi/probe`, status `available`, code `null`, count `1`.
4. Save warnings were exactly `[]`. The captured stdout ended in `toast unavailable` because the probe deliberately injected a no-op toast; this was not a save or discovery warning.
5. The original process exited. Current `resurrectSessions` selected one session with zero already-open, missing-directory, missing-session-file, or invalid-launch entries.
6. Current `buildSessionLaunch` generated and started the native Pi restore command with the selected disposable account environment.
7. RPC state and the installed registration observed the same session ID/file, cwd, account root, provider/model, effort, and native ownership after restore.

Exact current restore argv (temporary path component varies per run):

```text
--no-extensions
-e
C:/Users/snapy/.pi/agent/extensions/agent-resurrect.ts
--session
C:/Users/snapy/AppData/Local/Temp/mpx2-agent-resurrect-<nonce>/pi-account/sessions/--resurrection-probe--/resurrection-probe-session.jsonl
```

Exact restore state:

```text
cwd=C:/Users/snapy/AppData/Local/Temp/mpx2-agent-resurrect-<nonce>/workspace
account=probe
PI_CODING_AGENT_DIR=C:/Users/snapy/AppData/Local/Temp/mpx2-agent-resurrect-<nonce>/pi-account
sessionId=resurrection-probe-session
provider=mpx-resurrection-probe
model=exact-native-model
effort=high
ownership=native
model flags=[]
effort flags=[]
skip-permission flags=[]
```

The lack of model/effort flags is intentional for this recovered Pi transcript: native `--session` restored both, matching the reliable stripped-down native baseline. No observed Agent Resurrect save warning or restore-fidelity failure exists to justify a source repair or baseline rollback. Two early probe-harness failures (a wrong local Git Bash default and a temporary cwd cleanup race) occurred before a workflow result; the probe was corrected without changing Agent Resurrect or installed state.

## Implemented MPX2 adapters

`src/resurrection.ts` is deliberately pure and small:

- `adaptPreparedPiResurrection` accepts only the result already produced by `prepareResumeLaunch`; it performs no discovery or launch.
- It requires verified Pi preflight, exact cwd/account root, and the exact prepared resume-argument suffix. It rejects permission-bypass replay.
- It returns copied exact executable/argv/environment/warnings from the prepared MPX2 launch, thereby preserving selected account and pack paths rather than using Agent Resurrect's native alias-bypassing path.
- It introduces no session registry, save database, lifecycle marker, ownership protocol, fallback, or Agent Resurrect adoption/deployment.
- `buildPreparedLaunchCommand` creates a quoted cwd check, owned environment delta, and exact executable/argv command. Unrelated environment changes are rejected rather than serializing credentials. Native Windows names such as `ProgramFiles(x86)` remain untouched. The caller supplies the ambient environment used for preparation.
- `buildOrcaPiResurrectionRecipe` returns pure Orca CLI argv using the explicit `path:<cwd>` workspace selector, `WORK · Pi` or `PERSONAL · Pi`, `--command`, and `--json`. It does not invoke Orca, create a terminal, use Run, or create/adopt a worker.

Because pinned Orca `terminal create` exposes command text but no environment field, live acceptance must verify that the Orca terminal's ambient environment matches the ambient snapshot used to construct the delta. A mismatch must not be silently treated as exact restoration.

## Validation

```text
node migration/agent-resurrect-probe.mjs
  PASS: current save/restore launch script and actual native Pi RPC process

node --check migration/agent-resurrect-probe.mjs
  PASS

pnpm exec tsx --test test/resurrection.test.ts
  PASS: 5 tests

pnpm run typecheck
  PASS
```

Tests cover exact-copy behavior, verified-Pi-only gating, cwd/account/resume mismatch failures, permission-bypass rejection, shell quoting/environment delta, explicit Orca workspace and `WORK · Pi` label, absence of Run/worker semantics, no invented recovered model/effort flags, and exact preservation of explicit overrides.

## Human acceptance still required

The pilot started the current generated launch script and actual native Pi in disposable RPC mode. It intentionally did not dispatch `wt.exe`, create a real Orca terminal, or open a human-visible TUI. Human interactive action is therefore still required for:

- ordinary interactive `wsave` / `wresurrect` selection and warning presentation;
- Windows Terminal tab creation and visible restored history/footer;
- an isolated Orca `terminal create` using the returned explicit workspace/title/command recipe, followed by screen/state/account/content verification;
- normal close/reopen, already-open duplicate handling in real terminal paths, Orca restart, and coordinated reboot acceptance.

Concrete decision: retain Agent Resurrect source and saves unchanged because its current isolated native-Pi save/restore path showed no warning or fidelity failure. Do not deploy or silently route it through the MPX2 adapter yet. The adapter and Orca recipe are implemented/tested candidates; actual terminal adoption remains a separate human acceptance decision.

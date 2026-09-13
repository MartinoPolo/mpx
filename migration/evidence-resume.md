# Native resume read/planning and launch-preflight evidence

Date: 2026-09-13. Scope is the bounded resume implementation only; this is not cutover or reboot acceptance.

## Runtime identity printed before work

```text
PI_MODEL=gpt-5.6-sol
PI_PROVIDER=openai-codex
PI_REASONING_LEVEL=high
PI_SESSION_FILE=
```

Selected executable environment during native checks:

```text
MPX_PI_EXECUTABLE=C:\Users\snapy\AppData\Roaming\fnm\node-versions\v22.23.1\installation\pi
MPX_CLAUDE_EXECUTABLE=C:\Users\snapy\.local\bin\claude.exe
```

## Authorities and native API material read

- `DECISIONS.md` was read completely.
- `MIGRATION_PLAN.md` was read completely, including **Resume**, **Resume implementation and remaining acceptance**, and **Existing native Pi evidence**.
- Existing `src/resume.ts`, native Pi SDK fixture/tests, `migration/PROGRESS.md`, and `migration/claude-probe.mjs` evidence were read before implementation.
- Installed Pi 0.85.1 documentation was read completely where relevant: `docs/models.md`, `docs/sdk.md`, and the linked `docs/rpc.md`; linked SDK model/auth examples and installed `ModelRuntime` declarations were also inspected. The implementation uses the documented RPC `get_state`, `get_available_models`, and `get_available_thinking_levels` operations rather than inventing a startup-state protocol.

## Implemented behavior

### Native transcript reading and planning

- `src/resume.ts` retains the secure bounded Pi v3 parser and adds a bounded fatal-UTF-8 Claude JSONL parser under exactly `<CLAUDE_CONFIG_DIR>/projects/<project>/<session-id>.jsonl`.
- Physical-directory/file and canonical-containment checks reject transcript, directory, and account escapes. Session ID must agree across Claude records and with the filename; cwd must be absolute and consistent; duplicate UUIDs, missing parents, cycles, malformed metadata/JSON, oversized input, and unavailable resources fail directly when that transcript is selected.
- Claude model recovery follows the active parent branch and ignores abandoned branches and sidechains. Title text is display-only. Provider and effort are not inferred from title, prompt text, arbitrary payload keys, or process arguments.
- Claude effort is always unknown because the deployed evidence does not prove it is persisted. Planning therefore requires an explicit effort override. Missing model likewise requires an explicit override.
- Claude plans use exact native ID plus explicit selectors: `--resume <id> --model <model> --effort <override>`. This follows the disposable 2.1.236 probe, where naive resume restored history but selected the startup model/effort instead of the original selection.
- Listing now reads Pi and Claude stores for personal and work accounts and sorts every current-cwd match before newer sessions in other projects. No session registry or copied transcript archive was added.

### Managed launch preparation and Pi validation

`src/resume-launch.ts` exports:

- `prepareResumeLaunch(options): Promise<PreparedResumeLaunch>`
- `verifyPiResumePreflight(spec, plan, timeoutMs?)`

The preparation helper:

1. Requires the selected configured account root to resolve to the same physical root as the chosen transcript.
2. Re-reads/replans the exact transcript and cwd.
3. Calls existing `resolveProject`, `selectPacks`, and `createLaunchSpec`, returning the parent CLI/picker a managed `LaunchSpec`; it does not launch the interactive process.
4. For Pi, starts the selected executable in bounded offline, discovery-disabled, tool-disabled, no-session RPC mode. It passes the exact planned provider/model/thinking selection, then checks actual `get_state`, the exact native available-model set, and available thinking levels. Missing auth/model availability, model substitution, or effort clamping fails closed.
5. Sends no prompt, opens no session, and fingerprints the selected transcript before and after the preflight. This is a model/effort availability and resolution preflight, not a registry and not a claim that an interactive resumed process has passed live acceptance.

A first disposable experiment opened the selected Pi transcript in RPC mode. Native startup changed that disposable transcript, so that approach was rejected as not read-only. The final verifier uses `--no-session`; exact transcript ID/file/cwd/account integrity remains enforced by the bounded parser/planner, while actual model/effort availability is verified in the selected runtime.

Claude plans are returned with `verification.verified === false` and a direct reason: Claude 2.1.236 has no demonstrated read-only startup-state interface. Explicit arguments are not represented as verified state.

## Tests and native evidence

Focused final command:

```text
pnpm run typecheck
pnpm exec tsx --test test/resume.test.ts test/claude-resume.test.ts test/resume-launch.test.ts test/native-resume.test.ts
```

Result: 24 tests passed after the final test correction; no real account roots or transcripts were used. Coverage includes active/abandoned branches, both harnesses and accounts, current-project priority, unknown model/effort overrides, malformed identity/cwd/branch/UTF-8/JSON, symlink escapes, exact account-root matching, unavailable model, substituted model, clamped effort, managed launch composition, and byte-read-only checks.

`test/resume-launch.test.ts` also ran the actually selected Pi 0.85.1 executable against a disposable account, custom authenticated fixture model, cwd, and transcript. Its no-session RPC state reported the exact fixture provider/model/medium effort and native availability; no provider request was made.

The existing native Pi SDK restoration fixture remained green: a disposable v3 session with mid-session model/effort changes was read/planned byte-read-only, reopened by native SDK, and retained exact history/model/effort.

The existing bounded Claude 2.1.236 loopback probe was rerun. Version, initial backend, skills, leading handoff, exact-ID history, explicit selection correction, account isolation, and source-byte checks passed. Naive resume used `claude-opus-5/high` instead of the initial fixture model/low, so the probe intentionally exited 1 and retained its exact gap. The explicit `--resume/--model/--effort` phase restored history with the requested model/effort. Temporary roots were removed and source bytes remained unchanged.

A full `pnpm test` run reached 165 passes and one unrelated failure: `test/content.test.ts` detected concurrent uncommitted canonical projections outside this task's owned files. No build was run and those files were not changed by this work.

## Unsupported live acceptance, reported separately

The following remain **not verified** and must not be described as passed:

- Parent-owned interactive CLI picker hookup and actual `runLaunch` handoff.
- A post-launch verifier attached to the final interactive Pi or Claude resumed process. Pi's implemented no-session preflight proves exact model/effort availability/resolution, not the final TUI process state.
- Read-only Claude startup-state verification; explicit resume/model/effort arguments remain a candidate, not proof.
- Claude effort persistence. It remains unknown and always requires an override.
- Personal/work interactive resume through ordinary wrappers and Orca, exact live history/resources/extensions, already-open duplicate handling, restart/reboot, moved real worktrees, unavailable live provider behavior, and legacy-transcript acceptance.
- Agent Resurrect and optional group restoration.

No CLI/launcher wiring, native account settings, credentials, real transcripts, account roots, legacy sources, or Orca resources were edited or copied. No commit or cutover action was performed.

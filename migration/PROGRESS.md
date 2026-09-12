# Migration progress and evidence

Authorities: `DECISIONS.md` and `MIGRATION_PLAN.md`, read completely on 2026-09-12.
Migration-local continuation evidence only. **Partial implementation; NOT cutover-ready.**

## Runtime preflight

- Parent native Pi **0.85.1**, Node **22.23.1**; selected `MPX_PI_EXECUTABLE`. Windows process PID 7000 command line and native transcript `01a097ae-1945-7724-bcfe-433965aef4a0` confirm openai-codex/gpt-6-astra/high; native shell metadata agrees.
- Actual parent flags disable extension/context/skill/prompt/theme discovery and explicitly load only `npm:@tintinweb/pi-subagents@0.14.3` plus the migration append prompt. No SYSTEM.md override exists. Explicit append prompt prevents automatic APPEND_SYSTEM discovery (native loader inspected).
- Standalone artifact: `$PI_CODING_AGENT_DIR/tmp/extensions/npm/f35b2129/node_modules/@tintinweb/pi-subagents`, entry `src/index.ts`. No installed package replaced. Tools: native read/bash/edit/write plus Agent/get_subagent_result/steer_subagent. **No legacy safeguards, MCP or guard hooks.**
- Definitions still come from `$PI_CODING_AGENT_DIR/agents` → `$MPX_PROJECTS/mpx-pi/agents` (23 generated definitions), plus built-ins. Installed schema inspected; no invented fields. `isolated: true` suppresses child extension/skill/context/prompt/theme discovery and orchestration tools, not filesystem access.
- Pilot `2565c2ef-b3dd-498`: background/results/steering worked, but explicit Luna/xhigh became **medium** in recorded native Bash output. Cause: installed invocation resolver gives definition fields precedence despite tool-description override claims; legacy Explore pins medium.
- Second pilot `435c7054-4df6-4d2`, existing unpinned general-purpose, PASSED actual Luna/xhigh with marker `MPX2-GENERIC-STEER`. Used this route thereafter with real model/thinking/isolated fields. No bootstrap/global edits. Sol/high, Sol/medium and Terra/medium execution evidence checked separately; config child initially queried a nonexistent effort variable, then reran the correct `PI_REASONING_LEVEL` check.
- Automatic completion messages were not observed during continuous parent work. Results were retrieved once at dependency barriers, without polling loops. Resumed calls completed synchronously despite requesting background; do not assume notification semantics passed.
- At most four independent children; no nested delegation, schedules or automatic worktree isolation. Test-created worktrees were scoped disposable Git fixtures only.

## Implemented slice

- One private pnpm/TypeScript package; explicit build/typecheck/test/status CLI. All dependencies installed locally with scripts disabled. Running bootstrap dependencies untouched. An unrelated pnpm user-package module-type warning was not suppressed by editing user files.
- `src/compiler.ts`: deterministic native skill/agent projections, semantic profile mapping, exposure mapping, declared placeholders, local references, duplicate/metadata validation, UTF-8 body and support-byte fidelity, scoped drift/build and link-conflict protections. Pi agent filenames use mpx- and thinking; Claude uses mpx- and effort. Complex HTML/nested-parenthesis references and executable-mode transfer still need broader acceptance.
- `src/config.ts`: independent providers; strict two-level JSON; absolute allowlisted environment-expanded paths; account alias checks; Git main/separate-git-dir/linked-worktree resolution; explicit-empty/default/invalid/unavailable selections; concurrent selection isolation.
- `src/launch.ts`, `bin/*`: personal/work native-root selection, additive skill args, warnings/Enter gate, native xpi label/verbose/no-extensions, exit propagation, no default model/effort injection. Mixed-case Windows environment selectors are scrubbed. All caller args remain positional.
- Current canonical content: handoff + checker specialist + runtime profile. Bodies copied by file operations from dirty working sources, not regenerated or HEAD-only. Initial handoff bytes and checker body equality verified. Handoff retains full template/merge/reasoning guidance, uses available native/project/conversation task state, and explicitly gates unavailable optional grill/harvest companions. No other skill retired.
- `migration/INVENTORY.md`: **631 source-file rows + 8 package/installed-capability placeholders**. All 51 current SKILL.md files enumerated, including untracked REPORTING_LINKS support. Most counterpart/dependency leads are explicitly UNVERIFIED. Reviewed slice evidence is preserved separately within that same inventory.
- Initial broad inventory agents exhausted their bounds without writing; replaced by explicit mechanical enumeration. Do not repeat that fan-out. Follow dependency closure in small review/port batches instead.

## Verification

- Compiler/config/launcher TDD red → green, with actual temporary Git/filesystem/process fixtures.
- Real Git Bash wrapper test exposed LF argument splitting at Node→MSYS boundary. Forced CRT quoting for shim argv fixed it. pi/piw/cc/ccw/xpi now pass spaces, empty strings, LF, quotes, trailing backslashes and hostile-looking literals through real disposable shims.
- Independent Terra review reproduced a Windows case-insensitive environment leak. Fixed and regression-tested in an actual spawned child. Terra follow-up found no remaining confirmed defects in that scope. Kept xpi `--verbose`: native loaded-extension visibility, not MPX content injection; reviewer agreed no demonstrated loss.
- `test/native-discovery.test.ts`: separate Pi 0.85.1 SDK processes verify native catalogs, selected generated pack files/support, lazy body/exposure metadata, account separation, native project/shared-global/account/unrelated-package discovery, trust, explicit-empty and concurrent selections, restart stability. **Not interactive invocation or deployed child acceptance.**
- `node migration/upstream-probe.mjs`: published pinned upstream 0.19.0 loaded by native Pi extension loader in a disposable Git/account fixture. Normal resource-discovery adapter yields native-project + mp-selected; upstream named preload still says mp-selected not found. Zero model requests. Exact implementation gap demonstrated; see extensions/README.md.
- Probe drafts: direct tsx/CJS import failure was not native incompatibility; corrected to native loading. A non-Git temp fixture initially discovered ancestor native skill metadata; a Git boundary and exact catalog assertion corrected isolation. No legacy skill/extension execution occurred.
- Final gate: `pnpm build`, `pnpm run typecheck`, `pnpm test` (**37 passed**), `pnpm status`, and repeated `pnpm build` (**0 changes**) passed. Status visibly warns about the not-yet-ported personal pack and labels installed hooks/account/interactive state NOT VERIFIED. Source HEADs and dirty-entry counts rechecked unchanged. Staged-content review and local commit follow; no push/cutover authorized.

## Open gates — do not confuse missing work with approval

- **External blocker:** exact private GitHub owner/name is unconfirmed. No remote created or guessed.
- **Demonstrated runtime gap:** upstream named preload bypasses selected paths and runs before native resource events; selected-pack child integration needs a narrow reviewed adaptation covering both paths. No fork or installed replacement adopted; custom-adaptation/live replacement approval is not inferred.
- **Unimplemented:** native combined resume/picker and actual state checks; sync/project non-skill link management/Orca hook mirroring; approved safeguards/transports; aggregate Orca activity/notifications; footer/titles/compaction/style/machine roots; usable isolated lpi; remaining daily-core and other content/dependency adaptations. CLI sync/project/resume and lpi fail explicitly, never claim success.
- **Untested:** actual Claude additive discovery/subagents; Pi/Claude interactive catalogs/body invocation/multiple mid-prompt skills/Tab; real selected-pack child conversations and model/effort; native Manual prompts and Enter/Ctrl+C; effective MCP/web/question package loading in both accounts; all resume/account/cwd/provider/model/effort/restart/reboot matrices; safeguard interception/fault/deadline matrices; physical terminal scroll/newline; Orca states/alerts/dev ports.
- No personal pack ported yet. Default personal development+personal therefore warns and falls back to native-only; explicit development fixtures and work defaults function. This is not retirement of personal skills.

## Preservation / continuation / reversible cutover

Source heads preserved: mpx b8e323e02c734bff852766cebf2dbc897fc45c49 (184 dirty/untracked status entries), mpx-claude-code ab77de05843c4fde97e8483e7712c327f4cdf59f (2), mpx-pi 8464b23f0aef5bc235699920125e04fb94b84530 (1). Accidental source NUL left untouched/excluded. No source cleanup, account copying, credential/settings/transcript rewrite, global launcher changes, Orca source changes or legacy disconnection.

Continue with bounded retained-content closures and approved child-preload adaptation; then resume, hooks/extensions and installer integration against the authority gates. Do not deploy this partial slice. First human inputs: confirm the exact private remote; resolve narrow upstream-adaptation approval; coordinate interactive and reboot acceptance later.

Cutover is **not yet prepared for execution**. Before any live switch, complete all prerequisite gates, record actual command resolution/owned link and registration targets, and preserve the existing launcher selection. Switch mpx/pi/piw/cc/ccw together through one approved owned entrypoint; never mix old launchers/new content. Verify fresh shells, both accounts and reboot with a human. Roll back all five together to recorded old targets and remove only proven MPX2-managed entries. Keep source checkouts/native accounts intact. Do not disconnect legacy entrypoints, archive repositories, reboot, or rename folders unattended.

---
name: verify-installation
description: 'Run the project verification prompt in personal Pi, work Pi, and work Claude sessions. Invoke explicitly to verify an MPX installation across accounts.'
disable-model-invocation: true
metadata:
  author: MartinoPolo
  version: '0.1'
  mpx:
    projectExposure: explicit-only
---

# Verify installation

Run this repository’s `VERIFICATION_PROMPT.md` in fresh MPX-managed sessions and collect their reports. This is a
project-only orchestration skill, not a globally shipped MPX skill. Invoke with `/skill:verify-installation`.

## 1. Check installation before launching

Resolve the current Git repository root as `SOURCE_ROOT`. Require its `package.json` name to be `mpx-workspace` and
require `VERIFICATION_PROMPT.md` and `docs/INSTALLATION.md` there. Resolve from the current checkout, not this skill’s
possibly relocated compiled directory. Read the installation documentation. Read the prompt once, retain those exact bytes
as the run’s prompt snapshot, and record their SHA-256 before proceeding.

Record HEAD and dirty status; “current version” includes uncommitted source changes. Preserve those changes.
Follow [installation and launch mechanics](REFERENCE.md#installation-preflight) to inspect the selected installed release
without changing installation state. Report `current`, `stale`, `missing`, or `unverified`, with evidence. A version
string, matching generated files, or this parent session’s content projection alone cannot prove checkout freshness.

**Gate:** If freshness is not proven, warn and ask: “Install the current MPX checkout with `pnpm run setup` before
verification?” Recommend installation; offer cancel as the alternative. Do not launch tests before this decision.

If approved, run exactly `pnpm run setup` from `SOURCE_ROOT`, with captured output and a bounded timeout. This approval
covers the documented build and installation, not dependency installation or unrelated repairs. Stop if setup fails.
After success, verify its strict-verification result and newly selected release identity; ensure source changes have not
occurred during setup. If that evidence is inconclusive, stop rather than claiming freshness. Fresh child launches use
the installed release; the already-running parent may still have old instructions.

## 2. Prepare the matrix

Resolve each machine root from the process environment, normalize it to an absolute path, and verify the target exists
and remains beneath its root. Do not search for similarly named projects or substitute directories.

| Run         | Runtime     | Identity | Project                            | Requested model             |
| ----------- | ----------- | -------- | ---------------------------------- | --------------------------- |
| personal-pi | Pi          | personal | `MPX_PROJECTS` + `prejemesi`       | `openai-codex/gpt-5.6-luna` |
| work-pi     | Pi          | work     | `MPX_WORK` + `yoursafe-components` | `openai-codex/gpt-5.6-luna` |
| work-claude | Claude Code | work     | `MPX_WORK` + `yoursafe-components` | `haiku`                     |

Use explicit managed identities, equivalent to `pi-mpx`, `piw-mpx`, and `ccw-mpx`. Native `piw` and `ccw` are not
substitutes. Do not reuse this parent session or emulate these runs using same-account subagents.

Resolve `MPX_AI_GENERATED` and create a unique `_MPX_VERIFICATION/<run-id>/` directory for the prompt snapshot, captured
outputs, and summary. Require an absolute, accessible root; do not guess a fallback. Keep reports local and redact
credentials from summaries. Write the retained prompt bytes unchanged into `prompt.md` and verify its SHA-256 against the
preflight snapshot. Use only this snapshot for every target; do not reread a concurrently changed source prompt.

## 3. Launch and wait

Follow the concrete argv and input contract in [launch mechanics](REFERENCE.md#fresh-managed-launches).
Run targets sequentially to avoid browser and server collisions. Send the entire prompt snapshot through stdin to each
fresh session, with the target project as its actual working directory. Do not send the parent’s instruction inventory,
resolved environment values, or expected answers.

Use structured model arguments, never model names in prompt prose. Preserve normal account credentials, project trust,
and permission policy. Do not enable bypass permissions or change native account configuration. An interactive approval
requirement in a headless session is a reportable blocker, not permission to bypass it.

Wait for each foreground process to finish, with a ten-minute limit per run. Capture stdout, stderr, exit status, and
elapsed time separately. Use execution tooling that owns and terminates its launched process tree on timeout; if that
is unavailable, report a supervision blocker instead of starting an unmanaged background process.

A launch acknowledgment is not a report. Require a completed diagnostic answer and available runtime evidence of the
actual model, identity, and project. If model evidence is absent, mark model selection unverified; if it differs, mark
the run invalid. Do not silently accept a default model or relaunch with a different one.

Continue the remaining targets after a target-specific error. Preserve partial output and first errors without repair.
If a child leaves a server/browser resource behind, clean up only verified run-owned resources. If ownership cannot be
established, report the leftover and block a later target that would collide with it.

## 4. Report

Save each final child report beside its raw output. Write `SUMMARY.md` with:

- Installed freshness evidence, installation approval/result if applicable, and the selected release key.
- Prompt path/hash and the resolved target paths.
- Per run: requested/observed model, identity, cwd, exit status, completion status, and report path.
- The child’s capability failures, kept distinct from orchestration failures or unverified execution metadata.
- Any partial runs, blockers, or owned resources left behind.

Return a compact matrix and links to the reports. Do not turn a zero exit status into “all capabilities passed,” and do
not claim live verification for a run that never produced a completed report.

# Orca Execute and Orchestration — Exploration and Grill Starter

## Purpose

Determine whether the portable MPX `execute`, `review`, batch, and continuation workflows should use
Orca Runs/Tasks/Dispatches or remain harness-native coordinator skills. Preserve workflow value
without making Orca mandatory for ordinary Claude/Pi use.

This is a post-core-migration investigation. It does not authorize rewriting `execute` during the
initial MPX2 cutover. Ordinary native-session resume is a separate critical cutover requirement in
[MIGRATION_PLAN.md § Resume](MIGRATION_PLAN.md#resume). Its implementation may retain Agent Resurrect
or use explicitly agreed native restoration outside Orca; neither restored transcripts nor new Orca
terminals prove that Run/worker orchestration has resumed.

## Questions to answer

- Which current orchestration responsibilities are domain workflow versus MPX control-plane glue?
- Can Orca supply worker creation, worktree placement, status, cancellation, recovery, review, and
  cleanup while a portable skill retains issue analysis, TDD, review policy, CI handling, and
  close-out decisions?
- What behavior remains when the same skill runs outside Orca?
- Can one skill detect Orca capability without hard failure or hidden fallback behavior?
- Does Orca expose enough structured state to replace MPX subagent result envelopes and task state?
- How do account-specific `piw`/`ccw` workers and correct post-reboot resume interact with Orca
  orchestration, including saved provider/model and effort? Which Run state must be restored in
  addition to the native session, and how is lost orchestration made visible?

## Sources to inspect

### Current workflow intent

- `C:/_MP_projects/mpx/content/skills/execute/`
- `C:/_MP_projects/mpx/content/skills/review/`
- `C:/_MP_projects/mpx/content/skills/check-fix/`
- `C:/_MP_projects/mpx/content/skills/batch-execute/`
- `C:/_MP_projects/mpx/content/skills/continue/`
- `C:/_MP_projects/mpx/content/instructions/shared/SUBAGENT_PROTOCOL.md`
- `C:/_MP_projects/mpx/content/instructions/shared/REPAIR_ORCHESTRATION.md`
- corresponding earlier variants in `mpx-claude-code` and `mpx-pi`.

### Orca authority

Use the local clone at `C:/_MP_github_cloned/orca` and state the inspected commit. Begin with:

- `skills/orchestration/SKILL.md`
- `skill-guides/orchestration.md`
- `skill-guides/orchestration/references/`
- `docs/site/content/docs/cli/orchestration.mdx`
- `docs/site/content/docs/cli/automations.mdx`
- CLI specs and RPC contracts for runs, tasks, dispatches, workers, checkpoints, and cleanup.

Distinguish stable shipped interfaces from feature-wall UI, experiments, branches, and open PRs.

## Capability ledger

For each current `execute` phase, record:

```text
phase | portable workflow rule | current MPX mechanism | Orca mechanism |
outside-Orca fallback | structured evidence | gaps | proposed owner
```

At minimum cover:

1. issue discovery and plan;
2. worktree creation and placement;
3. TDD execution;
4. parallel specialist review;
5. finding consolidation and repair;
6. commit/push/PR creation;
7. CI watch and fix loop;
8. unresolved-issue routing;
9. status, cancellation, retry, and session-limit recovery;
10. cleanup, merge, and worktree retirement.

## Experiments

Run read-only/source investigation first, then propose a disposable pilot. The pilot should compare:

1. Current portable skill delegation in native Pi or Claude.
2. An Orca coordinator that dispatches the same specialist agents into Orca-owned workers.
3. Running the portable skill outside Orca with no Orca CLI available.
4. Interrupted worker recovery after Orca quit and after machine reboot.
5. Personal and work account routing, especially work workers launched through wrappers.
6. One small issue through TDD, review, PR, CI, and cleanup.

Capture commands, JSON envelopes, worktree state, status transitions, user interactions, and failure
recovery. Do not use a production issue for the first experiment.

## Grill topics

After evidence exists, ask the user:

1. Should Orca be an optional accelerator or the required executor for `execute`?
2. Should the skill create an Orca Run automatically, propose it, or only use one when already inside
   a Run?
3. Which phases deserve separate visible workers versus inline subagents?
4. Should TDD and reviewer specialists remain portable native agent definitions?
5. Should Orca Tasks become the authoritative task list, or remain an observational mirror of the
   workflow?
6. How much automatic retry is acceptable before a worker asks for intervention?
7. Should orchestration continue after the coordinator session exits?
8. How should the verified native resume path restore and identify work-account workers after reboot?
   Coordinate with the resume follow-up rather than designing a competing scanner/launcher.
9. Which JSON result contracts remain valuable, and which existed only to support MPX's old session
   platform?
10. Should merge and cleanup remain default automation or require explicit approval in Orca?
11. What is the minimum useful outside-Orca behavior?
12. Which Orca-specific behavior belongs in a small adapter/reference rather than the universal skill
    body?

## Preferred architecture to test

Test a layered design rather than an Orca-only rewrite:

- portable canonical workflow owns product decisions and phase semantics;
- portable specialist agents own analysis, TDD, review, and focused fixes;
- an optional Orca adapter owns runs, dispatches, worktrees, terminal lifecycle, status, and cleanup;
- outside Orca, native harness delegation remains functional with reduced observability;
- no MPX worktree/session/task-state service is recreated.

Reject the layered design if the pilot shows it is more complex or less reliable than maintaining
one portable workflow.

## Decision output

Produce a concise follow-up plan containing:

- capability ownership table;
- selected Orca integration boundary;
- outside-Orca contract;
- exact skill/agent files to adapt;
- required Orca configuration or upstream changes;
- acceptance tests and rollback;
- explicit non-goals.

Do not merge this plan into the core MPX2 migration until the user approves it.

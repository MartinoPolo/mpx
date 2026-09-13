---
description: Recovers interrupted child work after a session-limit hit or crash, preserving durable progress
disable-model-invocation: true
metadata:
  author: MartinoPolo
  category: utility
  version: "0.4"
name: mp-continue
---

# Continue and Recover

On resume after an interruption, first restore interrupted child and background work, then continue.
If the invocation input names a focus or task, recover it first. If nothing was interrupted,
continue the latest task normally.

A session-limit hit can terminate every running child at once. A child may leave only a limit
result. This workflow restores that work without repeating durable progress. Work only in the
user-selected Orca checkout; do not discover or coordinate work in other checkouts.

## 1. Detect whether recovery is needed (self-gate)

Use the native Agent result and status capabilities available in pi to inspect children
launched by this session and retrieve their latest structured states and results. Real interruption signals include:

- a child's last result containing only a capacity/runtime failure such as `hit your session limit`,
  `usage limit`, `rate limit`, `overloaded`, an API error, or `[Request interrupted]`;
- an unfinished child with no active execution or matching completion result.

Conversation wording alone is not proof. A completed child, an ordinary failed check, or an idle
service the task does not need does not trigger recovery.

**No interruption:** continue the most recent task normally and stop this workflow. Skip the
recovery steps below.

## 2. Assess durable work before redoing anything

A killed child may have finished most of its brief. Before steering or respawning:

```bash
git status
git diff --stat
```

1. Inspect repository status and the current diff without changing them.
2. Inventory durable artifacts: changed/generated files, numbered evidence, screenshots or scripts
   under `test-results/`, test results, `HANDOFF.md`, memory notes, and project-defined scratch
   artifacts.
3. Run only a quick check the repository already defines or the user supplied. Do not invent a
   command.
4. For every interrupted child, record its original brief, latest structured result, what exists on
   disk, and only the remaining scope.

**Disk artifacts are the reliable recovery substrate.** Never restart from zero merely because the
conversational result is incomplete. For future long runs, have children write numbered evidence as
they go and keep `HANDOFF.md` current.

## 3. Recover each interrupted child

For each interrupted child ID, in priority order:

1. Retrieve its latest structured result and current state.
2. If it remains addressable, steer the original ID. Tell it which artifacts survived and ask it to
   resume only the remaining scope.
3. If steering succeeds (for example, the runtime reports `resumed from transcript...`), retrieve
   the new result and verify it against the original brief.
4. If the runtime reports `No transcript found for agent ID`, another missing-transcript result, an
   unresumable child, or rejected steering, spawn a fresh matching canonical agent for only the
   remaining work. Point it at surviving artifacts and require it to inventory them before editing.
5. If replacement launch is unavailable, preserve the remaining scope in the report and continue
   independent work.

Match the replacement to the original task, for example `mpx-executor` for pre-analyzed edits or the
canonical browser-testing agent for an interactive browser loop. Use `mpx-explorer` for repository
search. If a generic agent is unavoidable, select the canonical class through structured runtime
configuration: `advanced` for implementation/orchestration, `standard` for review or bounded
judgment, `exploration` for search, and `mechanical` for polling or one deterministic command. Never
embed vendor model IDs in instructions.

Do not depend on a provider's private message API, task-list UI, account storage, or transcript
representation. Agent result, steering, and launch are runtime capabilities; do not locate or
interpret native transcript files.

## 4. Restore project-server prerequisites manually

MPX does not manage development-server processes or port state. If recovered work needs a server,
check only the parent-provided URL. When it is unavailable or stale, ask the user to start or restart
the project server in Orca and supply the actual URL. Do not inspect, kill, or replace arbitrary
processes and do not guess an endpoint.

## 5. Delegate recovery busy-work

Preserve the original delegation intent. Re-running suites, inventorying artifacts, and retesting
flows belong in resumed or matching canonical children; the main session coordinates, validates
results, and continues the active task.

## 6. Continue and report

After dependencies are restored, continue the active task. Report:

- children resumed with original context;
- children respawned and the bounded remaining scope assigned to each;
- interrupted work with no recoverable context or artifacts;
- manually restored project-server prerequisites and their observed URL state;
- durable work preserved; and
- work still remaining.

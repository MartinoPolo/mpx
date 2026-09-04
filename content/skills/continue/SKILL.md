---
name: continue
description: 'Recovers interrupted child work and managed development services, then continues the active task.'
metadata:
  mpx:
    schemaVersion: 1
    skillPacks: [work]
    defaultExposure: explicit-only
---

# Continue and Recover

Recover work after a runtime interruption without repeating work that is already durable. If the invocation input names a focus or task, assess and recover it first.

## 1. Detect an interruption

Use the runtime Agent contract to inspect children launched by this session and retrieve their latest structured states and results. Treat a child as interrupted only when its state or result reports an interruption, runtime or capacity error, lost execution, or an unfinished child with no active execution. Also inspect managed services only when the active work depends on them.

Conversation wording by itself is not proof of an interruption. A completed child, an ordinary failed check, or an idle service that the task does not need does not trigger recovery.

**No interruption:** continue the most recent task normally and stop this workflow. Do not run the recovery steps below.

## 2. Assess durable work first

Before steering or respawning anything:

1. Inspect repository status and the current diff without changing them.
2. Inventory durable artifacts already produced, such as changed files, generated evidence, test results, handoff notes, and project-defined scratch artifacts.
3. Run only a quick check that the repository already defines or the user supplied. Do not invent a command.
4. For every interrupted child, record its original brief, its latest structured result, what exists durably, and only the remaining scope.

Durable artifacts are the recovery substrate. Never restart a child from zero merely because its conversational result is incomplete.

## 3. Recover children

Handle each interrupted child through the runtime Agent contract:

1. Retrieve each child's latest structured result and current state before acting.
2. When the child remains addressable, steer it using the same child ID. Tell it what artifacts survived and ask it to continue only the remaining scope.
3. Retrieve the resulting child result and verify it against the original brief.
4. If the runtime reports a missing transcript or other unavailable recovery context, says that the child cannot be resumed, or rejects steering, respawn a matching child with only the remaining scope. Treat that report only as a capability result; do not locate or interpret native transcript storage. Point the new child at the durable artifacts and require it to inventory them before editing.
5. If the runtime cannot launch a replacement, keep the remaining scope in the report and continue with independent work.

Do not depend on a provider's private message API, task-list UI, account storage, or transcript representation. The child result and steering operations above are capabilities of the runtime Agent contract, not assumptions about how a runtime persists conversations.

## 4. Recover managed development services

Use the runtime `dev_server` contract; do not inspect native processes or assume a network address.

1. Query `status` for each configured service ID required by the recovered work.
2. Leave a ready service alone.
3. For a stopped, crashed, or unresponsive managed service, use `restart` with the configured service ID and its existing launch-bound assignment.
4. Confirm readiness through `status`. If the service remains unhealthy, report it instead of changing its command, executor, working root, or assigned endpoints.

The runtime owns process trees, readiness probes, endpoint assignments, and orphan cleanup. Recovery must not kill arbitrary processes or substitute a fixed endpoint.

## 5. Continue and report

Continue the active task after dependencies are restored. Summarize:

- children steered with their original context;
- children respawned and the bounded remaining scope assigned to each;
- interrupted work with no recoverable context or artifacts;
- managed services restarted and their final state;
- durable work preserved; and
- work still remaining.

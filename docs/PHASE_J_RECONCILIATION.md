# Phase J reconciliation, cutover, and rollback

Phase J tooling is deliberately non-destructive. It does not disable or delete either legacy installation, alter native Claude/Pi state, archive or rename a repository, or change a remote.

## Stable JSON commands

Run from the canonical MPX checkout with `MPX_PROJECTS` set:

```text
mpx --json --cwd . migration reconcile
mpx --json --cwd . migration report
mpx --json --cwd . migration report --legacy-disabled
mpx --json --cwd . migration cutover-plan --legacy-disabled
mpx --json --cwd . migration rollback-drill
```

All results use the normal MPX success/error envelope. Payloads have `schemaVersion: 1` and a stable `kind`. `reconcile` compares the current tracked, modified, deleted, renamed, and untracked trees of `${MPX_PROJECTS}/mpx-claude-code` and `${MPX_PROJECTS}/mpx-pi` with the immutable F1 convergence baseline. Private account/auth/session/history/trust/environment paths are classified but never hashed or read into evidence. Paths are symbolic or relative.

`report` emits every F1 source entry with destination, disposition, evidence, and current drift state. It executes the declared semantic, generation, hooks, runtime-tools, status, and dependency checks through direct local Node/Vitest entry points—never a shell or downloader. Each check and the suite have bounded timeouts and a narrow environment. Results are `passed`, `failed`, `timed-out`, `unavailable`, or `not-run` with exit code and bounded output digests only. Missing, duplicate, or non-passing check results fail the gate. The gate also requires zero explicit exceptions and a complete disposition/evidence map. `docs/phase-j-exceptions.json` remains authoritative and intentionally non-empty while live gates remain.

Read-only migration commands may retain combined drift, parity, audit, and gate evidence beneath absolute `%LOCALAPPDATA%/mpx/migration-observations`. Evidence is deterministic bounded JSON named by its SHA-256 digest, written create-only with private permissions, synchronized, and verified. Existing evidence is reused only when it is the same safe regular file with byte-identical content; links, replacement races, and collisions fail closed. Command output exposes only the evidence kind, schema, digest, created/reused disposition, and symbolic storage label—not its path. These observations do not update repository history.

The installed-runtime audit is read-only. It observes both `%APPDATA%/mpx/logs` and `%LOCALAPPDATA%/mpx/logs`, running-process command lines, environment bindings, and exactly four named runtime routes: `claude-personal`, `claude-work`, `pi-personal`, and `pi-work`. Those routes bind only from their corresponding `MPX_CLAUDE_PERSONAL_PROJECTION_ROOT`, `MPX_CLAUDE_WORK_PROJECTION_ROOT`, `MPX_PI_PERSONAL_PROJECTION_ROOT`, and `MPX_PI_WORK_PROJECTION_ROOT` variables; there is no fallback or deduplication. Missing directories and unconfigured route variables are reported with safe labels and block acceptance without aborting observation. Relative, duplicate, linked, non-directory, inaccessible, replaced, or unreadable roots fail closed with structured errors. Output contains only surface labels and hashes; it does not serialize command lines, roots, environment values, prompts, or credentials. `--legacy-disabled` is an acceptance assertion, not a switch: it never disables legacy activation and passes only when all targets were observed with zero findings. Offline acceptance can set `MPX_MIGRATION_PROCESS_SNAPSHOT` to a bounded inline JSON array of captured command lines; it is never interpreted as a file path, and malformed snapshots fail instead of falling back to live discovery.

## Offline native-resource contract and live limit

Automated Windows acceptance uses uniquely named temporary files for the PowerShell profile and Windows Terminal settings, applies and removes the real byte/JSON adapters, and verifies the original foreign bytes and profiles are restored. It also uses a real credential-free Claude subprocess for active discovery/resume JSON and a real owned Pi subprocess through the Windows process-inspector boundary. Registry and Scheduled Task contracts remain read-only or in-memory mocked because mutating HKCU or Task Scheduler from an unattended test can alter the developer's live login environment or leave startup work behind. The suite therefore does **not** claim live registry broadcast, live Terminal reload, real Task Scheduler registration/manual execution, legacy disablement, or a real cutover/rollback. Those OS/live operations require an explicitly approved disposable Windows account or VM and cleanup evidence.

## Future cutover confirmation

`cutover-plan` strictly inspects only the owned marker declarations in `docs/phase-j-owned-activations.json`. Each target is classified as exact, absent, malformed, inaccessible, or raced; safely read files contribute only a content digest. Every non-exact status blocks eligibility and is bound into the returned `confirmationDigest`. This command never applies the plan. Archive, rename, and remote changes are manual-only proposals. Real legacy activation and native state remain untouched in Phase J preparation. `docs/history/PHASE_J_CUTOVER_PLAN.json` is historical offline/example evidence only. It is not a current proposal or live observation and must not be applied.

Before any future apply, a human must save the JSON plan, verify its digest independently, take immutable machine snapshots, and use a separate implementation that accepts that exact digest. No broad line, file, directory, repository, or native-state deletion is authorized.

## Rollback window and drill

Rollback snapshots are immutable content-addressed bytes retained for **30 days** from the confirmed cutover. The automated drill creates a temporary profile simulation, writes a create-only content-addressed snapshot, removes one unique owned marker block from a separate active fixture, restores the original bytes, and verifies the digest. It reports `realStateTouched: false`; the latest evidence is `docs/history/PHASE_J_ROLLBACK_DRILL.json`. A live cutover remains blocked until this simulation, installed-runtime snapshot verification, and the post-cutover full acceptance suite all pass.

## Current blockers

- retained launch-bound standalone-`sbx` V2 plan/report, host-Pi tool/OAuth and Claude routes, mount/port/containment observations, and default-executor decision;
- completed normal-use observation window;
- zero-finding installed four-route audit in asserted legacy-disabled mode;
- separately confirmed exact-marker cutover followed by the full acceptance suite and live rollback proof.

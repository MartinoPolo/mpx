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

`report` emits every F1 source entry with destination, disposition, evidence, and current drift state. It separately records semantic, generation, hooks, runtime-tools, status, and dependency evidence. The gate requires both zero explicit exceptions and a complete disposition/evidence map. `docs/phase-j-exceptions.json` is authoritative and intentionally non-empty while live gates remain. Fresh, privacy-safe captures are retained in `docs/history/PHASE_J_SOURCE_DRIFT.json` and `docs/history/PHASE_J_PARITY_REPORT.json`.

The installed-runtime audit is read-only. It scans bounded MPX logs, running-process command lines, environment bindings, and runtime projections for old paths/config/command namespaces. Output contains only surface labels and hashes; it does not serialize command lines, paths, environment values, prompts, or credentials. `--legacy-disabled` is an acceptance assertion, not a switch: it never disables legacy activation and passes only when the audit has zero findings. The credential-free acceptance fixture is `apps/cli/src/fixtures/legacy-disabled-acceptance.json`. Offline acceptance can set `MPX_MIGRATION_PROCESS_SNAPSHOT` to an explicit JSON array of captured command lines; malformed snapshots fail instead of falling back to live discovery.

## Offline native-resource contract and live limit

Automated Windows acceptance uses uniquely named temporary files for the PowerShell profile and Windows Terminal settings, applies and removes the real byte/JSON adapters, and verifies the original foreign bytes and profiles are restored. It also uses a real credential-free Claude subprocess for active discovery/resume JSON and a real owned Pi subprocess through the Windows process-inspector boundary. Registry and Scheduled Task contracts remain read-only or in-memory mocked because mutating HKCU or Task Scheduler from an unattended test can alter the developer's live login environment or leave startup work behind. The suite therefore does **not** claim live registry broadcast, live Terminal reload, real Task Scheduler registration/manual execution, legacy disablement, or a real cutover/rollback. Those OS/live operations require an explicitly approved disposable Windows account or VM and cleanup evidence.

## Future cutover confirmation

`cutover-plan` reads only the exact owned marker pairs declared in `docs/phase-j-owned-activations.json`. An action is eligible only when the complete live gate passes and each marker pair is unique and intact. The returned `confirmationDigest` binds the whole plan; this command never applies it. Archive, rename, and remote changes are manual-only proposals. Real legacy activation and native state remain untouched in Phase J preparation. The current blocked proposal is captured in `docs/history/PHASE_J_CUTOVER_PLAN.json`.

Before any future apply, a human must save the JSON plan, verify its digest independently, take immutable machine snapshots, and use a separate implementation that accepts that exact digest. No broad line, file, directory, repository, or native-state deletion is authorized.

## Rollback window and drill

Rollback snapshots are immutable content-addressed bytes retained for **30 days** from the confirmed cutover. The automated drill creates a temporary profile simulation, writes a create-only content-addressed snapshot, removes one unique owned marker block from a separate active fixture, restores the original bytes, and verifies the digest. It reports `realStateTouched: false`; the latest evidence is `docs/history/PHASE_J_ROLLBACK_DRILL.json`. A live cutover remains blocked until this simulation, installed-runtime snapshot verification, and the post-cutover full acceptance suite all pass.

## Current blockers

- pinned live standalone-`sbx` F2 attestation and default-executor decision;
- completed normal-use observation window;
- zero-finding installed four-route audit in asserted legacy-disabled mode;
- separately confirmed exact-marker cutover followed by the full acceptance suite and live rollback proof.

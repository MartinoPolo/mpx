# Worktree lifecycle service

## CLI and shell selection

All automation-capable commands support the standard `--json` envelope:

```text
mpx worktree create <branch> [--base <ref>] [--execution foreground|background|none]
mpx worktree remove <path>
mpx worktree list
mpx worktree select --path <path> [--machine]
mpx worktree status
mpx worktree prepare <lifecycle-key> [--package-approval <phrase>] [--explicit-executable-approval <phrase>]
mpx worktree cancel <lifecycle-key>
mpx worktree reconcile [--orphan-approval <exact-approval>]
```

There is deliberately no `--yes`, trust bypass, forced removal, or branch deletion option. Reconciliation reports orphan identities and an exact content-bound approval before it can release them.

Machine selection writes exactly one path plus a newline. `--cancel` writes nothing. Source `scripts/mpx-worktree.bash` or dot-source `scripts/mpx-worktree.ps1` to define the optional `mpxw` function; neither script runs a command, installs a profile, or changes directory when loaded.

`@mpx/worktrees` provides injected create, remove, status, reconcile, include-copy, and preparation APIs. Public results are versioned (`schemaVersion: 1`, `owner: "mpx"`) so a CLI can consume them without parsing prose. Failures use stable `MpxError.code` values.

## Repository identity and naming

`resolveRepository` asks Git for `--git-common-dir`, canonicalizes the main checkout, and requires a schema-valid `mpxconfig.json` at that root. A linked-checkout CWD therefore resolves to the same repository lifecycle and lock as the main checkout.

`deriveWorktreePath` maps a validated slash branch below the dedicated sibling root:

```
<main-parent>/<repository>.worktrees/<branch-path>
```

Absolute paths, traversal, backslashes, malformed Git ref components, root escape, and occupied targets are rejected. Base precedence is explicit input, `workflow.branch.base`, then the configured remote HEAD. There is no `main`/`master` fallback.

## Create

`WorktreeLifecycleService.create` holds the repository lock across the mutation. It invokes Git directly with the argv vector:

```
git worktree add -b <branch> <target> <base>
```

No shell, editor, terminal prompt, server, or branch-name interpolation is used. Before Git, the `creating` document records the exact hash of the resolved durable project configuration; every resume must match that evidence. After Git succeeds it records `created`, performs an injected content-bound `.worktreeinclude` copy when requested, and durably records `allocating` before calling the idempotent port ensure operation. A crash or write failure after registry allocation therefore retries ensure and reattaches the same lease instead of allocating or releasing another one. It then runs the validated foreground/background/none preparation plan. Port allocation never precedes Git creation. A Git failure leaves no new lease. A later failure leaves the worktree and bounded lifecycle diagnostics available for recovery.

`.worktreeinclude` plans enumerate ignored/untracked files through Git `-z`, reject links/reparse points and path escape, hash every source and the include manifest, and issue an exact content-bound approval phrase. Execution re-plans and refuses stale approval, tracked destinations, existing files, and destination links. A hash-identical existing destination is accepted only when durable evidence proves recovery of the same approved copy that was interrupted after writing that file; ordinary pre-existing files remain conflicts. The Node include adapter resolves every Git invocation from a fixed OS/machine allowlist to a canonical absolute regular file; inherited `PATH`, repository shims, relative paths, symlinks, and junctions never select Git. It never invokes a shell, permits terminal prompting, or enables an editor.

## Remove

Removal inventories Git and validates the durable repository, branch, key, and canonical path binding before mutation. By default it refuses the canonical main checkout and dirty, locked, prunable, or externally in-use worktrees. An MPX-owned preparation worker is not classified as external use: removal first cancels it to a verified terminal state, then checks external use. The production external-use check refuses a target equal to or containing the operation CWD (using Windows case-insensitive canonical containment). It does not claim to inspect arbitrary open handles. Detached worktrees without durable repository-and-branch identity fail closed.

Removal uses only non-forced `git worktree remove <path>`. It does not delete the branch and does not manually delete Git administration directories. Before Git mutation, `removing` durably binds the immutable full release identity. After Git succeeds, `git-removed-awaiting-lease-release` is persisted before release. Release and final-state failures are restart-safe: reconciliation retries the exact identity-bound idempotent release and retains the removal history until `removed` is durable.

## Status and reconciliation

`status` returns porcelain-z Git inventory. `reconcile` compares that inventory with lifecycle state, preparation-worker identity, and the port registry. A pending MPX removal is completed only with its persisted release identity. Manual/Fork deletion outside that protocol is marked as external deletion; existing failure history is retained. Missing linked leases are reported as orphans and are not released implicitly. Call the port service's explicit orphan resolution with the captured identity to release one.

## Production foundation

`createNodeLifecycleFoundation(stateRoot)` supplies argv-only Git execution, canonical repository resolution, dirty and in-use detection, atomic lifecycle documents, and a cross-process repository lock. Every lifecycle document must satisfy `state.key === deriveLifecycleKey(state.repositoryIdentity, state.branch)` on load and persistence; create, remove, reconcile, and manual preparation entry points revalidate that identity before effects. Git is launched with `shell: false`, hidden windows, terminal prompting disabled, and inert editor variables. The CLI composes that foundation with the port service and the production preparation adapters; library callers must still inject those privileged boundaries explicitly.

Preparation state and bounded logs live below `%LOCALAPPDATA%/mpx/worktrees/preparation`, never in a checkout. Same-directory temporary files are synced and atomically renamed. Logs retain only the configured UTF-8 tail and redact every approved environment value; persisted approval and process documents contain environment names, not values.

Run `mpx worktree prepare <lifecycle-key>` without approval options to capture current retry evidence. This command is the only retry transition: it accepts only a persisted, verified `failed` or `cancelled` preparation, then creates a fresh run identity under the preparation CAS lock while retaining prior run diagnostics. Active and `unknown` runs fail closed. Normal create and reconcile first inspect persisted preparation state; they never retry a terminal run or replace an active run, and only a genuinely missing state starts the exact durable approved request once. Package install/script steps return `APPROVE PACKAGE AUTOMATION <sha256>`; explicit argv steps return the separate `APPROVE EXPLICIT EXECUTABLES <sha256>`. A mixed plan requires both through `--package-approval` and `--explicit-executable-approval`. Evidence binds the canonical Git common directory, exact `HEAD`, main configuration bytes, repository package manifests and lockfiles, resolved package-script bodies, and each step's direct argv, cwd, environment-name set, timeout, required flag, canonical executable path, and executable hash. Missing, stale, or wrong-kind evidence fails before spawn; there is no reusable `--yes` or internal trust switch.

Package operations require one unambiguous supported root lockfile matching the configured manager. Privileged Git, package managers, and explicit argv executables come only from the fixed/OS-verified trusted allowlist outside repository/worktree writable roots. Executable canonical path, bytes, size, and modification identity are revalidated immediately before every spawn; a pathname swap fails closed. MPX starts only direct argv vectors with `shell: false`; it does not concatenate or interpolate command text. Child environments contain the small Windows process baseline plus explicitly approved names. Package-manager lifecycle and script code remains arbitrary repository code and therefore requires package approval.

Background preparation uses a one-time state-local request and inherited worker token. The internal worker consumes that request, rechecks the same approval evidence, and cannot be selected as a public trust bypass. The parent returns only after PID, OS creation-time fingerprint, random owner token, and preparing state are durably recorded. Cancellation and timeout compare all three ownership fields before the narrow Windows adapter recursively stops only that process tree. The adapter uses CIM/`Stop-Process`; it never invokes `taskkill` or another broad name/port kill. A missing process, marker, worker, mismatched token, or reused PID reconciles to `unknown` without termination.

`NodeRepositoryLock` publishes a complete owner document by atomic directory rename. The document binds a random token, PID, acquisition time, and process-start fingerprint obtained from its injected `ProcessIdentityInspector`. Contenders reclaim only a definitively absent process, a live PID with a different fingerprint, or missing/malformed owner metadata after the bounded ownerless grace; unknown inspection fails closed and times out. Recovery atomically renames the lock to quarantine before deletion, and release deletes only a lock whose token still matches.

`createNodeLifecycleFoundation` exposes `processIdentityInspector` as an injection hook. The CLI wires it to `WindowsProcessCapabilities.inspect`, passes the operation CWD, and composes persisted preparation-worker verification. Unknown inspection fails closed for lock recovery. The portable fallback identifies the current Node process, detects definitive process absence, and otherwise fails closed. It creates no native state. `NodeLifecycleStateStore` uses same-directory temporary files, file sync, and atomic rename. Machine-local state belongs under a caller-selected user-state root and is never committed.

Selection remains explicit. `FileMruStore` records successful selection but MRU is never an implicit worktree selector.

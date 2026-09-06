# Session lifecycle

MPX lifecycle events remain authoritative for sessions they represent. The public CLI exposes only:

```text
mpx session list
mpx session resume <id>
```

`session list` automatically consumes pending lifecycle events and performs bounded reconciliation for each exact configured identity/runtime root. Claude and Pi scanners never search a home directory. Scanner failures and malformed data become bounded normalized diagnostics, so existing durable records remain available without exposing native paths, command output, credentials, prompts, or transcripts. Reconciliation refreshes stale liveness before records are returned.

Identity/runtime list filters also scope reconciliation before lifecycle-binding consumption, discovery, process inspection, and registry transactions. Liveness and workflow filters apply after reconciliation; they never bypass liveness verification. Unfiltered reconciliation intentionally covers all partitions. Eligible Pi records share one fresh, bounded Windows CIM snapshot per reconciliation, deduplicated by PID; inspectors without batch support use bounded parallel probes. Missing processes become inactive only after a valid snapshot, while malformed results and reused PIDs remain unknown with their original process fingerprints preserved.

Native bindings persist only the deterministic identity/runtime/canonical-root-digest tuple. MPX has no account enrollment registry or attestation reference. During `mpx setup`, a bounded local reset removes only the obsolete registry and legacy native-binding records that carried the deleted reference; current bindings, session records, and unrelated local files are preserved. Recovery is `mpx setup` followed by `mpx doctor` when needed.

Pi discovery and resume verify the exact configured real directory and invoke native Pi's bounded `auth check`; planning fails closed before project discovery when either check fails, and execution repeats both checks immediately before child spawn. Claude retains its native-root behavior without Pi authentication. The confirmed plan preserves the runtime's exact native resume argv and host-versus-Docker admission policy.

`mpx session resurrect-export` is an executable internal route omitted from public help and generated references. It consumes pending lifecycle events and exports only bounded normalized resurrection metadata; it does not trigger broad discovery. Resurrection execution requires explicit one-use authority.

Installation is one bare, idempotent `mpx setup` operation. Receipt-safe upgrades preserve exact ownership, failed applies roll back automatically from durable journals and snapshots, and restart recovery remains internal. No public uninstall, rollback, or external-integration action protocol is exposed.

Legacy import, branch, public reconcile, show, inbox, mark, capture, handoff, and completion routes are not session operations.

# Session lifecycle

MPX lifecycle events remain authoritative for sessions they represent. The public CLI exposes only:

```text
mpx session list
mpx session resume <id>
```

`session list` automatically consumes pending lifecycle events and performs bounded reconciliation for each exact configured identity/runtime root. Claude and Pi scanners never search a home directory. Scanner failures and malformed data become bounded normalized diagnostics, so existing durable records remain available without exposing native paths, command output, credentials, prompts, or transcripts. Reconciliation refreshes stale liveness before records are returned.

Native bindings persist only the deterministic identity/runtime/canonical-root-digest tuple. MPX has no account enrollment registry or attestation reference. Pi discovery and resume verify the exact configured real directory and invoke native Pi's bounded `auth check`; resume repeats both checks immediately before child execution. Claude retains its native-root behavior without Pi authentication. The confirmed plan preserves the runtime's exact native resume argv and host-versus-Docker admission policy.

`mpx session resurrect-export` is an executable internal route omitted from public help and generated references. It consumes pending lifecycle events and exports only bounded normalized resurrection metadata; it does not trigger broad discovery. Resurrection execution requires explicit one-use authority.

Legacy import, branch, public reconcile, show, inbox, mark, capture, handoff, and completion routes are not session operations.

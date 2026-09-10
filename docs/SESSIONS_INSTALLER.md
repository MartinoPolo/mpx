# Session lifecycle

Public commands:

```text
mpx session list
mpx session resume <id>
```

MPX stores bounded lifecycle and resume metadata only. It does not copy native transcripts, prompts, credentials, command output, or private paths. Session snapshot and record schemas are version 2, and current authority is written under `sessions/v2`.

## Managed inventory and liveness

Listing consumes pending lifecycle events and reconciles only MPX-managed session records. Inventory partitions are independent: an unreadable source produces a source-attributed diagnostic without hiding healthy partitions, and public diagnostics are bounded. Process liveness uses PID plus start fingerprint.

Pi and Claude preserve their real native account roots, authentication ownership, native session formats, and resume argv. MPX never switches identities or credentials based on a project, location, or provider. Reconciliation preserves monotonic record timestamps when lifecycle events and process observations overlap.

## Resume authorization

A dry run rebuilds the prospective launch from current configuration and artifacts:

```bash
mpx session resume <id> --dry-run --json
```

If current launch schema 3, selected packs/provenance, artifact schema 5, executor binding, account root, invocation, and approvals match the schema-2 snapshot, unchanged resurrection may use its bounded shortcut. Otherwise inspect and confirm the rebuilt plan digest:

```bash
mpx session resume <id> --confirm-plan <confirmationDigest>
```

Preparation rechecks native ownership, liveness/provenance, configuration, compiled artifacts, executor readiness, and authority before materialization and spawn. Stale or incompatible state fails closed and requires a fresh launch; failed planning does not rewrite records. Reload or managed session/worktree replacement refreshes Pi's accepted skill completion inventory rather than retaining stale names.

`mpx session resurrect-export` is internal and exports bounded normalized metadata and exact argv, never shell text or native session content. Execution requires one-use authority.

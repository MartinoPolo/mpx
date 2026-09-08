# Session lifecycle

Public commands:

```text
mpx session list
mpx session resume <id>
```

MPX stores bounded lifecycle metadata only for sessions it represents. It does not copy native transcripts, prompts, credentials, command output, or private paths.

## Discovery and liveness

Listing consumes pending lifecycle events, scans only exact configured runtime roots, and performs bounded reconciliation. Malformed native data becomes a diagnostic rather than deleting durable records. Process liveness uses PID plus start fingerprint; a missing process is marked inactive only after a valid platform snapshot.

Pi discovery and resume verify the configured real account root and delegate credential availability to native Pi's bounded `auth check`. Claude discovery and resume share interactive-session parsing, including current `kind` and legacy `type` metadata, while retaining native account-root behavior. Both runtimes keep their native resume argv. Reconciliation and delayed lifecycle events preserve monotonic record timestamps when scans overlap new launches.

## Resume authorization

A dry run rebuilds the prospective launch from current configuration and artifacts:

```bash
mpx session resume <id> --dry-run --json
```

If the current launch exactly matches the recorded snapshot, unchanged resurrection may use its bounded shortcut. Otherwise inspect the plan and confirm its digest:

```bash
mpx session resume <id> --confirm-plan <confirmationDigest>
```

Preparation rechecks native ownership, session activity, process provenance, configuration, artifacts, and executor authority before materialization and again before spawn. Stale confirmation fails closed. Failed planning does not rewrite session records.

`mpx session resurrect-export` is an internal route omitted from public help. It exports bounded normalized metadata and exact argv, never shell command text or native session content. Execution requires one-use authority.

Installation and lifecycle recovery use `mpx setup` and `mpx doctor`; legacy import, public reconcile, inbox, capture, handoff, and completion routes are not supported session operations.

# Session lifecycle

MPX lifecycle events remain authoritative for sessions they represent. The public CLI exposes only:

```text
mpx session list
mpx session resume <id>
```

`session list` automatically consumes pending lifecycle events and performs bounded reconciliation for each exact
configured identity/runtime root. Claude and Pi scanners never search a home directory. Scanner failures and malformed
data become bounded normalized diagnostics, so existing durable records remain available without exposing native paths,
command output, credentials, prompts, or transcripts. Reconciliation refreshes stale liveness before records are
returned.

Identity/runtime list filters also scope reconciliation before lifecycle-binding consumption, discovery, process
inspection, and registry transactions. Liveness and workflow filters apply after reconciliation; they never bypass
liveness verification. Unfiltered reconciliation intentionally covers all partitions. Eligible Pi records share one
fresh, bounded Windows CIM snapshot per reconciliation, deduplicated by PID; inspectors without batch support use
bounded parallel probes. Missing processes become inactive only after a valid snapshot, while malformed results and
reused PIDs remain unknown with their original process fingerprints preserved.

Native bindings persist only the deterministic identity/runtime/canonical-root-digest tuple. MPX has no account
enrollment registry or attestation reference. During `mpx setup`, a bounded local reset removes only the obsolete
registry and legacy native-binding records that carried the deleted reference; current bindings, session records, and
unrelated local files are preserved. Recovery is `mpx setup` followed by `mpx doctor` when needed.

Pi discovery and resume verify the exact configured real directory and invoke native Pi's bounded `auth check`; planning
fails closed before project discovery when either check fails, and execution repeats both checks immediately before
child spawn. Claude retains its native-root behavior without Pi authentication. The confirmed plan preserves the
runtime's exact native resume argv and host-versus-Docker admission policy.

Resume dry-run builds the prospective launch from current runtime artifacts, skills, and selected configuration.
`launch` describes that new launch (including the runtime artifact key, not the capability artifact key);
`previousLaunch` retains the recorded launch key and descriptor digest as provenance. The typed `approval` contains its
schema version, selected-configuration and recorded-launch SHA-256 commitments, and an `unchanged` or
`confirmation-required` resurrection classification. Native verification commits the recorded root and process
fingerprint without exposing them. The confirmation digest covers the complete prospective plan.

The typed `effectiveAuthority` view displays resolved resource selectors and access (including absent access as `none`),
inherited network policy, opaque route labels and MCP sharing, executor enforcement and verification evidence, and each
skill's resolved exposure, inclusion, invocation permissions, and evidence hashes. It projects allowlisted fields from
the descriptor and resolved manifest, not raw configuration or policy names alone. Network fields left unspecified by
the resolver are explicitly `null`, not invented defaults or claims of enforced filtering. Host authority is visibly
advisory with no isolation. Skill defaults and overrides have already been resolved; bodies, descriptions, source paths,
environment, authentication, headers, and file contents are not copied into this view. Expanding resources under the
same policy name therefore changes both the visible access and the confirmation commitment.

The proposal audit key binds current configuration, launch axes, artifacts, and the fixed verified native target. It
excludes historical launch/record audit identity and process-derived verification evidence, which would otherwise
recursively change each new descriptor. These exclusions apply only to proposal identity: final confirmation still
commits previous launch provenance, native verification, and the exact current descriptor and authority view. Replaying
a completed prospective launch under unchanged production resolution reproduces the entire launch snapshot, allowing the
unchanged shortcut without turning the audit key into execution authority.

After a release relocation or policy change, use `mpx session resume <id> --dry-run --json`, inspect the prospective
plan, then run `mpx session resume <id> --confirm-plan <confirmationDigest>`. This exact confirmation also authorizes
the plan's explicit host execution. `--approve-resurrection` alone works only when the current launch exactly reproduces
the recorded snapshot; historical evidence that cannot prove this requires explicit confirmation. Unsupported grants and
unrestricted elevation remain blocked rather than manufacturing approval proof.

Preparation independently rechecks native ownership, root, header/activity, process provenance, current configuration,
and the full rebuilt launch before materialization, and repeats verification at the child boundary. A supplied stale
confirmation is rejected even with `--dry-run`. Stale-plan diagnostics expose only allowed axis names and SHA-256
commitments, never configuration, authentication, or artifact file maps. Planning and failed verification do not rewrite
session records or archives; legitimate pending lifecycle-event consumption remains a separate operation. Prepared
execution tokens remain service-local and one-shot.

`mpx session resurrect-export` is an executable internal route omitted from public help and generated references. It
consumes pending lifecycle events and exports only bounded normalized resurrection metadata; it does not trigger broad
discovery. Resurrection execution requires explicit one-use authority.

Installation is one bare, idempotent `mpx setup` operation. Receipt-safe upgrades preserve exact ownership, failed
applies roll back automatically from durable journals and snapshots, and restart recovery remains internal. No public
uninstall, rollback, or external-integration action protocol is exposed.

Legacy import, branch, public reconcile, show, inbox, mark, capture, handoff, and completion routes are not session
operations.

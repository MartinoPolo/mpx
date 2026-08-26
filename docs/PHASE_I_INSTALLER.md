# Phase I immutable installer contracts

`@mpx/installer` exposes strict version-1 contracts for release manifests, install intent and plans, ownership receipts, verification, and machine snapshots. Unknown or missing fields, unsorted collections, unsafe relative paths, and inconsistent convergence/confirmation digests fail closed.

Release payloads are content-addressed at `${MPX_APPS}/mpx/releases/<releaseKey>`. The release key is the SHA-256 digest of the canonical, sorted list of every payload file's relative path, byte count, and SHA-256. Publication copies into a sibling staging directory, verifies the copy, then renames it. A matching release converges without writes; a collision or drift is refused. Release APIs never update an existing release.

The stable selector is `%LOCALAPPDATA%/mpx/active-release`. Receipts, journals, and snapshots are mutable installer state and belong only below `%APPDATA%` or `%LOCALAPPDATA%`. Native runtime roots, credentials, configuration, sessions, caches, project roots, work roots, and clone roots are not release payloads and are not implicitly operated on.

Immediately before scheduled plan/apply/verify use, `NodeInstalledReleaseAuthority` opens the selected runner and proves that it is a regular file below the receipt's exact release, with the receipt's path, size, and hash. Project, work, and cloned roots can be supplied as prohibited roots. The existing `ImmutableRunnerAuthority` session-capture seam remains structurally compatible.

## CLI orchestration

The public surface is `mpx install plan --intent <file>`, `apply --plan <file> --confirm-plan <digest>`, `verify [--strict]`, `rollback --transaction <id> --confirm-plan <digest>`, and `uninstall --confirm-plan <digest>`. Intent and plan files use strict version-1 parsers. Planning only builds and observes the current deterministic release; it does not publish, authenticate, or launch. Apply rebuilds and revalidates release content, operation composition, and machine observations before publication, then applies automatic operations with the scheduled operation group last. Failures restore captured state in reverse order.

Native side effects remain behind an application-injected `InstallerOperationAdapter`; this package does not implement Windows provisioning internals. `%APPDATA%`, `%LOCALAPPDATA%`, and `MPX_APPS` must be explicit absolute production roots. Verification hashes actual release files and observes actual operation targets; `--strict` additionally reports foreign entries without removing them. Uninstall refuses absent ownership and foreign or drifted owned targets. The legacy public `--component`/`--runner` reader has been removed.

A healthy strict Phase I verification supplies the release-key authority digest used to admit Phase G scheduled capture. Without an injected production adapter and durable transaction store, live install/apply remains fail-closed with `INSTALL_ADAPTER_UNAVAILABLE`.

## Simulation matrix

| Machine | Scenario | Expected result |
|---|---|---|
| clean | publish/apply twice | one immutable release; side effects converge |
| existing | unrelated native config, credentials, roots, and sessions | byte-identical and untouched |
| existing | same-name foreign or receipt-owned drift | refuse before mutation |
| either | observation changes after plan | `INSTALL_OBSERVATION_CHANGED`; no side effect |
| either | wrong confirmation digest | `INSTALL_CONFIRMATION_MISMATCH`; no side effect |
| either | injected failure before/after each operation | reverse restoration from snapshots; native state byte-identical |
| either | interrupted applying journal | recovery restores snapshots before retry |
| installed | runner link, special file, wrong path/size/hash/receipt | authority fails closed |
| installed | uninstall with foreign/drifted owned target | refuse and preserve target |

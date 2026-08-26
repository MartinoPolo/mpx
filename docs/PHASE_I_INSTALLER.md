# Phase I immutable installer contracts

`@mpx/installer` exposes strict version-1 contracts for release manifests, install intent and plans, ownership receipts, verification, and machine snapshots. Unknown or missing fields, unsorted collections, unsafe relative paths, and inconsistent convergence/confirmation digests fail closed.

Release payloads are content-addressed at `${MPX_APPS}/mpx/releases/<releaseKey>`. The release key is the SHA-256 digest of the canonical, sorted list of every payload file's relative path, byte count, and SHA-256. Publication copies into a sibling staging directory, verifies the copy, then renames it. A matching release converges without writes; a collision or drift is refused. Release APIs never update an existing release.

The stable selector is `%LOCALAPPDATA%/mpx/active-release`. Receipts, journals, and snapshots are mutable installer state and belong only below `%APPDATA%` or `%LOCALAPPDATA%`. Native runtime roots, credentials, configuration, sessions, caches, project roots, work roots, and clone roots are not release payloads and are not implicitly operated on.

Immediately before scheduled plan/apply/verify use, `NodeInstalledReleaseAuthority` opens the selected runner and proves that it is a regular file below the receipt's exact release, with the receipt's path, size, and hash. Project, work, and cloned roots can be supplied as prohibited roots. The existing `ImmutableRunnerAuthority` session-capture seam remains structurally compatible.

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

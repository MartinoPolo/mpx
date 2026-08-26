# Phase I immutable installer contracts

`@mpx/installer` exposes strict version-1 contracts for release manifests, install intent and plans, ownership receipts, verification, and machine snapshots. Unknown or missing fields, unsorted collections, unsafe relative paths, and inconsistent convergence/confirmation digests fail closed.

Release payloads are content-addressed at `${MPX_APPS}/mpx/releases/<releaseKey>`. The release key is the SHA-256 digest of the canonical, sorted list of every payload file's relative path, byte count, and SHA-256. Publication copies into a sibling staging directory, verifies the copy, then renames it. A matching release converges without writes; a collision or drift is refused. Release APIs never update an existing release.

The stable selector is `%LOCALAPPDATA%/mpx/active-release`. Receipts, journals, and snapshots are mutable installer state and belong only below `%APPDATA%` or `%LOCALAPPDATA%`. Native runtime roots, credentials, configuration, sessions, caches, project roots, work roots, and clone roots are not release payloads and are not implicitly operated on.

Immediately before scheduled plan/apply/verify use, `NodeInstalledReleaseAuthority` opens the selected runner and proves that it is a regular file below the receipt's exact release, with the receipt's path, size, and hash. Project, work, and cloned roots can be supplied as prohibited roots. The existing `ImmutableRunnerAuthority` session-capture seam remains structurally compatible.

## CLI orchestration

The public surface is `mpx install plan --intent <file>`, `apply --plan <file> --confirm-plan <digest>`, `verify [--strict]`, `rollback --transaction <id> --confirm-plan <digest>`, and `uninstall --confirm-plan <digest>`. Intent and plan files use strict version-1 parsers. Planning only builds and observes the current deterministic release; it does not publish, authenticate, or launch. Apply rebuilds and revalidates release content, operation composition, and machine observations before publication, then applies automatic operations with the scheduled operation group last. Failures restore captured state in reverse order.

Native side effects remain behind an application-injected `InstallerOperationAdapter`; this package does not implement Windows provisioning internals. `%APPDATA%`, `%LOCALAPPDATA%`, and `MPX_APPS` must be explicit absolute production roots. Verification hashes actual release files and observes actual operation targets; `--strict` additionally reports foreign entries without removing them. Uninstall refuses absent ownership and foreign or drifted owned targets. The legacy public `--component`/`--runner` reader has been removed.

A healthy strict Phase I verification supplies the release-key authority digest used to admit Phase G scheduled capture. Without an injected production adapter and durable transaction store, live install/apply remains fail-closed with `INSTALL_ADAPTER_UNAVAILABLE`.

## Confirmation and manual external integrations

External integration requests are typed, sorted references in the immutable install intent. They are **planning contracts only**: the installer never executes Git remote changes, writes Obsidian notes, imports Raycast settings, logs in to an account, or renames a hosted repository. Every plan carries an exact scope, digest, and structured manual rollback guidance.

| Integration/action | Inspection boundary | Plan and confirmation | Apply classification | Post-change verification |
|---|---|---|---|---|
| Git remotes | One explicitly requested repository under an approved `MPX_PROJECTS`, `MPX_WORK`, or `MPX_CLONED` root; argv-only `git remote -v`; exact `.git/config` bytes | Exact `git remote add`, `set-url`, or `rename` argv; one digest per repository; unrelated remotes retained | Confirmation required; manual execution | Run argv-only `git remote -v` in that same repository and compare with the reviewed proposal |
| Obsidian MPX content | Only the exact reviewed relative file list below `${MPX_OBSIDIAN_VAULT}/MPX`; no vault scan or unrelated note reads | Byte/absence snapshots for every backlink, query, CSS, write, source, and rename destination; one atomic batch digest | Confirmation required; manual execution | Re-open only reviewed paths; restore the complete snapshot set if any batch member fails |
| Raycast | A user-supplied, encrypted, strict derivative containing only IDs, categories, and reviewed commands; unknown/private/credential fields rejected | ID/category-preserving encrypted plan with manual instructions | Manual-only; automatic import is forbidden | User creates a fresh encrypted post-export derivative; compare exact IDs/categories |
| Authentication login | No credential inspection | Provider-native instructions only | Manual-only | User/provider confirms account route |
| Hosted repository rename | No automatic mutation | Exact provider review checklist | Manual-only | User verifies old/new repository routes and redirects |
| Export import | Sanitized derivative only | Exact reviewed export identity | Manual-only | Fresh post-export derivative comparison |

Paths are canonicalized beneath approved roots, and regular files/directories are required. Traversal, symlink, special-entry, duplicate/unsorted intent, unknown-field, and shell/control-character inputs fail closed. Shell command strings are never constructed. Existing or foreign files outside the exact reviewed scope are neither read nor changed.

Rollback is deliberately structured but not automatically executed for these external systems: identify the confirmation digest and scope, restore `.git/config` or every reviewed Obsidian path from byte/absence snapshots, or use Raycast's native manual restore/export workflow, then run the bounded verifier. This prevents installer ownership from being inferred over native user data.

## Immutable runtime registration

Installed registration is a strict, secret-free four-route matrix: `claude-personal`, `claude-work`, `pi-personal`, and `pi-work`. Each entry binds an absolute executable path, SHA-256, version, native-root digest (never the root), route labels, MCP-sharing policy, and a digest of the immutable synthetic projection. Duplicate identities, overlapping roots, cross-domain route labels, unknown fields, and incomplete matrices fail closed.

Claude projections must inventory convergence-owned plugin, hooks, status, settings, canonical content, agents, and licenses. Pi additionally requires its extension, profile, keybindings, themes, status, and settings. Native auth, credentials, sessions, cache, and trust are never projected. Activation remains argv-only through Claude `--plugin-dir` or Pi `--no-extensions --extension --no-skills`; native plugin/extension copies and secondary readers are forbidden.

Static MCP registrations contain only a domain-qualified label, executable path/hash/version, and bounded non-secret argv. Account roots and MCP configuration paths enter only private per-launch `launch-key.json` and `route-bindings.json` material. Synthetic account probes verify enrollment and route binding across all four identities without reading or serializing credentials. The runtime-registration release binding covers both the immutable release convergence hash and exact matrix digest.

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

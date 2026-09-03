# Phase I immutable installer contracts

`@mpx/installer` exposes strict version-1 contracts for release manifests, install intent and plans, verification, and machine snapshots. Ownership receipts use schema v2, binding every operation to a bounded durable locator and locator digest. Unknown or missing fields, unsorted collections, unsafe relative paths, and inconsistent convergence/confirmation digests fail closed.

Schema-v1 ownership receipts are accepted only by a bounded one-time migration path. `install verify` reports `INSTALL_RECEIPT_MIGRATION_REQUIRED`; a current deterministic install plan then matches every legacy operation ID and release file to current intent, verifies actual native state, derives v2 locators, and includes `ownership-receipt-v1-migration` as an exact-confirmation item. Confirmed apply atomically rewrites the receipt before normal convergence. Unknown, forged, ambiguous, foreign, or drifted v1 evidence returns `INSTALL_RECEIPT_MIGRATION_UNSAFE` with manual-recovery guidance. Normal verify, rollback, and uninstall never retain a schema-v1 reader.

Release payloads are content-addressed at `${MPX_APPS}/mpx/releases/<releaseKey>`. The release key is the SHA-256 digest of the canonical, sorted list of every payload file's relative path, byte count, and SHA-256. Publication copies into a sibling staging directory, verifies the copy, then renames it. A matching release converges without writes; a collision or drift is refused. Release APIs never update an existing release.

The stable selector is `%LOCALAPPDATA%/mpx/active-release`. Receipts, journals, and snapshots are mutable installer state and belong only below `%APPDATA%` or `%LOCALAPPDATA%`. Native runtime roots, credentials, configuration, sessions, caches, project roots, work roots, and clone roots are not release payloads and are not implicitly operated on.

## CLI orchestration

The read-only builder surfaces are `mpx install intent --request <json-or-file>` and `mpx install prepare --request <json-or-file>`. Automation may pass the strict JSON object inline; guided use may pass a path to a bounded regular JSON file. `intent` returns an `install-intent-build-result` containing the exact `InstallIntentV1` plus reviewable external plans. `prepare` builds the same result and immediately passes its intent to the existing read-only orchestrator planner. `mpx install plan --intent <file>` remains supported and accepts either a raw `InstallIntentV1` or the strict build-result envelope.

The remaining public surface is `apply --plan <file> --confirm-plan <digest>`, `verify [--strict] [--external-plan <intent-result.json>]`, `rollback --transaction <id> --confirm-plan <digest>`, and `uninstall --confirm-plan <digest>`. Request, build-result, intent, verification-result, and plan files use strict version-1 parsers. Intent building, planning, and external verification are read-only: they do not publish, authenticate, launch, apply a reviewed external plan, or change external systems. Apply rebuilds and revalidates release content, operation composition, and machine observations before publication, then applies automatic operations in deterministic plan order. Failures restore captured state in reverse order.

A healthy schema-v2 installation upgrades through the same `plan` and confirmed `apply` flow. The plan binds an `ownership-release-upgrade` confirmation reference to the exact prior receipt. Before planning and again before apply, the installer verifies the prior immutable release, durable operation locators, and every owned target. Shared targets may transition only from their exact prior-owned digest to the reviewed desired digest. Prior operation IDs cannot disappear or move, except that release-keyed runtime projection targets may move from the exact old release key to the exact new release key. Registration receipts may match only the exact prior or desired registration while planning and must match the desired registration after apply. The new receipt replaces prior ownership only after the transaction commits; failure restores prior bytes and receipt without deleting either immutable release. Concurrent foreign changes are preserved and make rollback fail closed.

`InstallIntentRequestV1` has these exact JSON fields (unknown fields fail closed):

```json
{
  "schemaVersion": 1,
  "kind": "install-intent-request",
  "userConfigPath": "C:\\Users\\me\\AppData\\Roaming\\mpx\\config.json",
  "identities": { "personal": "home", "work": "office" },
  "providers": { "personal": "github", "work": "gitlab" },
  "executables": {
    "claude": { "path": "C:\\Tools\\claude.exe", "version": "1.2.3" },
    "pi": { "path": "C:\\Tools\\pi.exe", "version": "1.2.3" }
  },
  "projections": {
    "claude": [{ "path": "content/example", "role": "plugin" }],
    "pi": [{ "path": "runtimes/example", "role": "extension" }]
  },
  "external": {
    "gitRemotes": [
      {
        "id": "repo-remotes",
        "request": {
          "repository": "C:\\_MP_projects\\repo",
          "proposals": [
            { "action": "set-url", "remote": "origin", "url": "git@github.com:owner/repo.git" }
          ]
        }
      }
    ]
  }
}
```

All collections are bounded, unique, and sorted by ID/path (nested proposals and changes use canonical JSON order). Projection entries must cover every required Claude/Pi role and each path must exactly match a file in the current release manifest. External plan records have exact fields `id`, `adapter`, `classification`, `planDigest`, `verifierRef`, and `plan`; their digest and verifier binding are revalidated before `install plan` accepts the envelope.

## Confirmation and external integrations

External integration requests are typed, sorted plan-digest and verifier references in the immutable install intent. Git remotes are the only retained installer external adapter. They are confirmation-required and never emitted as automatic operations; the installer does not execute remote changes.

A receipt reference is never evidence of success. Without exact live evidence every receipt-bound Git integration reports `verification-required`. `--external-plan` re-parses the prior build result and invokes the read-only Git verifier against its digest-bound plan. Stale bindings are refused and drift reports `unhealthy`.

| Integration | Inspection boundary                                                                                           | Plan and confirmation                                                        | Post-change verification                             |
| ----------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------- |
| Git remotes | One requested repository under an approved project root; argv-only `git remote -v`; exact `.git/config` bytes | Exact reviewed argv and repository-scoped digest; unrelated remotes retained | Run argv-only `git remote -v` in the same repository |

Optional Obsidian project registration remains a separate manual skill workflow when `MPX_OBSIDIAN_VAULT` identifies a vault the user uses. The installer does not inspect, plan, mutate, verify, or claim ownership over Obsidian or Raycast data.

Paths are canonicalized beneath approved roots, and regular files/directories are required. Traversal, symlink, special-entry, duplicate/unsorted intent, unknown-field, and shell/control-character inputs fail closed. Rollback restores the reviewed `.git/config` snapshot after ownership and scope are confirmed.

## Immutable runtime registration

Installed registration is a strict, secret-free four-route matrix: `claude-personal`, `claude-work`, `pi-personal`, and `pi-work`. Each entry binds an absolute executable path, SHA-256, version, native-root digest (never the root), route labels, MCP-sharing policy, and a digest of the immutable synthetic projection. Duplicate identities, overlapping roots, cross-domain route labels, unknown fields, and incomplete matrices fail closed.

Claude projections must inventory convergence-owned plugin, hooks, status, settings, canonical content, agents, and licenses. Pi additionally requires its extension, profile, keybindings, themes, status, and settings. Native auth, credentials, sessions, cache, and trust are never projected. Activation remains argv-only through Claude `--plugin-dir` or Pi `--no-extensions --extension --no-skills`; native plugin/extension copies and secondary readers are forbidden.

Static MCP registrations contain only a domain-qualified label, executable path/hash/version, and bounded non-secret argv. Account roots and MCP configuration paths enter only private per-launch `launch-key.json` and `route-bindings.json` material. Synthetic account probes verify enrollment and route binding across all four identities without reading or serializing credentials. The runtime-registration release binding covers both the immutable release convergence hash and exact matrix digest.

## Simulation matrix

| Machine   | Scenario                                                                             | Expected result                                                 |
| --------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| clean     | publish/apply twice                                                                  | one immutable release; side effects converge                    |
| existing  | unrelated native config, credentials, roots, sessions, and Windows Terminal profiles | byte-identical and untouched                                    |
| existing  | same-name foreign or receipt-owned drift                                             | refuse before mutation                                          |
| either    | observation changes after plan                                                       | `INSTALL_OBSERVATION_CHANGED`; no side effect                   |
| either    | wrong confirmation digest                                                            | `INSTALL_CONFIRMATION_MISMATCH`; no side effect                 |
| either    | injected failure before/after each operation                                         | reverse restoration from snapshots; native state byte-identical |
| either    | interrupted applying journal                                                         | recovery restores snapshots before retry                        |
| installed | runner link, special file, wrong path/size/hash/receipt                              | authority fails closed                                          |
| installed | uninstall with foreign/drifted owned target                                          | refuse and preserve target                                      |

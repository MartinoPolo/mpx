# Phase F1 convergence manifest

`docs/history/CONVERGENCE_MANIFEST.json` is the versioned source-of-truth inventory for Phase F1. It snapshots both maintained repositories from `${MPX_PROJECTS}` without storing absolute machine paths or file contents.

## Commands

- `pnpm convergence:generate` traverses both source roots and rewrites the committed manifest.
- `pnpm convergence:verify` traverses both roots and fails on commit, dirty state, path, state, or content drift.
- `pnpm validate:generated` validates the committed structure and rejects unclassified input, missing evidence, malformed exclusions, and active dependencies on the old roots.
- `pnpm validate:generated -- --verify-sources` additionally verifies the live source snapshot and the earlier selected-file provenance.

The generator requires `MPX_PROJECTS`; it never guesses machine roots. Hashes are SHA-256 values over current bytes (or a symlink target marker). Modified and deleted tracked files also record their `HEAD` hash. No source content is copied.

## Classification boundary

Every traversed file receives one of `canonicalized`, `Claude-specific`, `Pi-specific`, `retired`, or `excluded`. Destinations under `_convergence` or `convergence` are intended landing namespaces for subsequent semantic convergence, not claims that a copy already exists. `adaptation` states the required treatment and `evidence` binds the decision to the captured source snapshot.

Traversal prunes only explicitly named classes: Git administration, dependency stores, generated build/test/cache/worktree output, native private account/session state, and known accidental artifacts. Each pruned path remains as an entry with an explicit reason. Maintained trees such as skills, extensions, configuration, editor settings, CI, installers, docs, and root manifests are classified rather than blanket-excluded.

Private account/session files are classified by path before hashing and are never opened. The manifest contains neither credentials nor private session content.

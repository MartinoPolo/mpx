# Phase F1 convergence manifest

`docs/history/CONVERGENCE_MANIFEST.json` is the versioned Phase F1 baseline inventory. It snapshots both maintained repositories from `${MPX_PROJECTS}` without storing absolute machine paths or file contents. The baseline is captured; the semantic-convergence gate is intentionally **not yet complete**.

## Commands

- `pnpm convergence:generate` traverses both source roots and rewrites the committed baseline.
- `pnpm convergence:verify` is the migration-safe snapshot command: it traverses both roots and fails on malformed baseline data or commit, dirty-state, path, state, or content drift. It does not claim semantic completion.
- `pnpm validate:generated` is the Phase F1 completion gate. It currently fails for planned active entries and will pass only after they have completed dispositions, real destinations where required, and behavior-test or generated-artifact evidence. It also rejects active dependencies on the old roots.
- `pnpm validate:generated -- --verify-sources` additionally verifies the live source snapshot and the earlier selected-file provenance.

The generator requires `MPX_PROJECTS`; it never guesses machine roots. Hashes are SHA-256 values over current bytes (or a symlink target marker). Modified and deleted tracked files also record their `HEAD` hash. No source content is copied.

## Classification boundary

Every active traversed file has an explicit `completion` state. Baseline entries are `planned`, retain `disposition: "unclassified"`, and record a `plannedDisposition` plus `plannedDestination`; excluded roots use `completion: "excluded"`. Names under `_convergence` or `convergence` are planning namespaces only and can never satisfy the completion gate. A completed active entry must use `canonicalized`, `Claude-specific`, `Pi-specific`, `externalized`, or `retired`, must identify a real destination when its disposition requires one, and must carry behavior-test or generated-artifact evidence.

Evidence objects use their own schema version and a closed set of kinds. Every object binds to the exact source ID, path, and snapshot hash and includes a hash, reference, and verification result. A source-snapshot hash proves only baseline capture; it is not canonicalization or behavior evidence.

Traversal prunes only explicitly named classes: Git administration, dependency stores, generated build/test/cache/worktree output, native private account/session state, and known accidental artifacts. Each pruned path remains as an entry with an explicit reason. Maintained trees such as skills, extensions, configuration, editor settings, CI, installers, docs, and root manifests are classified rather than blanket-excluded.

Private account/session files are classified by path before hashing and are never opened. The manifest contains neither credentials nor private session content.

# Phase F1 convergence manifest

`docs/history/CONVERGENCE_MANIFEST.json` is the completed, versioned Phase F1 inventory of both maintained source repositories under `${MPX_PROJECTS}`. It records paths, Git state, and hashes without storing absolute machine paths or private account/session content.

## Gate result

The semantic-convergence gate is complete for the captured snapshot:

- 415 active inputs reviewed and completed
- 244 `canonicalized`
- 18 `Claude-specific`
- 53 `Pi-specific`
- 4 `externalized`
- 96 `retired`
- 9 private/generated/dependency inputs explicitly `excluded`

Every non-retired completed input names an existing destination and has source-snapshot-bound behavior-test or generated-artifact evidence whose hash is checked against the repository file. Every retirement records its reason, a null destination, and an explicit null active reader. Reviewed Phase I drift records its rationale and adaptation with a null destination so evidence does not pretend an unimplemented installer route exists. There are no provisional `_convergence`/`convergence` destinations, planned entries, or unclassified active inputs.

## Commands

- `pnpm convergence:generate` traverses both source roots, refreshes source facts, and preserves reviewed decisions for unchanged snapshots.
- `pnpm convergence:generate -- --accept-source <source:path>` accepts one changed, already-completed source entry. It refreshes only that entry's source facts and evidence snapshot bindings, preserves all reviewed decisions and completion evidence, and fails closed on source metadata or inventory-shape drift.
- `pnpm convergence:verify` traverses both roots and fails on malformed baseline data or commit, dirty-state, path, state, or content drift. Reviewed disposition metadata is deliberately not treated as source drift.
- `pnpm validate:generated` validates semantic completion, destination/evidence existence and hashes, retirement facts, legacy-name/import boundaries, canonical script syntax, and generated Pi-agent drift.
- `pnpm validate:generated -- --verify-sources` additionally verifies the live source snapshot and selected-file provenance.

The Pi-agent drift check imports its source generator directly, so `validate:generated` does not depend on a prior package build.

## Classification boundary

Accepted reviewed dispositions are `canonicalized`, `Claude-specific`, `Pi-specific`, `externalized`, and `retired`. Canonicalized content preserves intent while removing provider/runtime coupling. Runtime-specific entries identify the current adapter/projection implementation. Externalized entries point to maintained historical or operational documentation. Retired entries are repository metadata, media, deprecated code, or legacy convenience surfaces with no active MPX reader.

Evidence objects use a closed schema and bind to the exact source ID, path, and captured source hash. `source-snapshot` evidence proves capture only. Completion requires a hash-matched `behavior-test` or `generated-artifact`; validation resolves the evidence reference in this repository and verifies its bytes.

Traversal prunes only explicitly named classes: Git administration, dependency stores, generated build/test/cache/worktree output, native private account/session state, and known accidental artifacts. Private paths are classified before hashing and are never opened.

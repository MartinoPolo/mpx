# `@mpx/runtime-pi`

Phase F's deterministic Pi projection and extension adapter. The package has no dependency
on the provenance repository and does not project credentials, sessions, trust, or cache.

## CLI-facing exports

- `buildPiProjection(input): Promise<PiPublishedProjection>` / `createPiRuntimeProjection(input)` — validate neutral v4 inputs, emit policy-scoped standalone projection files, and publish them through the runtime-contract artifact store.
- `createPiRuntimeAdapter` — validate a launch binding and install `/mpx:*` commands.
- `planPiInvocation` — return a hermetic executable/arguments/environment plan; it can consume `PiPublishedProjection` directly. Launchers must pass `statusSnapshotPath` so the child-only `MPX_STATUS_SNAPSHOT_FILE` binding points at the validated read-only Phase C snapshot. The extension refreshes that file asynchronously; the projected launch snapshot is only an older-launcher compatibility fallback.
- `createPiProjection`, `piSettings`, `piKeybindings` — immutable projection data.
- `createPiFooterPortAdapter` — asynchronous validated shared status segment.
- `generatePiAgents` — deterministic canonical-agent projection/drift check.
- `guardPiCommand` — shared runtime hook classification.

## Deliberately unsupported

Pi has no equivalent projection here for session resurrection (Phase G), F2 host
replacement, installer/account symlink mutation, credential copying, or nested subagent
orchestration by default. Account profiles are native-account-root selection data only.

The published `extension.mjs` is a deterministic executable adapter for policy-scoped
commands and model search. It is not a bundled copy of the vendored subagent TypeScript;
generated Pi agents are projected, while nested orchestration remains disabled.

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

## Root-attested account gate

Pi uses explicit local enrollment: `mpx account enroll --identity NAME` first returns a
no-write plan proving only the configured root and registry state; it deliberately defers
the live-auth probe. Re-run the same command with its `--confirm-plan` digest to re-plan,
live-probe OAuth, and write only if both checks still match. Use `re-enroll` only after an intentional
configured-root change. `list`, `status --identity NAME`, and `verify --identity NAME`
return privacy-safe versioned output. Production launch and resume require the enrolled
identity/root digest and a live exact `openai-codex` OAuth-ready probe. No root path,
opaque reference, account identifier, credential, token, executable path, or probe output
is public or persisted. Because Pi exposes no supported stable account subject, this mode
cannot detect an account switch within the same root.

## Deliberately unsupported

Phase G lifecycle capture and resume are supported only through validated MPX lifecycle
and session bindings. Pi resume remains fail-closed unless root attestation and live auth
verify. The runtime does not support unbound native
session resurrection, installer/account symlink mutation, credential copying, or nested
subagent orchestration by default. Pi also has no documented native MCP client/configuration flag;
MCP-selected launches fail with structured `RUNTIME_CAPABILITY_UNSUPPORTED` before
projection, runtime preparation, or process execution. Account profiles are
native-account-root selection data only.

The published `extension.mjs` is a deterministic executable adapter for policy-scoped
commands and model search. It is not a bundled copy of the vendored subagent TypeScript;
generated Pi agents are projected, while nested orchestration remains disabled.

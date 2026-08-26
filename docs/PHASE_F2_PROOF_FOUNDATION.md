# Phase F2 proof/contracts foundation

This slice establishes proof inputs and contracts only. It performs **no live sbx, daemon, container, or authentication operation** and does not claim F2 runtime acceptance.

## Immutable inputs

- `inventory/SBX_V0_39_0.json` pins installed standalone sbx v0.39.0, its Windows binary, release/contrib review commits, and reviewed license/features/commands artifact hashes.
- The legacy Docker sandbox integration and the contrib Pi kit are explicitly rejected; neither can satisfy `SbxPinV1`.
- `inventory/PHASE_F1_RUNTIME_TOOL_INVENTORY.json` is generated from the code-owned registry in `packages/runtime-tools/src/runtime-tool-registry.ts`. Its executor-evidence binding is the SHA-256 of `packages/executors/src/index.ts`.

## Proof boundary

`@mpx/runtime-contracts` publishes strict v1 parsers and a JSON Schema bundle for `SbxPinV1`, `SbxDiagnosticsV1`, `SandboxPlanV1`, `SandboxAttestationV1`, `RemoteToolRequestV1`, `RemoteToolResultV1`, `SandboxResumeTokenV1`, and `F2ProofReportV1`.

Contracts reject unknown fields, unsupported versions, malformed hashes, oversized identifiers, absolute host roots, and fields representing account IDs, prompts, secrets, credentials, authorization, or raw tokens. Remote requests/results carry hashes rather than prompt or result bodies.

A proof report is valid only against the current runtime-tool inventory digest and executor-evidence binding. Any registry, child-operation, implementation-path, or executor evidence change regenerates a digest and invalidates prior proof.

## Generated checks

Run `node scripts/generate-runtime-tool-inventory.mjs` after intentional registry changes. `pnpm run validate:generated` checks the committed inventory for drift.

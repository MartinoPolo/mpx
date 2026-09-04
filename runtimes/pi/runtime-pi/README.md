# `@mpx/runtime-pi`

Pi launch and shared-content projection adapter. [ADR 0004](../../../docs/adr/0004-canonical-native-pi-extensions.md) makes `runtimes/pi/extensions` the Gate 4 target for canonical Pi-specific behavior used by both native host Pi and whole-agent sandbox Pi. This package will reduce to launch binding, runtime-neutral skill/agent projection, discovery registration, and path translation.

The current generated extension and host-Pi remote-tool code remain temporary migration state. They must not gain new Pi feature implementations.

## CLI-facing exports

The exports below describe the current migration implementation and will narrow as native extension ownership moves:

- `createPiRuntimeProfileV1(modelSelection, capabilityIds)` — translate config-owned model selection into launch profile data.
- `buildPiProjection(input): Promise<PiPublishedProjection>` / `createPiRuntimeProjection(input)` — validate neutral inputs and publish the current generated extension, shared skills and agents, and launch-bound data.
- `createPiRuntimeAdapter` — validate a launch binding and install `/mpx:*` commands.
- `planPiInvocation` — return the current hermetic executable/arguments/environment plan with `--no-extensions` and one explicit generated extension; it can consume `PiPublishedProjection` directly. Launchers must pass `statusSnapshotPath` so the child-only `MPX_STATUS_SNAPSHOT_FILE` binding points at the validated read-only Phase C snapshot. The extension refreshes that file asynchronously; the projected launch snapshot is only an older-launcher compatibility fallback.
- `createPiFooterPortAdapter` — asynchronous validated shared status segment.
- `guardPiCommand` — current shared runtime-hook classification.

At Gate 4, `buildPiProjection` and `planPiInvocation` stop generating or explicitly activating Pi feature code. They instead project compiler-owned shared content and launch data while the installer registers the canonical package once in Pi's discovery surface.

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

## Migration target

Gate 4 will restore normal native Pi extension discovery, trusted project extensions, and `/reload` on host routes; Gate 5 will carry the same behavior into the sandbox. The installer will register the MPX-owned canonical extension package without replacing unrelated user extensions or native launchers. The same native footer, subagents, development services, hooks, commands, editor components, and widgets will run in both environments.

Whole-agent sandbox Pi may access only its selected identity's account and service state. That state remains absent from releases, logs, and public descriptors; the opposite identity, original checkout, unrelated host paths, and host Docker socket remain unavailable. The original checkout changes only through explicit apply-back from a host-owned private clone.

The currently published `extension.mjs` is a deterministic executable adapter for policy-scoped commands and model search, not a bundled copy of the vendored subagent TypeScript. The shared content compiler emits final Pi agent bytes; this adapter copies those bytes unchanged while retaining the vendored subagent implementation and runtime assets. This generated extension, duplicate runtime bundles, and host remote-tool replacement are transitional and scheduled for removal after canonical host and sandbox parity. See [the migration plan](../../../docs/PI_EXTENSION_MIGRATION.md).

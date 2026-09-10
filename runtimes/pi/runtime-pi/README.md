# `@mpx/runtime-pi`

Thin Pi launch adapter. Canonical Pi behavior lives in [`runtimes/pi/extensions`](../extensions) and is activated once
through Pi's native package discovery.

This package validates and publishes runtime-neutral compiler output (skills and agents), launch context, and the
selected runtime profile. `planPiInvocation` keeps native extension and context-file discovery enabled, disables ambient
skill discovery with `--no-skills`, passes each managed skill directory explicitly, and binds the compiled agents overlay
through `MPX_COMPILED_AGENTS_DIR`. Account and project instructions are loaded by Pi itself; MPX neither copies them into
the projection nor appends a duplicate managed prompt.

The invocation preserves the selected `PI_CODING_AGENT_DIR`, provider/model profile, native session resume target, and
launch trust boundaries. It does not inject the retired bridge or status-file environment. Native project trust and
extension discovery remain Pi-owned under the approved ADR. Compiler-owned agents remain the lowest-precedence base
overlay; precedence among static native extension agent sources is owned by the canonical extension package and is not
changed here.

Generated Pi extension, footer, status, development-service, subagent, configuration, keybinding, and theme
implementations are intentionally absent. Runtime-specific behavior must be implemented only in the canonical native
extension package.

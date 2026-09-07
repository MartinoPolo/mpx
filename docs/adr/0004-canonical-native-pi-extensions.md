# ADR 0004: Canonical native Pi extensions

- Status: Accepted

## Decision

Pi-specific behavior is canonical checked-in source under `runtimes/pi/extensions`. Native Pi loads that package once through normal package discovery. MPX does not generate alternative footer, tool, hook, command, editor, widget, lifecycle, configuration, keybinding, or theme implementations.

Generation is limited to runtime-neutral shared content and launch-bound data. The content compiler owns final skill and agent bytes; build output may package canonical extension source but is never a second implementation.

The Pi runtime adapter remains thin: it selects the native account root, publishes compiled shared content, supplies validated launch context, and binds manifest integrity. Canonical skills use `/mpx:<name>`; native project skills retain `/skill:<name>`.

## Consequences

- Native extension discovery and `/reload` remain available without duplicate activation.
- Former external repositories are migration provenance only, not runtime or test authorities.
- Enabled extensions execute with the selected native identity's authority.
- Windows host execution is the accepted path and is not isolation.
- Whole-agent sandbox execution remains unavailable. Docker launch fails closed without host fallback, broad home access, opposite-identity access, original-checkout mounts, or Docker-socket access.

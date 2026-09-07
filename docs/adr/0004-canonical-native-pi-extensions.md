# ADR 0004: Canonical native Pi extensions

- Status: Accepted

## Context

MPX currently generates a launch-specific Pi extension and suppresses Pi's normal extension discovery. That forced
Pi-specific features from the former `mpx-pi` repository—including the footer, subagents, development services, guards,
commands, and UI—to be reimplemented behind MPX runtime envelopes and generated adapters.

The generated copies are harder to maintain, provide less behavior than the proven native extensions, and make host and
sandbox Pi diverge. Whole-agent sandboxing already provides the useful isolation boundary around the host, original
checkout, and opposite identity.

## Decision

Gate 4 will move all canonical Pi-specific implementation source into the MPX monorepo under `runtimes/pi/extensions`.
The former `mpx-pi` repository is a migration source only and is deprecated after its retained behavior and tests move.

Native host Pi and whole-agent sandbox Pi will load that same checked-in extension package exactly once through Pi's
normal extension APIs and discovery behavior. MPX will not generate alternative implementations of the footer, tools,
hooks, commands, editor components, widgets, or extension lifecycle.

Generation is reserved for runtime-neutral content shared across harnesses, including skills and agents, plus
launch-bound data such as resolved manifests and runtime context. Build output may package or compile canonical source,
but generated output is never the implementation source.

The selected identity's extensions may use that identity's credentials, Git routes, provider APIs, local services, and
the selected open network policy inside the sandbox. The sandbox boundary protects the opposite identity, original
checkout, unrelated host paths and processes, and the host Docker socket. Failure never falls back silently to host
execution.

The target runtime adapter remains thin. It registers the canonical package in the selected discovery surface, supplies
validated launch data, projects shared skills and agents, and translates host/sandbox paths. Host GUI actions and
published development ports cross only a narrow launch-bound bridge.

## Consequences

- Remove `--no-extensions` and retire the explicit generated `--extension` entry after the canonical package is
  registered for discovery, preventing duplicate activation.
- Migrate retained Pi-specific source from `mpx-pi` without creating a second port in `runtime-pi`.
- Remove generated or vendored duplicate footer, subagent, development-service, guard, and UI implementations after
  parity is proven.
- Permit normal `/reload` and user-enabled global or trusted project extensions.
- Treat enabled extensions as trusted code with the selected identity's authority; open egress can disclose anything
  readable by that identity.
- Stage cross-platform paths and dependencies for Linux without changing extension behavior.
- Keep the original checkout outside the sandbox and apply changes back explicitly from a host-owned private clone.

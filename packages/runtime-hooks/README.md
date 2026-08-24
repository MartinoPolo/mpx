# `@mpx/runtime-hooks`

Portable, runtime-neutral policy functions shared by MPX runtime adapters. The package
classifies and plans; it does not parse runtime events, write stdin/stdout, invoke a
shell, call provider CLIs, or persist runtime state.

## Provenance

The behavior was ported from the maintained MP hook sources at the Phase F migration
baseline. Compact reinjection also used two non-Git local source files. Their SHA-256
hashes record the exact reviewed baseline without creating a runtime dependency:

| Logical source | SHA-256 |
| --- | --- |
| `codex/hooks/compact-context.js` | `7c66b56f1936691b8fb8b2d4fe8267e411a8b818ee5feddf0855a17e9529e85d` |
| `codex/hooks/shared.js` | `b0b3bf430c43062b228b210c72b522a44da44b05eafbf7609f813d990273ebe6` |

No source content, machine credentials, sessions, or state is bundled.

## Boundary decisions

- Command execution and executable discovery belong to adapters. Format/lint output is
  an executable plus argv, never shell text.
- Pull-request context comes from explicit provider-neutral MPX assumptions. Provider
  CLI lookup and provider-specific URL extraction are deferred to adapters.
- Dangerous-command and staged-secret size failures are fail-closed. Missing fallow,
  audit runtime errors, and compact instruction read failures remain visible fail-open
  outcomes, matching the maintained safety boundary.
- Runtime-specific event names, exit codes, payload envelopes, notifications, automatic
  draft-PR creation, and other Phase G behavior are intentionally excluded.

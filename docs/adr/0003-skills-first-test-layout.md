# ADR 0003: Skills-first architecture and test layout

- Status: Accepted

`content/skills` owns canonical workflow payloads. `packages/skills` owns catalog, manifest, artifact, and projection contracts. Runtime adapters consume verified compiler output, and the CLI composes public application operations.

Package unit tests live in `<workspace>/test/unit`; package fixtures live in `<workspace>/test/fixtures`. Root `tests/contract`, `tests/integration`, and `tests/e2e` cover cross-boundary behavior. Payload-local tests remain with a skill only when they ship with or validate that payload.

Cross-workspace behavior uses public package APIs. Production builds exclude tests. Verification and loading fail closed instead of using legacy fallbacks. Pi-specific source follows [ADR 0004](0004-canonical-native-pi-extensions.md).

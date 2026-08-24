# TDD execution record

## RED

`pnpm --dir packages/runtime-hooks test` failed on 2026-03-19 because
`src/index.js` did not exist. After the first minimal implementation, the pipeline
warning test remained red (36 passed, 1 failed), exposing that pipeline commands were
still treated as standalone tool usage.

## GREEN / REFACTOR

The runtime-neutral policies were implemented in `src/index.ts`. Pipeline detection was
clarified and the dispatch representation was kept as executable/argv structures.
Package tests and type checking are the verification evidence reported by the executor.

## F-03 standalone dangerous-command policy

**RED:** the standalone-policy parity test failed because
`dangerousCommandPolicyModuleSource` was not exported.

**GREEN / REFACTOR:** dangerous-command rules and data were moved into one classifier
factory. Both the package classifier and dependency-free ESM source are constructed from
that factory, eliminating a second regex table. The generated module is dynamically
imported in the test and checked for exact structured-result parity.

## Final wrapper and dynamic-delete bypasses

**RED:** malicious corpus cases failed for dynamic `rm` flags and targets, nested shell,
CMD, PowerShell, `env`, `command`, and `eval` payloads, malformed/opaque wrappers, and the
wrapper nesting bound. Inert wrapper-like arguments also exposed a broad Windows regex
false positive.

**GREEN / REFACTOR:** the shared classifier factory now performs bounded quote-aware
wrapper recursion, fails closed when delete safety or payload visibility is unresolved,
and applies recursive-delete rules only to executable positions. The same generated ESM
classifier is exercised against the complete corpus for exact structured-result parity.

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

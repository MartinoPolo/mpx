# TDD RED record

- Adapter/projection/invocation/generator/footer tests were authored before `src/index.ts`.
- `pnpm --filter @mpx/runtime-pi test` failed because the adapter module did not exist (the first run also exposed and corrected package placement/tsconfig harness issues).
- No production implementation was present when the behavioral tests were authored.
- `production-projection.test.ts` was added before the production builder; its RED run failed with `buildPiProjection is not a function`.
- Complete vendor provenance was specified next; its RED run failed because the immutable file map lacked `vendor/subagents/LICENSE`.

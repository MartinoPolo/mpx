# Shared content transfer evidence

## Provenance and scope

- Newest intent: dirty `C:/_MP_projects/mpx/content` at base commit
  `b8e323e02c734bff852766cebf2dbc897fc45c49`, including the complete semantic agent map in
  `content/agents/metadata.json`.
- Read-only behavior comparisons:
  - `C:/_MP_projects/mpx-claude-code` at `ab77de05843c4fde97e8483e7712c327f4cdf59f`;
  - `C:/_MP_projects/mpx-pi` at `8464b23f0aef5bc235699920125e04fb94b84530`.
- Destination base: `C:/_MP_projects/mpx2` at
  `ac038dd030a3ed89dab50eb34422b2e866ad6b23`.
- `migration/transfer-shared.mjs` requires absolute `MPX_PROJECTS`, refuses every existing
  destination, copies first, applies reviewed exact-source transformations, and checks every copied
  rule byte-for-byte against the dirty source.
- Transfer result: 58 files, comprising 12 missing specialists, 16 rules, 19 shared instructions, 5
  provider guides, 2 runtime instructions, 2 executor helpers, 1 global instruction, and 1 output
  style. Dirty `MPX_CLI_BASIC.md` and `MPX_CLI_REFERENCE.md` were intentionally not exposed: both
  document the retired workspace service and port-management surface and no retained content links
  to them.
- Existing `content/instructions/shared/COMPACT.md`,
  `content/instructions/shared/REVIEWER_PROTOCOL.md`, and the existing 9 canonical agents were not
  written; `git diff` for those paths is empty.

## Source-byte comparison

The following 29 transferred files remain byte-for-byte equal to the dirty source: all 16 files
under `content/rules/**`, plus:

- `BOARD_CONVENTION.md`, `CONTENT_PATHS.md`, `DESIGN_PIPELINE.md`, `EXPLORATION.md`,
  `REPAIR_ORCHESTRATION.md`, `REPORTING_LINKS.md`, and `WRITING_FOR_AGENTS.md`;
- `deep-modules.md`, `interface-design.md`, `EXECUTOR_TESTS.md`, and `EXECUTOR_MOCKING.md` (the last
  two copied from dirty `content/skills/execute/tests.md` and `mocking.md`);
- `providers/GERRIT.md`;
- `output-styles/mpx-terse.md`.

Every specialist differs in canonical frontmatter only or in the targeted native-first adaptations
below. No workflow body was summarized or replaced wholesale.

## Exact semantic adaptations from dirty source

1. **Canonical projection metadata**
   - Removed `mpx-` only from each new canonical filename/frontmatter name; generated names remain
     `mpx-*`.
   - Added only compiler-declared `metadata.mpx` fields: schema version, semantic model class,
     thinking level, and capabilities, copied exactly from dirty `content/agents/metadata.json`.
     Legacy `nesting` and `outputSchema` bookkeeping was not copied because the MPX2 compiler does
     not declare those canonical fields; equivalent output contracts remain in the agent bodies.
   - Replaced old `/mpx:<name>` authoring syntax with `{{MPX_SKILL_COMMAND}}<name>` and declared
     projected agent syntax with `{{MPX_AGENT_PREFIX}}<role>`.

2. **Stable content dependencies**
   - Every specialist dependency now resolves from absolute `MPX_ACTIVE_CONTENT_ROOT` at
     `dist/{{MPX_HARNESS}}/instructions/shared/...` and has a compiler-resolved Markdown link via
     `{{MPX_SHARED_INSTRUCTIONS}}`.
   - TDD's formerly skill-private `tests.md` and `mocking.md` dependencies were copied into shared
     canonical helpers. Chrome testing links to shared Playwright guidance. No new specialist uses
     `skills/shared`, `~/.agents`, a source checkout, or a guessed fallback root.

3. **Native-first ownership**
   - Pi instructions now require the user-created checkout selected in Orca; agents do not create,
     enter, or remove worktrees.
   - Global and browser guidance uses a parent-provided manually started project-server URL. It does
     not use MPX services or port state, and browser agents do not start/restart/stop servers.
     Repository-native E2E commands may retain their project-owned server lifecycle.
   - Browser auth retains project-local test-login discovery and parent-provided test context;
     this is distinct from provider credential routing. Parent review restored the original
     Authenticate section and Playwright test-auth guidance after catching an over-broad draft reduction.
   - Context7, Chrome, and Sentry use MCP tools already loaded by native account settings. Legacy
     gateway, adapter identity, and credential-routing language was removed.
   - The old configured Issue extraction command and `MPX-Session` commit trailer were removed;
     branch/commit evidence and native transcript behavior remain.

4. **Provider boundary**
   - Repository providers are independently `github`, `gitlab`, or `gerrit`.
   - Issue providers are independently `github` or `kanbanflow`.
   - GitLab Issue commands were removed from its repository guide and issue specialists.
   - `LOCAL.md` is an explicit unsupported/manual-handoff contract. It forbids GitHub substitution
     and legacy local-store/application imports.
   - Native Git/SSH/provider authentication remains owned by installed tools. Existing
     `GH_CONFIG_DIR`/`GLAB_CONFIG_DIR` values are preserved rather than generated or routed.

5. **Preserved workflow semantics**
   - Check correlation, browser evidence, identity-bound CI diagnosis, Context7 version checks,
     bounded execution, commit/push result handling, Issue analysis/finding, PR conflict detection,
     red-green-refactor, UI variant contracts, and idempotent unresolved-Issue routing remain.
   - Original rule guidance and terse output-style bytes remain intact. The installer exposes
     Claude rules/output-style as owned links; Pi's authored append instructions explicitly direct
     reading applicable projected rules without introducing a rule engine.
   - No shared instruction imposes `pnpm run typecheck`; executors run only parent-supplied or
     repository-native checks.

## Verification

- `node --check migration/transfer-shared.mjs`: passed.
- `pnpm exec tsx --test test/shared-content.test.ts`: 5 passed, 0 failed.
- `pnpm run typecheck`: currently blocked by 4 errors in concurrently added, unowned
  `test/resume-launch.test.ts` (three `JSON.stringify` callback type errors and one missing
  `sessionId` property). The content test itself transpiles and passes. This command was run only as
  this repository's own gate, not imposed as a global content mandate.
- `projectContent(root)`: succeeded with 148 deterministic projections and resolved local Markdown
  closure.
- `checkOutput(root)`: reports 114 generated-path drifts because this transfer intentionally does
  not own or build `dist`. The first drifts are the new generated specialist paths. Parent-owned
  build/integration remains required before the existing committed-output test can pass.

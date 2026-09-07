# Simplify canonical skill topology and generated content storage

## Purpose

Make two small architectural corrections without adding another subsystem:

1. Make shared skill references resolve through the same directory structure in canonical source and compiled projections.
2. Publish generated launch content under MPX's existing machine-local state root instead of roaming AppData.

Prefer moving, deleting, and reusing existing behavior over introducing abstractions or compatibility layers.

## Starting-state requirement

This plan was prepared against the current working tree at `C:/_MP_projects/mpx`, which contains substantial intentional edits and deletions beyond committed `HEAD`. Before executing this plan in a clean session, ensure those intended changes and this handoff are present in the clean base. Do not reset to the older `HEAD` and assume it represents the state reviewed here.

At session start:

```bash
git rev-parse --show-toplevel
git status --short --branch
```

The expected repository root is `$MPX_PROJECTS/mpx`. If the session starts in a deleted or empty former worktree, do not run repository-relative Git commands there and do not recreate it. Start or rebind the session at `$MPX_PROJECTS/mpx`, then repeat the checks. The previous worktree-hub attempt failed because it tried to discover Git metadata from the already-removed working directory before honoring the requested absolute destination.

## Scope

### Included

- Move canonical shared content from `content/instructions/shared` to `content/skills/shared`.
- Reserve `shared` as a support directory rather than a skill identity.
- Update direct path consumers, source-relative links, tests, generated references, and current documentation.
- Change new launch and resume projections from `%APPDATA%/mpx/runtime-artifacts` to `%LOCALAPPDATA%/mpx/content`.
- Delete test-only source-path redirects made unnecessary by the unified topology.

### Excluded

- No new `mpx` commands.
- No new path service, content index, binding registry, lease system, migration framework, or cleanup subsystem.
- Do not move `%APPDATA%/mpx/config.json`.
- Do not move `%MPX_APPS%/mpx`, `MPX_AI_GENERATED`, or native Claude/Pi roots.
- Do not copy or migrate old runtime artifacts. Sessions persist artifact keys rather than artifact directories, and resume republishes into the supplied artifact root.
- Do not add runtime fallback reads from the old artifact directory.
- Do not address historical release retention in this change.
- Do not revive deleted migration documents or unrelated legacy code.

## Target layout

Canonical source:

```text
content/
├── skills/
│   ├── shared/                 reserved support directory; never a skill
│   │   ├── AUTHORING.md
│   │   ├── PROVIDER_ROUTING.md
│   │   ├── providers/
│   │   └── ...
│   ├── commit/SKILL.md
│   ├── issue-create/SKILL.md
│   └── ...
├── agents/
├── instructions/
├── output-styles/
└── runtime-profiles.json
```

Compiled output remains:

```text
<projection>/
├── skills/
│   ├── shared/
│   ├── commit/SKILL.md
│   └── ...
├── agents/
└── active-content.json
```

Generated launch content:

```text
%LOCALAPPDATA%/mpx/content/<artifact-key>/
```

Configuration remains:

```text
%APPDATA%/mpx/config.json
```

## Implementation

### 1. Move the shared source tree

Move the complete tree, preserving history:

```text
content/instructions/shared/
→ content/skills/shared/
```

Do not leave a duplicate, symlink, redirect, or compatibility reader at the old path.

Before finishing, verify that every moved file referenced by canonical content exists. Fix a real dangling reference by restoring or retargeting its intended document; never exempt it from closure validation.

### 2. Reserve `content/skills/shared`

Update `inventoryCanonical()` in `packages/skills/src/inventory.ts`:

- Skip only the exact immediate directory named `shared` before looking for `SKILL.md`.
- Do not change inventory to ignore arbitrary directories without `SKILL.md`; those must remain errors.
- Reject `shared` as a canonical skill identity.
- Add a focused test proving `shared` is excluded while another malformed child directory still fails inventory.

Do not change canonical provenance for real skills: it remains `content/skills/<identity>/SKILL.md`.

### 3. Point existing consumers at the moved directory

Replace canonical source references to `content/instructions/shared` with `content/skills/shared` in the active consumers, including:

- `packages/application/src/node/launch-execution-runtime.ts`
- `scripts/generate-cli-docs.mjs`
- `scripts/validate-generated.mjs`
- `apps/cli/test/unit/command-help.test.ts`
- `apps/cli/test/unit/launch-execution.test.ts`
- `packages/content-compiler/test/unit/compiler.test.ts`
- `runtimes/pi/runtime-pi/test/fixtures/fixture.ts`
- `tests/integration/scripts/validate-generated.test.mjs`

Keep compiler output at `skills/shared/**`; it is already correct. A broad compiler or runtime-adapter redesign is unnecessary.

If practical, rename the compiler input field `sharedInstructionRoot` to `sharedContentRoot`. Do it only as one mechanical rename across callers and tests; do not wrap it in a new API.

### 4. Make links valid in source and projection

Use these direct relative paths:

| Containing file                         | Shared path                                            |
| --------------------------------------- | ------------------------------------------------------ |
| `content/skills/<skill>/SKILL.md`       | `../shared/<file>`                                     |
| nested file below a skill               | enough `../` segments to reach `content/skills/shared` |
| `content/agents/<agent>.md`             | `../skills/shared/<file>`                              |
| `content/instructions/global/AGENTS.md` | `../../skills/shared/<file>`                           |

Most skill links already use the desired `../shared` form and should remain unchanged.

Update `content/instructions/global/AGENTS.md`, whose current `../shared` links would otherwise point to the removed directory.

Remove the `projectedReference()` special case in `packages/skills/test/unit/batch-c3-content.test.ts` that redirects `shared/...` into `content/instructions`. Source closure must now use ordinary filesystem-relative resolution.

Update `validateSharedInstructionLinks()` and its diagnostics/tests for the new root. Keep its scope narrow; do not create a second general Markdown parser if the compiler's existing closure validation can be reused cleanly.

### 5. Move only generated launch content to LocalAppData

Change the two production root compositions:

1. `packages/application/src/node/launch-production.ts`
2. `apps/cli/src/main.ts`, inside `productionSessionResumeLaunch()`

Replace:

```ts
path.join(appData, 'mpx', 'runtime-artifacts');
```

with:

```ts
path.join(localAppData, 'mpx', 'content');
```

Requirements:

- Launch and resume require absolute `LOCALAPPDATA` for both `stateRoot` and `artifactsRoot`.
- Do not require `APPDATA` merely to publish or resume generated content.
- Keep `APPDATA` requirements where user configuration is actually read.
- Correct misleading error codes/messages that claim `APPDATA` is needed for projection publication.
- Do not alter `publishRuntimeArtifact()`: it already stages atomically, handles concurrent identical publication, rejects conflicting bytes, and removes its own failed staging directory.
- Do not modify session schemas. They store artifact/manifest keys, not artifact-directory paths.
- Do not migrate `%APPDATA%/mpx/runtime-artifacts`. New launch and resume operations deterministically republish into the new root. Leave old files untouched so already-running old processes remain safe.

Update focused launch and resume tests to assert the new root. Keep synthetic internal fixture names such as `C:/state/runtime-artifacts` when they are not claims about production placement.

### 6. Delete stale topology accommodations and update current docs

Delete only code or assertions made obsolete by this change:

- source-to-projection shared-path redirects;
- old-root constants and diagnostics;
- assertions requiring `APPDATA` solely for generated projection publication;
- documentation references to `content/instructions/shared` or `%APPDATA%/mpx/runtime-artifacts`.

Update current documents that still describe the old source path, especially:

- `README.md`
- `docs/CONTENT_COMPILER_ARCHITECTURE.md`
- `docs/PROVIDERS.md`
- the moved `content/skills/shared/AUTHORING.md`

Do not recreate currently deleted migration/history documents merely to update them.

Regenerate existing tracked generated files through the repository's current scripts, including CLI references and `bin/mpx.mjs`. Do not edit generated bundles manually.

## Tests

Run the narrow checks first:

1. Canonical skill inventory tests.
2. Canonical support/link-closure tests.
3. Content compiler tests, including the real canonical corpus.
4. Pi and Claude projection tests affected by the moved shared root.
5. Launch-production and resume composition tests for `%LOCALAPPDATA%/mpx/content`.
6. Generated-content validation.

Required behaviors:

- `shared` is absent from the skill catalog.
- Another child directory without a valid `SKILL.md` still fails inventory.
- All canonical source links resolve directly without path rewriting.
- Both runtime projections contain `skills/shared/**` and pass final closure validation.
- New launch and resume artifacts publish under `%LOCALAPPDATA%/mpx/content`.
- Production launch/resume no longer compose `%APPDATA%/mpx/runtime-artifacts`.
- `%APPDATA%/mpx/config.json` remains unchanged.
- Existing atomic publication and concurrent-reuse tests continue passing.

Then run the repository's current full gate from the clean implementation tree:

```bash
pnpm test
pnpm run typecheck
pnpm run format:check
pnpm run lint
pnpm run validate:structure
pnpm run validate:generated
git diff --check
```

Do not fix unrelated failures. Record them separately with evidence.

## Completion criteria

The work is complete when:

1. `content/skills/shared` is the sole canonical shared-content directory.
2. `content/instructions/shared` no longer exists.
3. `shared` cannot be inventoried or invoked as a skill.
4. Relative shared links resolve directly in both canonical source and compiled output.
5. No test-only shared-path redirect remains.
6. New launch and resume projections use `%LOCALAPPDATA%/mpx/content`.
7. Normal production code does not compose `%APPDATA%/mpx/runtime-artifacts`.
8. Configuration remains at `%APPDATA%/mpx/config.json`.
9. Compiler and runtime publication integrity behavior is unchanged.
10. No CLI command, migration subsystem, cleanup subsystem, or permanent legacy reader was added.
11. Relevant focused tests and the repository's current validation gate pass.

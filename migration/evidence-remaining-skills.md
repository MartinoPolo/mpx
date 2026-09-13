# Remaining-skills bounded transfer evidence

## Runtime

- `PI_MODEL=gpt-5.6-sol`
- `PI_PROVIDER=openai-codex`
- `PI_REASONING_LEVEL=high`

## Scope and provenance

The bounded transfer owns exactly these 25 dirty canonical skill directories from
`../mpx/content/skills`: `agent-create`, `architecture-review`, `board-setup`, `clean-pc`,
`code-clean`, `components-audit`, `consolidate-context`, `fallow-fix`, `hitl`,
`init-github-repo`, `notebooklm`, `playwright-test`, `podcast`, `project-register`,
`raycast-config`, `script-discovery`, `setup-react-native`, `setup-sveltekit`, `skill-audit`,
`skill-create`, `suppression-audit`, `symlink`, `tutorial-create`, `video-to-image`, and
`vocabulary`.

`migration/transfer-remaining-skills.mjs` copied all 74 source files before adapting them. Its
post-copy accounting found 25 `SKILL.md` files, 44 byte-identical support files, and five declared
support adaptations. The test stores dirty-source SHA-256 values for all 44 unchanged support files,
so source-byte evidence does not require a neighboring checkout at test time.

Pack and exposure metadata comes from each dirty source `SKILL.md`, not a reconstructed inventory:

- development/name-only: architecture-review, code-clean, components-audit, consolidate-context,
  fallow-fix, init-github-repo, notebooklm, script-discovery, skill-audit, skill-create,
  suppression-audit, symlink, vocabulary;
- development/explicit-only: agent-create, board-setup, hitl, playwright-test,
  setup-react-native, setup-sveltekit;
- personal/explicit-only: clean-pc, podcast, project-register, raycast-config, tutorial-create,
  video-to-image.

No skill was retired or dropped. The one historical basename exception is mapped explicitly below.

## Historical counterpart: `init-repo` → `init-github-repo`

The unmatched original
`../mpx-claude-code/plugins/gh/skills/mp-init-repo/SKILL.md` (`name: init-repo`, version 0.6) is the
historical counterpart of dirty canonical `content/skills/init-github-repo/SKILL.md` (`name:
init-github-repo`, version 0.7). The canonical rename makes the GitHub-only provider choice explicit;
it is lineage continuity, not a retired workflow or a second skill. Pack/exposure still follows the
dirty source (`development`, `name-only`) rather than copying the original Claude-only
`disable-model-invocation: true` field.

Mechanism comparison confirmed that the native-first port preserves and strengthens the useful
original behavior:

- abort without mutating when already inside a Git repository;
- run the deterministic bundled initializer and bundled gitignore template;
- create or preserve `.gitignore`, `.gitattributes`, `.editorconfig`, `AGENTS.md`, and `CLAUDE.md`;
- create canonical `.mpx/CONTEXT.md` and `.mpx/DECISIONS.md` in a separate documentation commit,
  preserving substantive existing content and keeping `.mpx/` versioned;
- ask for private/public visibility, publish through native `gh`, create `main` and `dev`, make
  `dev` default, and bind all hosted operations to one confirmed `OWNER/REPO` target;
- attempt protection for both branches, degrade visibly on a genuine HTTP 403 without falsely
  claiming protection, and retain the placeholder-check warning;
- report local files, actual commits, remote URL/visibility, branches, protection, failures, and
  remaining work.

The version 0.7 dirty source additionally verifies native GitHub authentication/host, checks seed
files for private data and unsafe links, inspects staged diffs, reconciles uncertain create results,
and reads back hosted state. The old automatic invocation from project-register is intentionally
superseded by the newer project-register contract: registration preserves existing repositories and
never initializes or publishes one. `init-github-repo` remains independently invokable and fully
retained.

## Declared adaptations

- Removed source-only `metadata.mpx.contentVersion` and skill capability fields that the settled
  compiler contract rejects. Preserved source pack and exposure values and mapped only obsolete
  exposure spellings where encountered.
- Replaced shared-source relative paths with `{{MPX_SHARED_INSTRUCTIONS}}`, old `/mpx:` commands
  with `{{MPX_SKILL_COMMAND}}`, and the project-register sibling link with
  `../{{MPX_SKILL_PREFIX}}raycast-config/SKILL.md`. Canonical prefix expansion is empty; Pi and
  Claude projections resolve the sibling as `mp-raycast-config`.
- Replaced launch identity, old provider, manifest, account-routing, and local-Issue assumptions
  with native authentication and independent repository (`github|gitlab|gerrit`) and Issue
  (`github|kanbanflow`) selection.
- Preserved approved Playwright project test-login discovery from `.local/` and `.env.local`, while
  removing MPX development-server ownership. Stale-server evidence now blocks the affected surfaces
  and hands server correction to Orca/the project terminal.
- Reworked project-register to validate or create user-confirmed `mpxconfig.json` metadata using
  `projectId`, independent repository/Issue provider objects, optional package-manager metadata,
  and pack selection. It preserves malformed/user-owned files rather than replacing them, preserves
  explicit `packs: []`, omits credentials/session/port/Orca state, and emits an Orca field-value
  handoff snippet instead of writing workspace or port services.
- Fallow uses only opted-in project-owned scripts/local dependencies. Components Audit uses only
  applicable repository-documented validation and imposes no global typecheck command.
- PowerShell workflows run from public Git Bash and do not rely on an unguarded harness-specific
  PowerShell tool. Machine-root reads name only the roots each workflow needs.
- The tutorial compiler's 18 internal uppercase template tokens were changed consistently in
  `TEMPLATE.html` and `scripts/compile.js` to lowercase `tutorial_*` tokens. This preserves template
  behavior while preventing the MPX compiler from treating those application tokens as undeclared
  MPX placeholders.
- The five adapted support files are `clean-pc/WINDOWS.md`,
  `podcast/reference/NOTEBOOKLM_FLOW.md`, `setup-react-native/PLATFORM_REFERENCE.md`,
  `tutorial-create/TEMPLATE.html`, and `tutorial-create/scripts/compile.js`. All other support files
  retain dirty-source bytes.

## Dependency closure

All referenced scripts, templates, references, images/tests, and nested tutorial package metadata
are present under the consuming skill in MPX2. Bundled JavaScript imports Node built-ins and
same-skill files; the tutorial compiler additionally imports YAML and Shiki, now declared in MPX2.
Syntax checks pass and script-discovery's bundled detector executes `--help` without a neighboring
repository. The final integration fixture also executes the projected tutorial compiler with real
Shiki; see [evidence-final-integration.md](evidence-final-integration.md).

NotebookLM, Gemini TTS, ffmpeg, Playwright, Raycast, PowerShell, and framework template CLIs remain
explicit workflow prerequisites rather than silently vendored tools. The NotebookLM skill no longer
runs an upstream skill installer into another global root; it reports and installs only its external
Python prerequisite when needed. No installed-only dependency was silently treated as available.

## Focused verification

- `node migration/transfer-remaining-skills.mjs` from a clean destination: 25 skills, 74 files, 44
  unchanged support files.
- `pnpm exec tsx -e "...projectContent(process.cwd())..."`: 386 projections; local Markdown
  closure and placeholders validated.
- `pnpm exec tsx --test test/remaining-skills.test.ts`: verifies bounded membership, source metadata,
  retained body contracts, all support files, source hashes, pack exposure, Pi/Claude commands,
  sibling `mp-` links, native-first exclusions, approved test-login behavior, project-register/Orca
  behavior, adapted support, JavaScript syntax, and an executable bundled detector.

Generated `dist` is intentionally not edited by this bounded batch.

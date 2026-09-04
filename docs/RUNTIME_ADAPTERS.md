# Runtime adapters

MPX resolves canonical content once into a runtime-neutral v4 manifest. The manifest records every canonical identity's inclusion decision, exposure, permissions, source hash, and metadata hash without embedding bodies, private roots, or runtime syntax. The logical skill artifact is distinct from each launch-bound reference to a full published runtime projection. Claude and Pi projections reference the same manifest key and have distinct artifact/file-map hashes.

Runtime adapters consume verified runtime-neutral plans and a verified compiled content tree. They own only runtime assets, projection assembly, and invocation wiring; canonical skill and agent parsing/rendering, policy, provider logic, model-selection defaults, and application orchestration remain in their owning workspace packages.

`content/runtime-profiles.json` is the tracked source for agent models, aliases, capability/tool mappings, frontmatter fields, separators, and nesting requirements. `@mpx/config` validates and freezes this strict profile. The shared content compiler loads canonical agents through `@mpx/subagents`, applies the selected runtime profile, and emits final agent bytes and manifest details. Runtime build APIs receive no agent model mapping and copy compiler-owned skill and agent bytes unchanged. The separate `RuntimeModelSelectionV1` session default remains code-owned and is not an agent-class mapping or user-config schema surface. Agent compilation does not generate Pi-specific extension implementation.

## Four exposure states

| Exposure        | Initial model context       | Model search | Human list/search/detail | Explicit human load |
| --------------- | --------------------------- | ------------ | ------------------------ | ------------------- |
| `full`          | name, description, triggers | yes          | yes                      | yes                 |
| `name-only`     | name only                   | yes          | yes                      | yes                 |
| `explicit-only` | absent                      | no           | yes                      | yes                 |
| `off`           | absent                      | no           | no                       | no                  |

Model search is artifact-key-bound and can inspect canonical metadata only for `full` and `name-only`. Human search/detail is a separate explicit surface and may find `explicit-only`; prose mentioning a slash command is not explicit invocation. Bodies are lazy-loaded only after exact manifest, artifact, runtime, path, and content-hash revalidation. Project skills follow the same policy, publication, and validation rules.

## Pi

[ADR 0004](adr/0004-canonical-native-pi-extensions.md) supersedes the generated-extension ownership model. Gate 4 will move canonical Pi-specific source into `runtimes/pi/extensions`; native host Pi and whole-agent sandbox Pi will use that same checked-in extension package through normal Pi discovery. The adapter will not generate substitute footer, tool, hook, command, editor, widget, or lifecycle implementations.

The target Pi adapter projects runtime-neutral skills and agents plus launch-bound data such as the resolved manifest and runtime context. It registers the canonical package in the selected discovery surface, passes the selected account root as `PI_CODING_AGENT_DIR`, and translates paths for host or sandbox execution. Build output may package canonical source but is not a second implementation. Command registration, model search, and body loading consume the exact v4 reference, and Pi performs exact open-handle and body-hash checks.

The current adapter still publishes a self-contained projection containing runtime context, a generated `extension.mjs`, settings, keybindings, themes, compiler-generated agents, and policy-selected skills. Its explicit `--extension` and `--no-extensions` launch remain temporary migration state to be reconciled when Gate 4 replaces them; the canonical package must never be loaded through both explicit argv and discovery.

## Claude

The Claude adapter publishes an immutable plugin projection with compiler-generated skills and agents, hooks, status adapter, runtime context, and plugin metadata. Claude cannot natively represent every four-state distinction: `name-only` receives a neutral name/description surface and `explicit-only` uses `disable-model-invocation: true`. The neutral manifest remains authoritative. The selected private account root is passed only as `CLAUDE_CONFIG_DIR`. Generated `${CLAUDE_PLUGIN_ROOT}` variables are allowed only in Claude adapter templates, never canonical content.

Claude integrity checkpoints are `SessionStart`, `UserPromptSubmit`, and `PreToolUse Skill|Agent|Task|Bash`. Immutable-copy checks at these earliest supported boundaries detect change but cannot atomically interpose between Claude's native `SKILL.md` read and expansion. The status adapter independently parses and validates the live `StatusSnapshotV1`; it does not validate the whole projection.

Both adapters enforce the shared dangerous-command policy. Interactive runtimes have no artificial 120-second lifetime; finite probes remain bounded. Releases and public launch data never contain credentials or sessions. A whole-agent sandbox may stage only its selected identity's Pi, Git, SSH, GitHub, and GitLab runtime state for trusted extensions; the opposite identity and unrelated host state remain unavailable. KanbanFlow uses OS-keyring authorization rather than a route config path. Sandbox failure has no host fallback. Session continuation is provided by the lifecycle/session layer rather than by projection generation.

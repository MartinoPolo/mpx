# Runtime adapters

MPX resolves canonical content once into a runtime-neutral v4 manifest. The manifest records every canonical identity's inclusion decision, exposure, permissions, source hash, and metadata hash without embedding bodies, private roots, or runtime syntax. The logical skill artifact is distinct from each launch-bound reference to a full published runtime projection. Claude and Pi projections reference the same manifest key and have distinct artifact/file-map hashes.

## Four exposure states

| Exposure        | Initial model context       | Model search | Human list/search/detail | Explicit human load |
| --------------- | --------------------------- | ------------ | ------------------------ | ------------------- |
| `full`          | name, description, triggers | yes          | yes                      | yes                 |
| `name-only`     | name only                   | yes          | yes                      | yes                 |
| `explicit-only` | absent                      | no           | yes                      | yes                 |
| `off`           | absent                      | no           | no                       | no                  |

Model search is artifact-key-bound and can inspect canonical metadata only for `full` and `name-only`. Human search/detail is a separate explicit surface and may find `explicit-only`; prose mentioning a slash command is not explicit invocation. Bodies are lazy-loaded only after exact manifest, artifact, runtime, path, and content-hash revalidation. Project skills follow the same policy, publication, and validation rules.

## Pi

The Pi adapter publishes a self-contained projection containing runtime context, extension, settings, keybindings, themes, generated agents, and policy-selected skills. Command registration, model search, and body loading consume its exact v4 reference. Pi performs exact open-handle and body-hash checks. The selected private account root is passed only as `PI_CODING_AGENT_DIR`.

## Claude

The Claude adapter publishes an immutable plugin projection with policy-selected skills, canonical agents, hooks, status adapter, runtime context, and plugin metadata. Claude cannot natively represent every four-state distinction: `name-only` receives a neutral name/description surface and `explicit-only` uses `disable-model-invocation: true`. The neutral manifest remains authoritative. The selected private account root is passed only as `CLAUDE_CONFIG_DIR`. Generated `${CLAUDE_PLUGIN_ROOT}` variables are allowed only in Claude adapter templates, never canonical content.

Claude integrity checkpoints are `SessionStart`, `UserPromptSubmit`, and `PreToolUse Skill|Agent|Task|Bash`. Immutable-copy checks at these earliest supported boundaries detect change but cannot atomically interpose between Claude's native `SKILL.md` read and expansion. The status adapter independently parses and validates the live `StatusSnapshotV1`; it does not validate the whole projection.

Both adapters enforce the shared dangerous-command policy. Interactive runtimes have no artificial 120-second lifetime; finite probes remain bounded. Neither adapter copies credentials, sessions, private routes, or MCP descriptors. Phase F only consumes preprovisioned read-only routes/descriptors; Phase I provisions them. KanbanFlow uses OS-keyring authorization rather than a route config path. Docker remains gated pending F2 with no fallback. Session continuation is provided by the delivered Phase G lifecycle/session layer rather than by projection generation.

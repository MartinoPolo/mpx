# Runtime adapters

MPX resolves canonical content once into a runtime-neutral v4 manifest. The manifest records every canonical identity's inclusion decision, exposure, permissions, source hash, and metadata hash without embedding bodies, private roots, or runtime syntax. Claude and Pi projections are separate immutable artifacts that reference the same manifest key and have distinct artifact/file-map hashes.

## Four exposure states

| Exposure | Initial model context | Model search | Human list/search/detail | Explicit human load |
| --- | --- | --- | --- | --- |
| `full` | name, description, triggers | yes | yes | yes |
| `name-only` | name only | yes | yes | yes |
| `explicit-only` | absent | no | yes | yes |
| `off` | absent | no | no | no |

Model search is artifact-key-bound and can inspect canonical metadata only for `full` and `name-only`. Human search/detail is a separate explicit UI/CLI surface and may find `explicit-only`; prose mentioning a slash command is not explicit invocation. Bodies are lazy-loaded only after exact manifest, artifact, runtime, path, and content-hash revalidation.

## Pi

The Pi adapter publishes a self-contained projection containing the runtime context, extension, settings, keybindings, themes, generated agents, and policy-selected skills. Generated agent files derive from `content/agents` and `validate:generated` checks drift. Pi command registration, model search, and body loading consume the projection's exact v4 reference. The selected private account root is passed only as `PI_CODING_AGENT_DIR` at process execution.

## Claude

The Claude adapter publishes an immutable plugin projection with policy-selected skills, canonical agents, hooks, status adapter, runtime context, and plugin metadata. Claude cannot natively represent every four-state distinction in discovery metadata: `name-only` is projected with a neutral name/description surface, while `explicit-only` uses `disable-model-invocation: true`. This is compatibility projection only; the neutral manifest remains authoritative. The selected private account root is passed only as `CLAUDE_CONFIG_DIR`. Generated Claude plugin variables such as `${CLAUDE_PLUGIN_ROOT}` are permitted only inside the Claude adapter's generated templates, never canonical content.

Claude's `SessionStart`, `UserPromptSubmit`, and `PreToolUse Skill|Agent|Task|Bash` guards are the earliest supported compatibility checkpoints. They revalidate the full projection, but they are not an atomic skill-load interceptor. Self-modification between checkpoints cannot be claimed prevented.

Neither adapter copies credentials or sessions. Docker containment remains gated pending F2; session continuation is Phase G.

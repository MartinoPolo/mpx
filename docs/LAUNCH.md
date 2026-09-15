# Launch

Use `mpx launch claude|pi` or an installed alias:

| Alias     | Runtime | Identity   |
| --------- | ------- | ---------- |
| `cc-mpx`  | Claude  | `personal` |
| `ccw-mpx` | Claude  | `work`     |
| `pi-mpx`  | Pi      | `personal` |
| `piw-mpx` | Pi      | `work`     |

Identity is always explicit, including through aliases. Working-directory classification, projects,
and providers never select identity or native credentials. Native launchers remain untouched.

## Resolution

Launch resolves identity, project/location, selected skill packs, mode and resource admission,
runtime profile, workspace, network policy, and executor into immutable launch descriptor schema 3
and compiled artifacts. Selection provenance is recorded in the resolved manifest rather than
exposed as another policy knob. Unresolved/ambiguous roots, disallowed packs, and identity/domain
mismatches fail closed.

Committed project packs override user-project packs, which override the most-specific canonical
location. Repository and Issue providers remain independent. A directory change cannot mutate an
active session's selection.

Repeatable `--runtime-arg <value>` arguments are launch-only, bounded, and appended after
runtime-owned arguments. They cannot come from durable configuration or environment variables.
Removed options include `--skill-policy`, `--content-scope`, and `--grant`.

The selected runtime receives only its native account root: `CLAUDE_CONFIG_DIR` or
`PI_CODING_AGENT_DIR`. MPX does not read or copy credentials. Native provider authentication and
project trust remain runtime-owned.

## Skill invocation

Canonical managed skills use `/mpx:<name>` and opted-in managed project skills use `/skill:<name>`
in both runtimes. Unmarked native project skills remain runtime-native; Claude currently exposes
their raw native names. Malformed metadata, collisions, or ambiguous ownership fail closed instead
of being adopted.

Managed exposure is `full`, `name-only`, or `explicit-only`. `full` advertises description/trigger
metadata, never an eager body. A valid omitted exposure defaults to `full`; explicit values are
preserved. Managed-project opt-in uses `metadata.mpx.projectExposure` with the same three states.
`name-only` avoids the full description, and `explicit-only` remains deliberately invokable without
model discovery.

Pi supports skill-name completion at prompt start or within existing multiline prose. Type
`/mpx:<partial>` for accepted canonical inventory or `/skill:<partial>` for accepted managed project
inventory, then press Tab; a single match applies directly while preserving surrounding prose.
Completion includes explicit-only names, does not read bodies, and inserts text only. Automatic
popup completion is not currently promised because that behavior is owned by Pi's native editor; the
real editor path, not only the provider, is regression-tested. On submission, an exact intended
managed reference follows the same validated lazy loader while surrounding prose is preserved;
quoted, escaped, inline-code, fenced-code, and partial examples remain literal. Exact-name coloring
is optional and is not promised.

## Pi footer

The launch row displays `pi (mpx) · mode:developer · gh · gh` (`piw (mpx)` for work identity). Mode
comes from the resolved launch through `MPX_MODE`; changing it requires a new launch. No
skill-policy label or skill counts are displayed.

Provider badges follow repository-then-Issues order and are never collapsed, even when identical.
Provider selection comes from the session workspace's validated configuration at launch, not from
Git remotes: GitHub is `gh`, GitLab is `glab`, and KanbanFlow is `kf`. An absent Issue configuration
displays `none`; unavailable or invalid configuration displays `?` for each unknown role. Relaunch
to apply provider configuration changes. The worktree remains on its separate location line.

Footer hyperlinks open these destinations when available:

- Runtime identity: the MPX account configuration, not native Pi settings.
- Mode: the discovered project's `mpxconfig.json`.
- Repository: GitHub pull requests or GitLab merge requests, using the configured repository remote.
- Issues: the corresponding GitHub/GitLab issue list, or the explicitly configured KanbanFlow board.

Missing or unsafe destinations remain unlinked. Local directory projects do not acquire an inferred
repository or issue tracker. Links use terminal hyperlinks; opening them depends on the terminal and
local file associations.

## Executors

Windows host execution is an elevated compatibility path, not isolation. Manual use requires
explicit host selection, a reason, and fresh direct-TTY or exact argv-scoped approval. Installed
aliases provide the bounded one-use approval expected by their managed launch contract. A Windows
host process is not OS-level filesystem isolation, and removal of launch grants does not restrict
its reads.

Docker execution is unavailable. Launch and resume fail with `EXECUTOR_UNAVAILABLE` before
projection or process execution and never fall back to host.

Managed runtime environments receive `MPX_RUNTIME_EXECUTOR` from the resolved launch descriptor.
Workspace commands require this binding when runtime context is present; they reject missing or
invalid selections rather than assuming host execution. Relaunch after updating MPX to refresh the
binding in an existing session.

Executor readiness is checked internally by the selected adapter. MPX revalidates native
account/root ownership, real executable and invocation inputs, projection artifacts, launch binding,
required approvals, and support before spawn. It does not present a digest of a constant host
declaration as measured isolation evidence.

## Integrity and privacy

Before spawning, MPX publishes and revalidates the exact runtime projection and concrete executor
readiness inputs. Public descriptors, banners, audits, and errors omit credentials, native session
data, private roots, command output, and file contents.

Claude checks projection integrity at its earliest supported hook boundaries. Pi binds the manifest
to launch context and revalidates canonical skill files when loaded. Session continuation is handled
by the separate [session lifecycle](SESSIONS_INSTALLER.md).

## Error guidance

Human CLI errors include possible solutions and explanations; see [error guidance](ERRORS.md) for
working without project configuration and selecting packs and modes. Suggestions do not bypass
approvals or ownership checks. `--json` retains its existing contract, and native runtime and
gateway protocols retain their own error presentation.

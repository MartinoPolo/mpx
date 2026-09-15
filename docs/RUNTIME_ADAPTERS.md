# Runtime adapters

MPX compiles canonical content before runtime assembly. Adapters consume the verified compiled tree
and own only native projection assets, invocation arguments, concrete readiness checks, and runtime
lifecycle wiring.

## Shared boundaries

- `content/runtime-profiles.json` maps semantic model classes, capabilities, aliases, and supported
  frontmatter to each runtime.
- The compiler is the sole renderer; compiler-owned skill and agent bytes are copied unchanged.
- Private account roots are passed only to the explicitly selected runtime and identity.
- Adapters preserve real executable/invocation, account-root, artifact, launch-binding, approval,
  and pre-spawn validation.
- Releases and public launch data contain no credentials, native sessions, or private file contents.

## Pi

Canonical Pi implementation lives under `runtimes/pi/extensions` and is loaded once through native
package discovery. The adapter does not generate substitute UI or extension implementations.

The adapter passes `PI_CODING_AGENT_DIR`, compiled agents, launch context, executor binding, and
manifest integrity binding. The extension registers canonical `/mpx:<name>` and managed-project
`/skill:<name>` entries and lazily revalidates compiler-owned bodies.

Pi's editor-wide autocomplete provider suggests names from the accepted active inventory at prompt
start and inside multiline text without descriptions or body reads. Selecting a suggestion only
edits text. Exact submitted managed references in prose use validated lazy resolution; quoted/code
examples remain literal. Reload and session/worktree replacement refresh inventory, while invalid
projection state yields no trusted stale suggestions. Existing slash/path completion and editor
composition remain native.

Project skills are classified before launch. Valid `metadata.mpx.projectExposure` opts into managed
compilation with `full`, `name-only`, or `explicit-only`; unmarked skills retain native
interpretation. Ambiguous ownership, collisions, malformed metadata, unsafe indirection, path
escape, or changed files fail closed.

## Claude

Claude receives immutable canonical `mpx` and, when needed, managed-project `skill` plugin
projections. Repeated native plugin arguments preserve `/mpx:<name>` and `/skill:<name>`. Unmarked
Claude project skills keep Claude's actual raw native naming.

Claude represents `name-only` with neutral trigger metadata and `explicit-only` with
`disable-model-invocation`. Integrity checks run at the earliest supported native boundaries, but
are not an atomic interceptor around Claude's own reads. MPX documents this verified projection
behavior without claiming identical runtime APIs.

## Executor status

The internal `ExecutorAdapter.assertReady` boundary checks the selected adapter's concrete
executable, invocation, account/root, artifacts, launch binding, support, and approval inputs. A
constant host-adapter hash is not security evidence or sandbox proof.

Windows host execution is supported with explicit selection, reason, and fresh approval. It is not
OS filesystem isolation. Whole-agent Docker execution is unavailable and never falls back to host.
Runtime environments preserve standard system roots, `TEMP`/`TMP` selection, terminal identity, and
locale metadata needed by supported host tools. Ambient command overrides, authentication-agent
settings, credentials, proxies, endpoint selectors, and trust-store overrides remain excluded.

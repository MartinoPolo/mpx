# MPX decisions

Durable choices and their rationale, not implementation status or session history. Repository
conventions belong in `AGENTS.md`; rollout evidence and recovery belong in `migration/`.

## Product boundary

- **Use native harnesses, not replacements.** Pi and Claude Code own authentication, model settings,
  packages, transcripts, and interaction semantics so accounts remain usable without MPX.
- **Keep MPX stateless and Orca operational.** Orca owns worktrees, terminals, server visibility,
  orchestration status, and desktop attention. MPX may emit thin status events, but has no daemon,
  credential router, session or port registry, worktree service, or competing notification writer.
- **Keep independently chosen utilities independent.** MPX installation and retirement must not
  uninstall user utilities or absorb their state; ownership does not follow functional overlap.
- **Support Git Bash as the Windows shell contract.** Preserve shell identity so native hooks run
  with their configured syntax.

## Content and discovery

- **Author once and compile deterministic projections.** `content/` is canonical; ignored `dist/`
  is reproducible output, avoiding independently maintained harness copies and generated review churn.
- **Build self-contained skill bundles.** Copy dependencies and rewrite links into each bundle;
  use native skill-relative references rather than symlinks or MPX environment expansion internally.
- **Inline essential instructions at compile time.** Explicit includes, including transitive
  dependencies, supply concise behavior to skills and especially agents. Defer optional workflows
  and large references to skill-local files; accept small repeated fragments over runtime deduplication.
- **Share instructions only when reuse justifies indirection.** Require more than two distinct
  consumers and a clear benefit; otherwise inline behavior or retain a private conditional reference.
- **Share one writing standard across creation and auditing.** Keep instruction-design guidance in
  `WRITING_FOR_AGENTS.md`; artifact-specific requirements belong in their creation and audit workflows.
  This keeps the criteria aligned without loading overlapping authoring policies.
- **Keep discovery mechanics with the explorer.** Global agent guidance states only delegation
  essentials; native harnesses supply resource resolution and delegation mechanics. Model and effort
  defaults belong in structured agent metadata and runtime mappings, not repeated policy tables.
- **Use packs for relevance, not security.** Repository selection adds MPX resources through native
  discovery without suppressing native account, package, or project resources or mutating account-wide
  links. An empty selection disables only MPX global packs.
- **Respect project ownership and native precedence.** Project resources may override globals;
  resolve collisions through provenance and explicit comparison, never blanket deletion or disabling.
  Reserve `mp-` for MPX global skills and use project-owned names for new project skills.
- **Propagate selected packs to subagents.** Parent and child sessions need the same effective
  workflow vocabulary; discovery and named-skill preloading must preserve that selection.

## Configuration and accounts

- **Separate account configuration from project metadata.** User configuration owns native roots,
  domain roots, defaults, and executables; repository manifests own project identity and integrations.
- **Determine account ownership independently of manifests.** Recursive account domains identify
  personal and work locations. Mismatches are overridable warnings, and launch warnings require
  acknowledgement before a fullscreen UI can hide them.
- **Keep exceptional project metadata machine-local.** Explicit user overrides may supply missing
  metadata or accept its absence; repository manifests remain authoritative. Avoid parent-manifest
  inheritance because it can route unrelated repositories through the wrong providers.
- **Keep repository and Issue providers independent.** Route each operation through its configured
  provider rather than infer the Issue tracker from the Git host.
- **Use documented machine-root variables for personal paths.** Inject only allowlisted, available
  roots so shared content stays portable.
- **Preserve native profiles in place.** Account sharing is not isolation; installation and recovery
  may change only owned resources, not replace credentials, settings, histories, or unrelated packages.
- **Let Claude own its permission mode.** Orca's Manual option omits bypass flags without overriding
  native mode. Preserve explicit native settings and initialize only an absent default.
- **Fail visibly on invalid routing.** Report missing roots, unavailable packs, model substitution,
  and unknown resume metadata instead of guessing.

## Runtime and safeguards

- **Resume native sessions, not imported copies.** Native transcripts are authoritative; restore the
  exact harness, account, working directory, session, model, and recoverable effort. Unknown values
  require an explicit override.
- **Share safeguard policy, not native presentation.** Claude hooks and Pi operations use common
  policy while retaining their native denial and result semantics.
- **Keep formatting project-owned and bounded.** Run only configured, installed formatters on the
  edited file; no downloads, lint autofixes, staging, or rollback of a successful agent edit.
- **Block clear destructive accidents and unsafe Git mutations.** Dangerous-command findings and
  inability to inspect the affected shell command fail closed; this bounded policy is not a sandbox.
- **Enforce the actual package manager independently of MPX configuration.** Resolve command
  directories statically; warn on ambiguous transitions rather than apply a potentially wrong manager.
- **Scan staged additions for high-confidence secrets.** Confirmed findings block even with
  `--no-verify`; incomplete scans warn and permit without claiming a clean result.
- **Keep Fallow opt-in and project-owned.** Before push, a valid failing verdict blocks; missing or
  broken tooling warns and permits. Never download tooling or use an ambient global copy.
- **Leave verification policy to projects.** Global hooks do not guess or run repository checks,
  PR lookups, or commit-message policy.

## User interface

- **Keep reporting links in native presentation instructions.** Inline link guidance in Pi's
  appended system instructions and Claude's output style, not general agent guidance or a deferred
  shared document.

- **Prefer native UI and tools.** MPX adds thin presentation and lifecycle data without replacing
  native tool rendering, questions, MCP, web tools, shortcuts, or transcript semantics.
- **Keep status displays compact and operational.** Show session identity, current context and usage,
  and bounded child activity; omit cumulative token totals, ports, branch-state counts, and shortcut
  hints from the Pi footer. Claude retains native status-line and subagent payloads; renderers own
  presentation and bounded caches, not services.
  Use native location links rather than generated editor launchers.
- **Use native account quota data without reading credential files.** Bounded selected-account
  requests and response headers may update usage; missing data stays explicit and never blocks work.
- **Aggregate activity before reporting completion.** A parent waiting for children or follow-up work
  is still working; child completion must not trigger whole-session attention. Orca owns stopped
  notifications, with no separate suppression requirement for manual cancellation.

## Documentation and lifecycle

- **Separate rationale, conventions, and state.** `README.md` explains use, `AGENTS.md` governs
  repository work, this file records lasting choices, and `migration/` holds rollout and recovery.
- **Keep project-document guidance with its workflows.** Scaffolds define initial structure;
  editing skills carry their own confirmation and preservation boundaries. Avoid a separate strategy
  layer, mandatory decision dates, and arbitrary document-length targets.
- **Retire dependencies before artifacts.** Preserve dirty state, histories, and recovery material
  until active consumers are disconnected and restart/recovery checks pass. Publication, archival,
  renaming, and deletion require explicit action rather than installation side effects.
- **Keep one active MPX implementation.** Preserve accepted capabilities when replacing an
  implementation, but do not retain active legacy launchers, fallback runtimes, or discoverable legacy
  resources. Native account data and protected offline recovery artifacts remain separate.

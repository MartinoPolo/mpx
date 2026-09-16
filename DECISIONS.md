# MPX decisions

This file records durable choices and rationale. It does not track rollout state or implementation
history; see `migration/` for those records.

## Product boundary

- **Use native harnesses rather than replacing them.** Pi and Claude Code own authentication, model
  settings, packages, transcripts, and their native interaction model. This keeps account data usable
  without an MPX service or proprietary session store.
- **Keep MPX stateless.** MPX has no daemon, credential router, session registry, worktree service, or
  port registry. Configuration and native transcripts are sufficient, reducing recovery and lifecycle
  risk.
- **Keep Orca as the sole operational shell.** Orca owns worktrees, terminals, server visibility,
  orchestration status, and desktop attention. MPX may provide thin status events but must not create a
  competing notification writer.
- **Preserve separately chosen user utilities.** `agent-resurrect`, `mpx-worktrees`, and the
  `mpx-ports` inspect/kill utility remain independent tools by explicit user choice. Retiring the
  old MPX managers does not uninstall them or absorb their state into MPX.
- **Support Git Bash as the Windows shell contract.** Launchers preserve shell identity so native hooks
  execute with the syntax under which they were configured.

## Content and discovery

- **Author once and compile deterministic projections.** Canonical content lives under `content/`;
  committed Claude/Pi projections live under `dist/`. This makes harness differences explicit and
  reviewable without maintaining independent workflow copies.
- **Keep support files and relative references with their skill.** The compiler validates frontmatter,
  declared substitutions, and references so structurally broken resources do not reach an account.
- **Use packs for relevance, not security.** A repository selects packs through `mpxconfig.json`.
  Wrappers add selected pack paths without suppressing native account, package, or project resources.
  An explicit empty selection disables only MPX global packs.
- **Treat projects as owners of project-local resources.** Native precedence may let a project skill
  override a global skill. Resolve collisions through provenance and explicit comparison, never prefix
  deletion or blanket native-skill disabling.
- **Reserve `mp-` names for MPX global skills.** New project-specific skills use project-owned names so
  accidental shadowing is exceptional and visible.
- **Propagate selected packs to subagents.** Parent and child sessions need the same effective workflow
  vocabulary. The checkout-local subagent patch is limited to discovery and named-skill preloading.

## Configuration and accounts

- **Keep account and repository configuration separate.** User configuration maps personal/work native
  roots, domain roots, defaults, and executables. Repository `mpxconfig.json` selects project identity,
  packs, package manager, repository provider, and Issue provider.
- **Keep repository and Issue providers independent.** A GitLab repository may use KanbanFlow Issues;
  skills must route each operation through its selected provider guide rather than infer one from the
  other.
- **Use machine-root variables for personal paths.** Shared content receives only the documented root
  allowlist and skips absent values. This avoids embedding machine-specific paths in portable content.
- **Preserve native profiles in place.** Account sharing is intentional, but it is not isolation.
  Installation and recovery must change exact owned resources without replacing credentials, settings,
  histories, or unrelated packages.
- **Let Claude own its native permission mode.** Orca's Manual launch option means no bypass flag;
  it does not force Claude's native Manual mode. Synchronization preserves an explicitly configured
  native mode, including Auto, and initializes only an absent default.
- **Fail visibly on invalid routing.** Missing roots, unavailable packs, model substitution, and unknown
  resume metadata are reported rather than guessed.

## Runtime behavior

- **Resume native sessions instead of importing them.** Native transcripts remain authoritative. Resume
  restores the exact harness, account, cwd/worktree, session, model, and recoverable effort; unknown
  values require an explicit override.
- **Use thin shared safeguards with native transports.** Claude hooks and Pi operations share policy,
  while each harness keeps native denial and result presentation.
- **Keep formatting project-owned and bounded.** Only configured installed formatters run, only for the
  edited file, without downloads, lint autofixes, staging, or rollback of a successful agent edit.
- **Prefer native UI and tools.** MPX adds only the accepted Pi footer/lifecycle data and preserves native
  tool rendering, questions, MCP, web tools, shortcuts, and transcript semantics.
- **Aggregate activity before reporting completion.** A parent waiting for children or follow-up work is
  still working. Child completion alone must not trigger whole-session attention.

## Safeguards

- **Block clear destructive accidents and unsafe Git mutations.** Positive dangerous-command findings
  and inability to inspect the affected shell command fail closed. The policy is intentionally bounded;
  it is not a shell sandbox.
- **Enforce the repository's actual package manager.** Detection is independent of `mpxconfig.json` and
  follows statically resolved command directories. Ambiguous transitions warn instead of applying a
  potentially wrong manager.
- **Scan staged additions for high-confidence secrets.** Confirmed findings block even with
  `--no-verify`. Incomplete scans warn and permit but never claim a clean result.
- **Run Fallow only for opted-in repositories before push.** A valid failing verdict blocks. Missing or
  broken project-owned tooling warns and permits; MPX never downloads or invokes an ambient global copy.
- **Leave project verification to projects.** Global hooks do not guess or run repository typechecks,
  lint, tests, PR lookups, or commit-message policy.

## User interface

- **Keep the Pi footer compact and operational.** It shows account, model/effort, project/worktree/branch,
  current context usage, compaction history, cost, quota/reset, and bounded child status. It omits
  cumulative token totals, ports, branch-state counts, and shortcut hints.
- **Preserve the accepted Claude status lines in this repository.** Claude retains its native
  status-line and subagent payloads; the renderers own only presentation and bounded derived caches,
  not a service or session registry. Native location links replace generated editor launchers.
- **Use native account quota data without credential-file reads.** Bounded selected-account provider
  requests and response headers may update usage; unavailable data stays explicit and does not block a
  session.
- **Do not special-case manual cancellation notifications.** Orca's normal stopped notification is
  acceptable. Correctly distinguishing stopped from finished is useful, but notification suppression is
  not a product requirement.

## Documentation and lifecycle

- **Separate durable rationale from changing state.** `README.md` explains use, `AGENTS.md` explains
  repository conventions, `DECISIONS.md` explains why, and `migration/` holds evidence, rollout state,
  and recovery.
- **Preserve before retiring.** Legacy repositories, dirty state, histories, and recovery artifacts stay
  intact until active consumers are removed and restart/recovery checks pass. Publication, archival,
  folder renaming, and deletion are explicit operations rather than side effects of installation.
- **Deprecation means disconnecting active dependencies first.** Source can remain read-only for
  provenance after launchers, hooks, links, patches, and project resources no longer depend on it.
- **Keep one active MPX implementation.** This repository replaces the previous MPX installation and
  the separate Pi/Claude repositories. Carry over accepted active features before archival; do not
  retain legacy launch commands, fallback runtimes, or discoverable legacy resources. Native account
  data stays in place. Protected offline recovery artifacts are not active installations.

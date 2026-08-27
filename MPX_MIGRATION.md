# MPX Unified System Migration

**Status:** Sole authoritative active migration plan; Phases A–F complete at their accepted boundaries; Phase F1 source/capability convergence, Phase F2 isolation proof, and Phases G–J remain pending
**Destination:** `C:/_MP_projects/mpx`  
**Migration mode:** Gradual replacement with the old installations retained until the new system passes all acceptance gates  
**Canonical project manifest:** `mpxconfig.json`

## 1. Executive decision

Create a new private-first `mpx` monorepo and fully consume the maintained source, required provenance, and relevant history of:

- `mpx-claude-code`
- `mpx-pi`
- `mpx-ports`
- `mpx-worktrees`
- `agent-resurrect`

Keep these independent:

- `kanbanflow-cli`: separate Rust CLI and credential owner, consumed through the MPX issue adapter.
- Grovekeeper and any future desktop app: optional external consumers of MPX contracts, never dependencies or authorities for MPX.
- Voice Grill and other domain applications unless a later decision explicitly moves a shared contract into MPX.

Deliver one installed `mpx` CLI, one canonical skill/agent source, one Claude Code plugin named `mpx`, one Pi runtime adapter, and stable versioned JSON/library contracts that a future GUI can consume. `mpx-claude-code` and `mpx-pi` are active migration sources, not permanent products or independent plans; after Phase J neither checkout remains active, while native Claude/Pi account state remains in harness-owned roots outside the MPX repository as designed.

The new and old systems coexist at the installation level during migration. New MPX code does not carry runtime fallbacks for `.worktree-hub.json`, `.mpx/kanbanflow.json`, `statusline-projects.json`, or old command namespaces. One-time migration tools and rollback snapshots are allowed; permanent compatibility branches are not.

## 2. Decisions fixed by this plan

### Naming

- Repository and product: `mpx`.
- Project config: `mpxconfig.json`.
- CLI executable: `mpx`.
- Claude Code plugin: `mpx`.
- Claude skill namespace: `/mpx:<skill>`.
- Pi command namespace: `/mpx:<skill>`.
- Canonical skill identities are bare names such as `execute`, `review`, and `issue-refine`; the plugin supplies `mpx:`.
- Canonical MPX subagent IDs use `mpx-*` where a globally unique agent name is needed.
- Public work-item term: **Issue** everywhere.
- KanbanFlow public CLI grammar becomes `kf issue ...`; only KanbanFlow REST paths and wire DTO names may retain `task` because that is the upstream API vocabulary.
- `agent-resurrect` becomes the MPX Sessions domain, exposed as `mpx session ...`.
- Port tooling becomes `mpx ports ...`.
- Worktree tooling becomes `mpx worktree ...`.

### Configuration boundaries

- One human-authored, committed project integration manifest: `mpxconfig.json`.
- `.worktreeinclude` remains a separate project-root file because it is the established include-filter convention and is consumed by worktree creation.
- `.worktree-ports.json` remains generated, gitignored, and local to each checkout.
- Credentials, personal/work account selection, machine roots, skill-pack scopes, and skill-exposure preferences remain user-local.
- Skill-pack membership determines availability; skill exposure independently determines initial model context and invocation policy.
- Canonical skills declare a default exposure, while user-local scope and project overrides may narrow or broaden exposure without copying skill descriptions.
- Skill bodies are never part of initial session context. Runtime adapters load them only after an authorized model invocation or an actual slash/UI/CLI invocation.
- Dynamic leases, process state, session state, and worktree catalog data remain generated machine state.
- `AGENTS.md` remains the canonical project instruction document; large prose policy does not move into JSON.
- Existing package scripts, CI jobs, and framework configuration remain authoritative; `mpxconfig.json` references them rather than duplicating their command bodies.

### Credential ownership and agent access

MPX routes identity-bound capabilities and does not own or copy service secrets. GitHub remains authenticated through `gh`, GitLab through `glab`, KanbanFlow through `kf` and the OS keyring, Cloudflare and Sentry through their approved native CLI or MCP integration, and Claude/Pi through their isolated native roots. An installed CLI or host credential does not by itself grant model authority.

Every provider operation requires the selected identity, an identity-owned route, an authenticated native tool, a trusted adapter with the requested capability, and an executor/network policy that admits the route. Unsupported or mismatched combinations fail structurally and never borrow the opposite identity. Host execution is explicit elevation because a raw host shell may reach native credentials. Docker receives narrow routed capabilities rather than mounted credential stores. Pi's host control plane keeps OAuth while all model-visible file, shell, browser, process, Git, and provider actions cross the launch-bound executor.

### Workflow

- Git is the only VCS in scope.
- Worktrees are optional per operation, not a repository-wide strategy.
- A human or skill chooses `--worktree` or `--current` for each issue.
- Worktree creation uses the standard sibling folder `<main-parent>/<repo>.worktrees`.
- Worktree creation never opens an editor.
- The main checkout is workspace slot zero and always receives its managed preferred-port reservation.
- Linked worktrees receive later stable slots.
- One database may be shared by all worktrees of a project; MPX does not allocate a database instance per worktree unless a future project explicitly requests it.
- Project-defined post-create preparation may run only under revision-bound trust. Approval is tied to the canonical repository, commit/config hash, and package manifest/lockfile/script fingerprints; a change invalidates approval. Explicit arbitrary executables require a separate approval.

### AI execution policy for the migration

- Main orchestrator: `openai-codex/gpt-5.6-sol`, thinking `high`.
- Bounded implementation subagents: `openai-codex/gpt-5.6-sol`, thinking `low`.
- Exploration and verification subagents: `openai-codex/gpt-5.6-terra`, thinking `low`.
- Independent work is launched in parallel from the main orchestrator.
- Subagents do not orchestrate nested fleets.
- Each implementation subagent receives pre-analysed files, interfaces, acceptance checks, and a narrow package scope.
- Parallel modifications use isolated branches/worktrees inside a clone sandbox or separate clone sandboxes and are integrated only after package-level checks pass.

## 2A. Launch architecture amendment

This approved amendment is normative where older scope/account wording conflicts with it. The corrected Phase B2 contract implements four-state skill exposure, project and scope launch defaults, alias resolution, and fail-closed launch selection. Runtime integration and execution remain deferred.

### Immutable launch model and fast-path defaults

A launch has independent dimensions: **identity** (personal/work native principal), **mode** (capability/resource policy), **skill policy** (packs and exposure), **executor** (`host`/`docker`), **sandbox workspace strategy**, **network policy**, **preset** (user-local composition), **CWD classification**, additive **grants**, and the resolved **skill artifact**. The complete tuple and a separate opaque `launchKey` are immutable for the process/session lifetime. Presets provide inputs, while the tuple records resolved values. Any change or elevation requires relaunch. In-harness UI may browse and select only the next launch; it cannot widen current rights.

Normal interactive use must not require remembering this tuple. A terminal already opened in a project is the primary selector. `cc`, `ccw`, `pi`, and `piw` pass only their explicit harness and personal/work identity choice to MPX; `mpx launch` resolves every other value from the current CWD and user-local launch defaults. For Pi, `pi` selects the native personal root authenticated to the designated personal ChatGPT account, while `piw` selects the native work root authenticated to a separate designated work ChatGPT account. The aliases do not provide account-switching fallback or add a preset, grant, or other launch authority. A Windows Terminal project profile continues to set its starting directory and invokes the same short launcher, so opening a project tab and typing `ccw` or `pi` remains the fast path.

Launch-default precedence is: explicit command argument; user-local project launch default keyed by canonical `project.id`; user-local longest-root scope launch default; built-in safe default. A committed project manifest may declare required development endpoints and services but never chooses identity, grants, executor, credential route, or a permission-widening default. A launcher with an explicit identity must fail closed when the selected project does not belong to that identity domain; it must not silently switch identities. The resolved default must be displayed compactly before the first turn and be inspectable with `mpx launch explain --cwd . --json`.

Identity selects native Claude/Pi roots and their auth/history/sessions/trust/cache, Git author routing, provider CLI routes, SSH route, and explicit MCP sharing. Pi's personal and work identities use separate native roots authenticated to two separate ChatGPT accounts; auth, history, sessions, trust, caches, and account selection are never shared or copied between them. Native stores remain authoritative: MPX config contains no secret values, private keys, raw account identifiers, or copied native credentials/auth paths.

Pi account enrollment uses the accepted local `root-attested` mode after native `/login`. `mpx account enroll --identity NAME` produces a no-write plan proving only the configured root and registry state; it does not live-probe auth. Confirmation with the exact `--confirm-plan` digest re-plans, performs the live supported OAuth probe, and commits only if both checks still match; changing a configured root requires the equivalent explicit `re-enroll` flow. One globally locked atomic private registry stores only schema version, opaque reference, identity, runtime `pi`, canonical root digest, mode, and timestamps. The configured identity root is the sole root input. Every production Pi launch and resume verifies the enrollment tuple and live supported OAuth availability before route, status, projection, lifecycle, native-target, or process effects; missing, changed, duplicate, malformed, unavailable, or mismatched state fails closed. Re-enrollment preserves the opaque reference and never auto-rebinds sessions. The supported probe is exactly `auth check --provider openai-codex --json --no-refresh` under that root and stores no probe output. This local mode deliberately cannot detect an account switch performed within the same native root; Pi exposes no supported stable non-secret account subject, so MPX makes no stronger designated-account claim.

CWD classification never selects identity and grants no filesystem rights. Provider `connections` move from scopes/projects to identities. Identities, modes, presets, and connections never enter committed `mpxconfig.json`.

Native account roots separate storage but do not enforce filesystem boundaries. Path classification, intended read/write policy, and effective enforcement are separate reported facts. Host/raw shell policy can be advisory and must never be called sandbox isolation; hooks report exactly what they intercept and known bypasses. Docker mounts are stronger enforcement but retain documented host, service, mount, and confidentiality limitations.

### Built-in modes and elevation

| Mode | Intended policy |
| --- | --- |
| `project` | Current canonical repository/worktree read/write only when it belongs to the selected identity domain. Opposite-domain projects require an explicit cross-domain grant. |
| `developer` | Selected identity domain read/write; `${MPX_CLONED}` read-only. |
| `personal-assistant` | `${MPX_OBSIDIAN_VAULT}` and `${MPX_AI_GENERATED}` read/write. |
| `computer-control` | Explicit allowlist of dotfiles, AppData application config, Windows Terminal, and non-authoritative harness preferences; credentials, auth, history, sessions, caches, launch policy, and managed launcher blocks excluded. Executable-bearing settings require a separately confirmed staged apply. |
| `unrestricted` | Emergency host-wide access; never inferred or defaulted. |

Unknown CWD fails closed. A project CWD outside the selected identity domain also fails until an explicit cross-domain grant is present; recognition as a project never bypasses identity policy. Cross-domain grants are launch-only and read-only by default; read/write requires explicit syntax (`--grant ro:<resource>` / `--grant rw:<resource>`). Elevation requires relaunch, a persistent visible banner, a human reason, and a sanitized local audit with no prompt, secret, or unnecessary raw path. MPX launch policy, identity routes, and managed shell blocks form a protected control plane changed only through a separately confirmed `mpx install plan|apply` flow.

Skill policy is orthogonal to filesystem mode. Initial named policies are:

| Skill policy | Availability and initial disclosure |
| --- | --- |
| `clean` | All trusted canonical skills remain human-searchable and human-invocable; default exposure is `explicit-only`, so no catalog names or descriptions enter initial model context. |
| `developer` | Core and development packs are available; only a deliberately small workflow set is `full`, with the remainder `name-only` or `explicit-only`. |
| `personal-assistant` | Personal-assistant packs are available with the same least-disclosure rule; filesystem access still comes only from mode/grants. |

A preset may align mode and skill policy under the same friendly label, but they remain separate resolved axes. Existing content scopes remain lower-level catalog inputs that supply root-derived pack/exposure defaults and project overrides; a skill policy selects or narrows those inputs for a launch. `--content-scope` is an expert catalog-composition override only. Invoking an available skill never widens filesystem policy; it may fail with a denied capability.

### CLI and executors

`mpx runtime claude|pi` remains low-level. Add `mpx identity list|show`, `mpx mode list|show`, `mpx skill-policy list|show`, `mpx preset list|show`, `mpx launch explain`, and searchable/autocomplete `mpx launch [claude|pi] --identity ... --mode ... --skill-policy ... --content-scope ... --executor ... --workspace ... --network-policy ... --preset ... --cwd ... --grant ... --reason ...`. Omitted launch dimensions resolve from the current project's user-local defaults. Mode defaults from CWD unless explicit; identity does not. If retained, `--scope` is renamed `--content-scope` and is described only as content composition, never security. `cc`/`ccw` and `pi`/`piw` keep fast personal/work identity selection and delegate directly to `mpx launch`, rather than encoding a copied command tuple. Existing `ccd`/`ccwd` danger variants remain explicit elevated host launches; once managed by MPX they require the same relaunch reason, banner, and audit as any unrestricted launch.

Docker Sandboxes is the required default executor for normal agent launches after its acceptance gate passes; host filesystem execution is an explicitly elevated compatibility/emergency path, never a silent fallback. During implementation, a launcher must fail closed with an actionable diagnostic until its selected sandbox runtime and authentication route pass the gate. Use the standalone `sbx` product and pin a version that supports the required environment, credential, policy, and clone contracts; the legacy Docker Desktop `docker sandbox` plugin is not an upgrade path. Generated sandbox environment files belong under local MPX state outside every mount, with no literal secrets or native-auth paths. Launches do not share Docker's mutable cross-sandbox skill store by default.

Workspace isolation and Git delivery are separate choices:

| Workspace strategy | Where the agent edits | Agent Git access | Host visibility and intended use |
| --- | --- | --- | --- |
| `clone` (normal default) | A private full clone inside the sandbox; the host source is mounted read-only. | Full branch, commit, fetch, push, and signing support. | Changes appear on the host only after an optional fetch from `sandbox-<name>` or after the agent pushes. This replaces a host-created worktree for that agent task; it is not layered on top of one. |
| `host-worktree` (explicit compatibility) | A host-created worktree mounted read/write. | No: Docker mounts the worktree but not the common Git administration directory referenced by its `.git` pointer. | File edits appear immediately. The human performs status/commit/push from the host, preserving the current host-worktree workflow. |
| `direct` (explicit elevated compatibility) | The current host checkout mounted read/write. | Yes. | Edits and Git mutations reach the host immediately; use only when that weaker boundary is intentional. |

Docker clone mode cannot be created from a linked non-main host worktree, so MPX launches it from the main repository checkout and records the sandbox/task branch. A clone sandbox may itself contain multiple branches or internal Git worktrees for parallel tasks. Separate clone sandboxes remain preferable when modifying agents need failure and lifecycle isolation. Clone mode protects host files and host Git metadata from writes, not the readable source from disclosure; extra workspaces remain direct mounts unless independently constrained.

A sandbox commit is a durable checkpoint and transport, not a mandatory host-review gate. The user or orchestrator may fetch it to the host, or an authorized skill may push it, create/update a PR or MR, watch CI, and merge it directly. MPX must not impose a sandbox-wide ban on commit, push, review creation, readiness, or merge. The selected skill owns the workflow and safety gates; optional committed `workflow.codeReview` policy sets a project ceiling, and the identity's Git/provider credential route supplies the actual authority. Executor and workspace selection never silently change that policy. This preserves autonomous shipping skills while allowing a project or planning preset to select read-only provider credentials when desired.

Claude/Codex built-in sandbox agents may use Docker's supported host-side credential isolation. Pi is a third-party sandbox agent, and Docker currently does not support proxy-managed OAuth for third-party agents. Because this system requires Pi to use the ChatGPT/Codex subscription and forbids API-token substitution, the default Pi design is split: Pi, its OAuth store, model connection, session UI, and MPX launch control plane stay on the host, while its model-visible file, shell, process, browser, Git, and development-service tools are replaced by a narrow MPX remote executor backed by the sandbox. Native host file/shell tools are absent, not merely instructed against use. An all-in-sandbox Pi `/login` is not accepted because it exposes real OAuth credentials to an agent-controlled VM. A future Docker feature may permit a fully in-sandbox Pi only after an equivalent no-token-in-VM proof.

One interactive task normally owns one named sandbox clone. Subagents inherit the parent launch tuple, network policy, mounts, identity routes, and skill artifact and may only narrow them. Cooperative subagents may share that task sandbox; independently modifying parallel agents receive separate branches/internal worktrees or separate clone sandboxes. Their work may be integrated through the sandbox remote, a provider remote and PR/MR, or an orchestrator merge according to the selected workflow. Merely selecting a different agent role/model/thinking level never changes its filesystem, network, credential, or MCP authority. Agent-role defaults live in the canonical agent catalog, so ordinary work does not require launcher flags.

Network policy is independent from filesystem isolation and provider action authority. Docker rules constrain destination host/IP/port, not HTTP methods or provider operations, so they cannot distinguish viewing a PR from merging it when both use the same provider endpoint. Initial named policies are:

| Network policy | Intended use |
| --- | --- |
| `research` | Unrestricted public outbound TCP/HTTP(S) for planning, grilling, package and documentation research. Private, link-local, cloud-metadata, and host-network destinations remain blocked except for explicit project services. |
| `implementation` | Docker's version-pinned balanced development baseline plus user-approved project additions: package registries, source/code hosts, dependency documentation, required cloud services, development/test/production origins, and exact local development services. |
| `delivery` | `implementation` plus deployment or operational control-plane endpoints required by the project's shipping workflow. Whether the agent may push, create a review, or merge is still decided by workflow policy and credentials. |
| `minimal` | Default-deny with only the model/auth transport and exact task endpoints required by the selected runtime architecture. |

`implementation` is the normal project default; `research` is the simple broad-web override, and a project whose allowlist becomes burdensome may explicitly default to `research`. MPX proposes narrower user-local policy from package manifests, committed project endpoints, and representative `sbx policy log --json` observations. Dependency metadata and observed traffic are hints rather than authority: generated suggestions require human approval, an untrusted repository cannot widen policy, and MPX verifies the effective sandbox policy with `sbx policy check network`. The launch banner states that public egress permits exfiltration of readable source, prompt/tool data, and any sandbox-visible credential even though the host filesystem remains isolated. Direct external UDP/ICMP limitations remain accurately reported.

### Four-state skill exposure

| Exposure | Initial model context | Model loading | Human invocation |
| --- | --- | --- | --- |
| `full` | Name, description, triggers | Allowed | Slash/UI/CLI |
| `name-only` | Name only | Allowed | Slash/UI/CLI |
| `explicit-only` | None | Rejected | Actual slash/UI/CLI only |
| `off` | None | Rejected | Absent |

`explicit-only` is the no-discovery, human-invocable state. It has no model-visible metadata and is reachable only through an actual slash/UI/CLI invocation; prose that resembles a slash command never expands it. Human autocomplete and search must list every user-invocable skill, including `explicit-only`, so the user never needs to remember a hidden marker syntax. `name-only` is the lean default: the model sees a stable skill name and may load that skill body lazily from the middle of a prompt. `full` is reserved for deliberately small, safe-to-auto-invoke workflows. Loading always validates launch-bound manifest membership, canonical path containment, provenance, hash, and runtime compatibility. There is no `[[mpx:*]]` marker syntax.

Only `full` and `explicit-only` map directly to both harnesses' ordinary skill behavior. `name-only` is an MPX compatibility projection, not a native Claude/Pi state: Claude otherwise derives a description when one is omitted, while Pi normally requires and publishes descriptions. The generated Claude artifact must use a minimal identity-only discovery stub without canonical description/triggers, and the Pi adapter must bypass native skill discovery for canonical MPX skills and inject only stable names. Acceptance snapshots inspect the actual harness prompt/context, not merely the MPX manifest, so an accidental first-paragraph or description fallback fails the gate.

Human CLI/TUI list/search/autocomplete sees all user-invocable skills, but descriptions remain outside model context until explicit human detail/search. Model search remains bounded, artifact-bound, and limited to `full`/`name-only`. Thus a person can type a full skill name mid-prompt without initial description bloat or model auto-invocation.

### User-local example

```json
{
  "identities": {
    "personal": {
      "domain": "personal",
      "runtimeRoots": {"claude": "~/.claude", "pi": "~/.pi/agent"},
      "gitAuthorRoute": "personal",
      "providerRoutes": {"github": "github-personal"},
      "sshRoute": "personal-agent",
      "mcpSharing": {"allow": ["context7"], "shareNativeAuth": false}
    },
    "work": {
      "domain": "work",
      "runtimeRoots": {"claude": "~/.claude-work", "pi": "~/.pi/agent-work"},
      "gitAuthorRoute": "work",
      "providerRoutes": {"gitlab": "gitlab-work", "kanbanflow": "kanbanflow-work"},
      "sshRoute": "work-agent",
      "mcpSharing": {"allow": ["context7"], "shareNativeAuth": false}
    }
  },
  "domains": {
    "personal": ["${MPX_PROJECTS}"], "work": ["${MPX_WORK}"], "oss": ["${MPX_CLONED}"],
    "assistant-input": ["${MPX_OBSIDIAN_VAULT}"], "assistant-output": ["${MPX_AI_GENERATED}"],
    "cloud": ["${MPX_ONEDRIVE}"]
  },
  "contentScopes": {
    "personal": {"roots": ["${MPX_PROJECTS}"], "skillPacks": ["core", "personal"]},
    "work": {"roots": ["${MPX_WORK}"], "skillPacks": ["core", "work"]}
  },
  "modes": {
    "project": {"resources": {"selected-project": "read-write"}},
    "developer": {"resources": {"identity-domain": "read-write", "cloned-repositories": "read-only"}},
    "personal-assistant": {"resources": {"assistant-input": "read-write", "assistant-output": "read-write"}},
    "computer-control": {"resources": {"computer-control-config": "read-write", "computer-control-executable-settings": "staged-write"}},
    "unrestricted": {"resources": {"host": "read-write"}}
  },
  "skillPolicies": {
    "clean": {"skillExposure": {"default": "explicit-only"}},
    "developer": {"skillPacks": ["core"], "skillExposure": {"default": "name-only"}},
    "personal-assistant": {"skillPacks": ["core", "personal"], "skillExposure": {"default": "name-only"}}
  },
  "presets": {
    "personal-dev": {"identity": "personal", "mode": "developer", "skillPolicy": "developer", "contentScope": "personal", "executor": "docker", "workspace": "clone", "networkPolicy": "implementation"},
    "personal-research": {"identity": "personal", "mode": "project", "skillPolicy": "developer", "contentScope": "personal", "executor": "docker", "workspace": "clone", "networkPolicy": "research"},
    "work-project": {"identity": "work", "mode": "project", "skillPolicy": "developer", "contentScope": "work", "executor": "docker", "workspace": "clone", "networkPolicy": "implementation"},
    "work-delivery": {"identity": "work", "mode": "project", "skillPolicy": "developer", "contentScope": "work", "executor": "docker", "workspace": "clone", "networkPolicy": "delivery"}
  },
  "launchDefaults": {
    "scopes": {"personal": {"personal": "personal-dev"}, "work": {"work": "work-project"}},
    "projects": {"MartinoPolo/mpx": {"personal": "personal-dev", "work": "work-project"}}
  },
  "networkPolicies": {
    "research": {"preset": "allow-all", "denyPrivateNetworks": true},
    "implementation": {"preset": "balanced", "approvedProjectAdditions": true},
    "delivery": {"extends": "implementation", "approvedDeliveryAdditions": true},
    "minimal": {"preset": "deny-all", "requiredRuntimeEndpoints": true}
  },
  "executors": {"host": {}, "docker": {}}
}
```

All `${MPX_*}` values are environment-resolved root tokens. `~` is permitted only in documented user-local path fields and resolves to the platform user home. Routes are labels, never secret payloads or private-key paths. Network policy declarations are MPX compositions, not raw `sbx policy init` arguments: the executor materializes their base preset plus sandbox-scoped allow/deny rules and verifies the result.

### Privacy-safe motivation

Aggregate path-class evidence (no prompts or filenames) shows Pi primarily using `${MPX_PROJECTS}` and `${MPX_WORK}`, recurring `${MPX_CLONED}` references, and targeted Pi/AppData config. Personal Claude also touches work, `${MPX_ONEDRIVE}`, home/AppData, and OSS; work Claude history includes personal/home/OneDrive paths. This motivates explicit modes and cross-domain grants, not inferred identity or widened access.

## 3. Goals

1. Make Claude Code and Pi thin runtime adapters around the same instructions, skills, agents, scripts, configuration, and domain services.
2. Make issue, review, CI, port, worktree, package, and session operations deterministic CLI capabilities rather than prose-selected shell commands.
3. Replace hard-coded absolute cross-repository imports with workspace package APIs and generated runtime artifacts.
4. Support GitHub, GitLab, Gerrit, KanbanFlow, and future issue providers without embedding provider commands in skills.
5. Guarantee deterministic per-checkout ports for managed services and coordinate leases across repositories on one machine.
6. Make each supported project actually consume assigned ports in dev, preview, Storybook, tests, public origins, and coupled tools.
7. Provide tracked noninteractive worktree preparation suitable for humans, agents, status lines, and a future GUI.
8. Track active, unfinished, resumable, completed, and abandoned AI sessions as durable workflow state rather than disposable daily snapshots.
9. Install and verify the complete system idempotently across shell profiles, Claude accounts, Pi, Windows Terminal, Raycast, Obsidian, scheduled tasks, and local tool paths.
10. Select identity, capability mode, skill exposure, and effective filesystem enforcement explicitly and consistently across Claude and Pi without treating CWD classification as authorization.
11. Preserve rollback until the replacement proves equivalent or better.

## 4. Non-goals

- MPX does not depend on Grovekeeper or any future desktop app.
- MPX does not absorb `kanbanflow-cli`.
- MPX does not create a unified token vault in the initial system.
- MPX does not support non-Git VCS providers initially.
- MPX does not port-enable the React Native template in this migration.
- MPX does not start editors during worktree creation.
- MPX does not provision a separate database for every worktree by default.
- MPX does not make every available skill or every skill description model-visible in every session.
- MPX does not claim sandbox-grade isolation for the host executor or silently fall back to it when the selected Docker executor is unavailable.
- MPX does not permit an active session, model, or extension to widen its launch-bound rights.
- MPX does not duplicate `package.json`, CI, or `AGENTS.md` content in `mpxconfig.json`.
- MPX does not keep legacy config readers after cutover.

## 5. Target monorepo

```text
mpx/
  MPX_MIGRATION.md
  AGENTS.md
  package.json
  pnpm-lock.yaml
  pnpm-workspace.yaml
  tsconfig.json

  apps/
    cli/                         # `mpx` executable

  packages/
    core/                        # errors, result envelopes, paths, process helpers
    config/                      # project/user config, discovery, provenance, doctor
    launch/                      # identity, modes, presets, grants, descriptors/keys
    executors/                   # required Docker projection and elevated host compatibility
    skills/                      # catalog, packs, exposure resolution, search, runtime manifests
    providers/                   # adapter registry and capability contracts
    provider-github/             # gh implementation
    provider-gitlab/             # glab implementation
    provider-gerrit/             # git/SSH implementation
    provider-kanbanflow/          # kf implementation
    ports/                       # lease arithmetic, state, probing, reconciliation
    worktrees/                   # create/remove/list/prepare lifecycle
    sessions/                    # session registry, unfinished queue, resume plans
    status/                      # provider-neutral status snapshot and formatting data
    windows/                     # Windows-native process, Terminal, shortcut, task adapters
    installer/                   # plan/apply/verify/uninstall and managed-block ownership

  runtimes/
    claude/
      plugin/                    # built Claude Code plugin implementation named `mpx`
      generated/                 # immutable scope-resolved plugin artifacts and skill manifest
      statusline/                # Claude renderer only
      installer/
    pi/
      extensions/                # Pi namespace, skill loader, hooks, footer, session events
      generated/                 # immutable scope-resolved skill/agent manifests
      agents/                    # generated; never hand-edited
      settings/
      installer/

  content/
    instructions/                # canonical global AGENTS/compaction/rules source
    skills/                      # canonical bare-name skills
    agents/                      # canonical agent intent/frontmatter source
    output-styles/

  scripts/
    build-runtime-artifacts.mjs
    validate-generated.mjs

  fixtures/
    configs/
    providers/
    repositories/
    worktrees/

  docs/
    CONFIG.md
    PROVIDERS.md
    PORTS.md
    WORKTREES.md
    SESSIONS.md
    INSTALLATION.md
    RUNTIME_ADAPTERS.md
    ROLLBACK.md
    history/
      PI_MIGRATION.md            # imported non-normative Pi implementation journal/provenance
```

### Package policy

- The monorepo root is private.
- Packages are private by default.
- Public packages require an explicit license, package `files` allowlist, clean generated artifact, and release test.
- Internal packages may use `@mpx/*` workspace names; public registry naming is decided only when publication is needed and namespace availability is verified.
- The Claude plugin is built as a directory artifact. Reusable logic never lives only inside the plugin.
- There is one Claude plugin implementation and identity. The builder may emit immutable scope-specific artifacts under that identity; those artifacts are disposable projections, never canonical sources.
- Pi consumes workspace package entry points or generated artifacts, never `C:/_MP_projects/...` imports.
- A future GUI consumes versioned library APIs, `mpx --json`, or a later event protocol; it does not own the MPX state database.

## 6. Language policy

### Default: TypeScript and portable Node ESM

Use TypeScript for package source and emit ESM. Use `.mjs` for dependency-free install/bootstrap scripts that run directly under Node. Move these domains away from Bash:

- Git/worktree inspection and lifecycle.
- Port allocation and probing.
- Config resolution.
- Session scanning and migration.
- CLI command dispatch.
- Table/JSON rendering.
- Cross-platform filesystem operations.

### PowerShell only for Windows-native operations

Retain focused PowerShell adapters where Node would merely wrap fragile platform commands:

- `Get-NetTCPConnection`, process/CIM inspection, and process termination.
- Windows Terminal profile/native launch integration.
- Scheduled Tasks.
- Shortcuts.
- Registry and ACL operations.
- Windows symlink creation where `cmd /c mklink` is required.
- Shell-profile installation if the PowerShell implementation remains the safest owner.

PowerShell adapters return structured JSON. Domain rules remain in TypeScript.

### Bash

Retire Bash domain implementations such as `wtr.sh`. Keep only minimal generated shell functions when a child process cannot affect its parent shell, for example selecting a path and then `cd`-ing in the caller. Those wrappers delegate all logic to `mpx`.

### Rust

Keep Rust in `kanbanflow-cli`. Add Rust to MPX only after measurement proves a need for native performance, distribution, or OS integration. Port allocation, Git subprocesses, config, and session state do not justify Rust initially.

## 7. CLI contract

```text
mpx init
mpx config show|resolve|explain|validate
mpx doctor

mpx identity list|show
mpx mode list|show
mpx skill-policy list|show
mpx preset list|show
mpx launch [claude|pi]

mpx provider list|explain|doctor
mpx auth status|login
mpx skill list|search|show|explain

mpx issue list|view|create|edit|comment|move|finish
mpx review view|create|update|ready
mpx ci status|watch|logs|retry

mpx package detect|install|run
mpx dev start|status|logs|restart|stop

mpx ports ensure|list|inspect|kill|release|reconcile
mpx worktree create|remove|list|select|prepare|status|reconcile

mpx session list|show|save|resume|mark|inbox|reconcile

mpx install plan|apply|verify|uninstall
mpx runtime claude|pi
```

Every automation-capable command supports `--json` with stdout reserved for one versioned envelope:

```json
{
  "apiVersion": 1,
  "ok": true,
  "data": {},
  "warnings": []
}
```

Errors use stable codes, capability names, retryability, and remediation. Provider-specific data appears only under a namespaced `providerData` field.

No skill parses human tables. No skill shells directly to `gh`, `glab`, `git push refs/for`, `kf`, package managers, or port scripts when an MPX capability exists.

## 8. `mpxconfig.json`

### Proposed schema

```json
{
  "$schema": "https://mpx.dev/schemas/mpxconfig.schema.json",
  "schemaVersion": 1,
  "project": {
    "id": "bitsafe/yoursafe-components"
  },
  "repository": {
    "provider": "gitlab",
    "remote": "origin"
  },
  "issues": {
    "provider": "kanbanflow",
    "boardId": "<board-id>",
    "boardName": "Team E",
    "states": {
      "todo": "<column-id>",
      "wip": "<column-id>",
      "review": "<column-id>",
      "done": "<column-id>",
      "archive": "<column-id>"
    }
  },
  "tooling": {
    "packageManager": "yarn"
  },
  "workflow": {
    "branch": {
      "base": "main",
      "template": "{author}/{issue}-{slug}"
    },
    "codeReview": {
      "openAsDraft": true,
      "markReady": "agent",
      "merge": "agent"
    }
  },
  "worktrees": {
    "postCreate": {
      "execution": "background",
      "steps": [
        {
          "id": "install",
          "uses": "package-install"
        },
        {
          "id": "prepare",
          "uses": "package-script",
          "script": "prepare:worktree",
          "dependsOn": ["install"]
        }
      ]
    }
  },
  "development": {
    "services": {
      "components": {
        "scope": "checkout",
        "port": {
          "mode": "managed",
          "preferred": 8100
        },
        "environmentVariable": "VITE_COMPONENTS_PORT",
        "protocol": "https",
        "start": {
          "type": "package-script",
          "script": "preview:components"
        }
      },
      "docs": {
        "scope": "checkout",
        "port": {
          "mode": "managed",
          "preferred": 8101
        },
        "environmentVariable": "VITE_DOCS_PORT",
        "protocol": "https",
        "start": {
          "type": "package-script",
          "script": "start:storybook"
        }
      }
    }
  }
}
```

### Property semantics

| Property | Meaning |
| --- | --- |
| `$schema` | Editor validation/completion metadata. |
| `schemaVersion` | Runtime parser and migration discriminator. Unknown versions fail closed. |
| `project.id` | Stable project identity used in diagnostics and state. Prefer forge namespace/repository. |
| `repository.provider` | `github`, `gitlab`, `gerrit`, or `generic`; selects repository/review/CI capabilities. |
| `repository.remote` | Git remote used for provider operations, normally `origin`. |
| `issues.provider` | Built-in v1 values: `github`, `gitlab`, `kanbanflow`, `local`, or `none`. Additional IDs such as `jira` or `linear` are valid only after a trusted adapter with an executable/API and credential contract is installed. |
| `issues.*` | Provider-specific, non-secret project binding selected through a strict schema union. Unregistered provider IDs fail before any operation. |
| `issues.states` | Canonical MPX issue-state to provider-native state/column ID mapping. |
| `tooling.packageManager` | `auto`, `pnpm`, `yarn`, `npm`, `bun`, or `none`. Explicit value overrides detection. |
| `workflow.branch.base` | Base used only when MPX creates a branch/worktree; may be omitted for remote HEAD detection. |
| `workflow.branch.template` | Optional naming template with constrained placeholders such as `{author}`, `{issue}`, and `{slug}`. |
| `workflow.codeReview` | Optional agent-workflow ceiling, not provider or executor selection. When omitted, the invoked skill and current user request govern. `human` forbids that autonomous transition; `agent` permits but does not require it. It is not a statement that every issue must create a review. |
| `worktrees.postCreate` | Preparation pipeline run after a requested worktree is created. |
| `development.services` | Stable service IDs, launch references, protocol, and port-allocation declarations. |
| `development.services.*.scope` | `checkout` gets a per-checkout lease; `project` is shared by all worktrees, suitable for one development database. |
| `development.services.*.port.mode` | `managed` is exclusive and allocated; `fixed-shared` is a transitional hard-coded port allowed to collide and reported by doctor. |
| `development.services.*.port.preferred` | Main-checkout port and allocation-family anchor. Optional when allocation comes from a user pool. |
| `development.services.*.port.family` | Optional explicit family ID overriding automatic numeric-contiguity grouping. |
| `environmentVariable` | Variable injected by `mpx dev` and available to assignment-aware project config. |
| `protocol` | `http`, `https`, or `tcp`; used for readiness and links. |
| `start` | Typed launcher reference, initially package scripts; never a shell string. |

Use JSON Schema with `additionalProperties: false`. Defaults are applied by resolver code, not assumed from validator mutation.

### Deliberately absent

- No `profile` in the committed project file.
- No `ai` allowlist.
- No VCS property; Git is fixed scope.
- No CLI executable names.
- No credentials or credential references.
- No current worktree paths or worktree list.
- No worktree strategy constraint.
- No copied-local-path list; `.worktreeinclude` owns it.
- No actual assigned ports.
- No arbitrary command interpolation.

## 9. User config, content scopes, skill loading, and provider registry

User-local configuration adds `launchDefaults.scopes` and `launchDefaults.projects`, each mapping an explicitly selected identity to a named preset. A preset contains mode, skill policy, content scope, executor, workspace strategy, and network policy. Identity remains supplied by `cc`/`ccw`/`pi`/`piw` or an explicit launch argument; CWD never silently selects it. Grants, unrestricted host execution, extra writable mounts, and credential expansion require a separate confirmed launch choice; neither a committed project nor an agent can introduce them. The resolver emits each selected value and its source so `mpx launch explain` can explain a one-word launcher without hiding a permission decision.

User config lives under the platform user config root. Section 2A defines its launch/identity shape and is normative. Committed `mpxconfig.json` contains no identity, mode, preset, connection, credential, machine root, or exposure preference. Content scopes may compose packs/exposure only; they neither select identity nor authorize paths. Canonical path classification uses real paths, Windows case-insensitive segment comparison, and longest-root matching; unknown CWD fails closed.

Pack membership and four-state exposure are independent. Precedence remains user-local project override/default, content-scope override/default, canonical default, then `name-only`. Canonical metadata accepts `full`, `name-only`, `explicit-only`, and `off`. Resolved manifests contain identity, packs, provenance/hash/path, exposure and human/model permissions, but no body. Project `.agents/skills` stay outside `/mpx:*` and retain their deliberately smaller native `full`/`explicit-only` contract.

Human and model search are separate as specified in Section 2A. Runtime model search requires the launch-bound artifact key and reveals only `full`/`name-only`; actual slash parsing remains the route for `explicit-only`. Both runtimes consume the same deterministic manifest and validator.

Provider mapping remains GitHub→`gh`, GitLab→`glab`, Gerrit→Git+SSH, KanbanFlow→`kf`, and local issues→filesystem adapter. Identity owns provider/SSH routes; project configuration selects capabilities/bindings only. Native auth stores remain authoritative, and probes/output are redacted.

## 10. Port system

### Static declaration versus runtime state

- `mpxconfig.json` declares service identity, scope, preferred port, environment variable, protocol, and launcher.
- `.worktree-ports.json` is a gitignored materialized projection of the registry lease for the current checkout.
- The machine-wide MPX state database is the authoritative owner of all managed leases.
- `mpx ports resolve` validates lease ID, repository/worktree identity, config hash, and assigned map before returning ports. A missing or mismatched registry record fails closed; it never silently trusts a copied or edited local file.
- Status lines call the shared resolver and cache its validated snapshot; they never consult a project-name map and never allocate.
- Project launchers receive validated ports through `mpx dev` environment injection. Direct package commands must accept explicit environment overrides, but they are not allowed to claim MPX lease validity from raw file contents.
- A future GUI reads versioned MPX APIs/state snapshots, not private implementation tables.

### Main checkout invariant

For every `managed` service:

- Main checkout is slot zero and owns the project’s primary reservation.
- A checkout-scoped service gives linked worktrees shifted leases.
- A project-scoped service is reserved once by main at its exact preferred port; every linked worktree resolves and materializes that same project lease rather than allocating another one.
- `mpx init` or initial project registration reserves main ports and writes main `.worktree-ports.json`.
- `mpx doctor` fails if a managed main/project reservation is missing or differs from config.
- A port is **reserved** even when no process is listening.

Managed project defaults should be unique on the machine. `mpx init` checks existing reservations and asks for a different preferred range when a conflict exists.

Some existing projects have unavoidable hard-coded defaults and may intentionally share them during transition. Model these as `fixed-shared`: the registry records claims but does not promise exclusivity, worktree shifting, or concurrent startup. Doctor reports the limitation until the project becomes assignment-aware.

### Port families and slot arithmetic

Partition preferred ports into allocation families:

- By default, each maximal numerically contiguous sequence is one family.
- Distant ports are singleton families.
- An explicit family identifier is part of the schema from the first release and may override auto-grouping when adjacency is accidental. Non-contiguous services normally remain singleton families.
- Family width is `maxPreferred - minPreferred + 1`.
- Every checkout uses one shared slot `k` across all of its families. Assignment is `preferred + k × familyWidth` for each family.
- The allocator validates and reserves the checkout’s complete multi-family port map atomically. A conflict in any family rejects that slot and advances every family together; it never shifts only one service.

Examples:

```text
Preferred components/docs: 8100, 8101
main slot 0:              8100, 8101
worktree slot 1:          8102, 8103
worktree slot 2:          8104, 8105

Preferred app/storybook:  5173, 6006
main slot 0:              5173, 6006
worktree slot 1:          5174, 6007
worktree slot 2:          5175, 6008
```

The complete checkout assignment is reserved atomically. If any family candidate conflicts with another exclusive lease, an OS listener, a reserved/privileged range, another family in the same map, or the port ceiling, the allocator advances the shared checkout slot and recomputes the complete map.

### Global registry

Use an MPX-owned state database under `%LOCALAPPDATA%/mpx/`. It records:

- Canonical repository identity and common Git directory.
- Worktree identity, current path, branch, and Git administrative path.
- Main/linked role and stable slot.
- Config hash and service/family definitions.
- Lease IDs and assigned maps.
- Exclusive versus shared claims.
- Last reconciliation and liveness observations.

Requirements:

- Atomic transactions or an inter-process lock.
- Concurrent allocator safety.
- Crash recovery.
- Reconciliation against `git worktree list --porcelain` and filesystem existence.
- OS bind probes before committing new leases.
- Explicit conflict state when an external process later occupies a reserved port.
- Database rebuild from known roots and local lease files.
- No requirement that a GUI process is running.

### `.worktree-ports.json`

Use a versioned shape rather than an unstructured number map:

```json
{
  "schemaVersion": 1,
  "leaseId": "<opaque-id>",
  "projectId": "bitsafe/yoursafe-components",
  "worktreeId": "<opaque-git-worktree-id>",
  "configHash": "<opaque-hash>",
  "services": {
    "components": 8102,
    "docs": 8103
  }
}
```

This file is not an independent authority. Consumers call `mpx ports resolve --cwd ...`, which checks it against the registry. Framework configuration consumes environment variables injected by `mpx dev`; direct framework commands must accept equivalent explicit environment overrides.

## 11. Project port-enablement

### `yoursafe-components`

Implement on the target branch without merging unrelated feature-worktree commits:

- Components preview reads assigned Components port.
- Storybook launcher reads assigned Docs port.
- Storybook asset URL reads assigned Components port.
- Playwright base URL reads assigned Docs port.
- Built preview config reads assignments.
- Strict port binding remains enabled.
- `.worktreeinclude` carries approved local certificates and `.env*.local` files.
- `yarn start` does not require a prior `yarn build:yoursafe`; its watcher performs an initial build.
- An independently started `preview:components` requires `build:yoursafe` first.
- One shared development database is sufficient.

Acceptance scenario: main uses `8100/8101`, first worktree `8102/8103`, later worktree `8104/8105`; an additional test may force a skipped/conflicting slot.

### `meeplog`

Extend its existing `.worktree-ports.json` reader from Vitest to:

- App Vite dev.
- Preview and Playwright.
- Storybook.
- Worker API and `PUBLIC_API_URL`.
- Existing worker `/health` readiness.

### `prejemesi`

Make these assignment-aware:

- Vite dev and strict port.
- Wrangler preview.
- Storybook.
- Playwright and base URL.
- Vitest browser API ports.
- `ORIGIN`, Better Auth trusted origins, generated links, load-test target, and relevant CORS helpers.

Keep PostgreSQL project-scoped/shared across worktrees. Parameterize it only if it conflicts with another project; do not create one database per worktree.

### Grovekeeper

Treat Grovekeeper only as a normal validation project and architecture reference:

- Couple assigned Vite port to Tauri `devUrl`.
- Parameterize HMR, Playwright preview, and Storybook.
- Do not import Grovekeeper code into MPX.
- Do not use Grovekeeper’s database or process lifecycle as MPX authority.

### `template-sveltekit`

Make generated projects assignment-aware by default:

- Vite dev accepts the MPX assignment and uses strict port behavior.
- Wrangler preview accepts its assignment.
- Storybook accepts its assignment.
- Playwright web server and base URL use the same assigned preview port.
- Auth/public `ORIGIN` follows the app assignment.
- Static `ports`/`ports:kill` package scripts are removed in favor of `mpx ports`.
- Template includes `mpxconfig.json` and an appropriate `.worktreeinclude` policy.
- The Svelte setup skill runs `mpx doctor` after cloning.

React Native template changes are explicitly deferred.

## 12. Worktree lifecycle

### Creation

```text
preflight
  → resolve/validate main repository and mpxconfig
  → validate branch/name and paths
  → acquire repository + machine lease locks
  → resolve base
  → create standard sibling worktree
  → copy .worktreeinclude matches
  → allocate/write ports
  → atomically write worktree lifecycle state
  → start tracked post-create worker
  → return worktree path
```

Do not open VS Code, another editor, or a terminal automatically.

The CLI prints a machine-readable path. A minimal shell function may `cd` in its parent shell; all selection and lifecycle logic remains Node-based.

### `.worktreeinclude`

- Retain it as a separate project-root file.
- Use Git-ignore pattern semantics.
- Copy only ignored/untracked matches; never overwrite tracked files.
- Enforce source/target containment and safe symlink handling.
- Project trust is required because it may copy local secrets.
- Pi and shell-created worktrees use the MPX implementation; no runtime-native support is assumed.

### Post-create preparation

`worktrees.postCreate.execution`:

- `foreground`: creation waits for the preparation pipeline.
- `background`: creation returns after spawning a tracked worker; the worker executes finite steps sequentially.
- `none`: no preparation.

Supported step forms initially:

- `package-install`
- `package-script`
- explicit argv executable after separate trust

Each step has an ID, dependencies, required/optional behavior, timeout, working directory, environment allowlist, and redacted log policy.

Package installation and package scripts are arbitrary repository code because install hooks and script bodies can execute anything. Approval is stored against the repository identity, exact commit/config hash, and digests of relevant package manifests, lockfiles, and resolved script bodies. Any change invalidates approval before another automated preparation run. Explicit argv executables require a separate approval even when package automation is trusted.

The worktree state records:

- Creation identity and config hash.
- Assigned ports.
- Pipeline and step states.
- Worker PID/process fingerprint.
- Start/end timestamps.
- Exit code and bounded output tail.
- Log path.
- `preparing`, `ready`, `failed`, `cancelled`, or `unknown` state.

Do not start long-lived dev servers as post-create preparation. `mpx dev start` owns those processes. A finite install/generate/build pipeline may itself run in a background worker.

### Failure and removal

- Preserve a failed worktree with diagnostics rather than silently deleting it.
- Roll back a lease reservation if Git creation never succeeds.
- Stop only processes MPX started and identified by PID plus process fingerprint.
- Do not force-remove dirty or locked worktrees by default.
- Release registry state only after successful removal or explicit orphan resolution.
- Reconcile external/Fork deletions without discarding useful failure history.

## 13. Issue, review, and CI abstraction

Canonical issue capabilities:

- `issue.list`
- `issue.view`
- `issue.create`
- `issue.edit`
- `issue.comment`
- `issue.label`
- `issue.move`
- `issue.finish`

Canonical review capabilities:

- `review.view`
- `review.create`
- `review.update`
- `review.comment`
- `review.ready`
- `review.merge`

Canonical CI capabilities:

- `ci.status`
- `ci.watch`
- `ci.logs`
- `ci.retry`

A provider declares granular capabilities and auth probes. Skills handle `CAPABILITY_UNSUPPORTED`; they do not improvise direct provider commands. Git commit and push remain available in clone mode through the identity's routed Git/SSH credentials; review capabilities cover provider-side PR/MR actions.

The repository provider normally owns code review and CI. `workflow.codeReview` is optional and controls a behavioral ceiling such as draft/human-ready/human-merge; it does not select a second provider. MPX launch or sandbox policy does not introduce a separate global ban. A shipping skill may push, create or update a review, watch CI, and merge when the project ceiling and provider identity permit it.

KanbanFlow board columns map to canonical issue states. Generic MPX skills replace provider-specific KanbanFlow workflow skills where semantics are equivalent. Keep only genuinely KanbanFlow-specific capabilities, such as attachment behavior, inside the adapter or separate `kf` CLI.

### Local Markdown issue provider

`issues.provider: local` is a first-class alternative to GitHub, GitLab, or KanbanFlow. A project selects one authoritative Issue provider. Local issues use an independent project-local, monotonically increasing positive-number namespace; IDs are never reused or renumbered and do not preserve a hosted provider's sequence. Switching or round-tripping to a hosted provider is not a requirement.

The provider stores one human-editable Markdown file per refined issue under a configurable project Issue root. The root may be a normal filesystem folder, a dedicated folder inside an Obsidian vault, or a folder used by an existing task plugin, but the provider depends on no plugin or dashboard. A committed path must be project-relative; an external root is selected through an identity-owned logical store so no absolute vault path enters `mpxconfig.json`. `Boards/<project>.md` is optional fast capture, not the Issue store. If board promotion is enabled, MPX creates exactly one issue, confirms it, then archives the capture with the issue link; it never keeps a second active issue copy on the board.

Each file is named `<zero-padded-id>-<slug>.md`. Versioned YAML frontmatter owns `schemaVersion`, numeric `id`, canonical project ID, `title`, local `state`, `kind`, `priority`, labels, assignees, `createdAt`, `updatedAt`, optional `finishedAt`, optional plan/effort membership, optional capture source, and canonical outbound `parent`, `blockedBy`, and `related` IDs. `children` and `blocks` are derived. The ready frontier is derived from unresolved blockers instead of stored separately. Local states cover draft, ready, claimed, blocked, and finished while the provider-neutral API derives open or finished. Kinds cover bug, enhancement, task, implementation, research, decision, prototype, and grilling. AFK, HITL, size, area, and design-needed remain semantic labels rather than hard-coded workflow fields.

The readable body uses `Outcome`, optional `Current behavior`, `Desired behavior`, `Requirements`, independently verifiable `Acceptance criteria`, `Out of scope`, and `Notes or decision record`. Following Matt Pocock's local-ticket patterns, implementation issues are narrow end-to-end vertical slices; large mechanical refactors may use expand, migrate, and contract tickets. Criteria describe durable behavior rather than implementation steps, file paths, or line numbers. A question becomes an issue once it can be stated precisely even when its answer is still unknown. Plan or effort maps contain only destination, linked issue IDs with one-line gists, not-yet-specified work, and out-of-scope boundaries; decisions stay in each issue rather than being duplicated in the map.

Unknown frontmatter and body sections survive edits. Allocation and mutation use a store lock, content-hash compare-and-swap, same-directory temporary file, and atomic replacement; duplicates, broken relationships, external edits, and synchronization conflicts fail visibly. `list`, `view`, `create`, `edit`, `label`, `move`, and `finish` are required capabilities; comments are enabled only when authorship and time can be represented faithfully. Markdown files, CLI table/JSON output, optional Obsidian views, and a future GUI share the same authority. SQLite may be a disposable rebuildable index for search and sorting, never the Issue authority or a second editable projection.

## 14. Claude and Pi runtime architecture

### Canonical content and catalog

- One instructions source.
- One bare-name skill source.
- One canonical agent intent source.
- Provider-neutral scripts call `mpx`.
- Each canonical skill owns its full description and trigger text and declares only MPX catalog metadata such as skill-pack membership and default exposure under `metadata.mpx`.
- Canonical skills do not use `disable-model-invocation` as a context-budget mechanism. The resolved exposure is the source of truth, and runtime builders generate the corresponding runtime field.
- No canonical content contains `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_SKILL_DIR}`, absolute `C:/_MP_projects` paths, Claude-only tool names, or Pi-only model IDs unless the file is explicitly runtime-specific.
- `@mpx/skills` resolves scope, project identity, packs, exposure, provenance, and collisions into one stable sorted manifest. Skill bodies remain at their canonical locations and are read only on invocation.
- The artifact key covers runtime, resolved scope, canonical project ID when present, canonical metadata/content hash, effective pack/exposure config hash, and runtime mapping version. Builders publish atomically and reuse an identical immutable artifact.
- A runtime session is bound to that resolved scope/project artifact at process launch. Moving within the same repository or its worktrees preserves the binding; changing to a different project or scope requires a runtime restart so initial context and command availability cannot become stale mid-session.
- User-config or canonical-content changes produce a different artifact key. Runtime launchers rebuild or select the new artifact before starting; `mpx doctor` reports sessions or installed launch targets that reference an obsolete key.

### Standard agent roles and routing

The interactive main agent is the orchestrator and evaluator, not a spawnable worker. It owns intent, decomposition, user decisions, role selection, integration, acceptance, and verification of subagent claims against actual changes.

| Work shape | Canonical role |
| --- | --- |
| Broad codebase location or tracing | `Explore`, read-only, with explicit breadth |
| Open-ended research, design, or issue analysis | `general-purpose`, `Plan`, or `mpx-issue-analyzer` with an explicit model class |
| Pre-analysed bounded implementation | `mpx-executor` |
| Behavior suited to red-green-refactor | `mpx-tdd-executor` |
| Known verification commands | `mpx-checker` |
| Concrete failed checks requiring fix and recheck | `mpx-check-fixer` |
| Acceptance and risk review | relevant read-only `mpx-reviewer-*` specialists in parallel |
| Docs, browser evidence, or UI alternatives | Context7, Chrome DevTools, or UI-variant specialist |
| Commit, review, CI, or unresolved handoff | dedicated delivery or tracking agent |

Routing is deterministic: broad searches go to `Explore`; TDD is used when behavior can be expressed as a failing test; other implementation is analysed before a bounded executor receives it; executors never approve their own output; reviewers remain read-only; fixing starts from concrete checker or reviewer evidence. Generated runtime definitions preserve each role's tools, model, and thinking and cannot widen the parent launch tuple.

User questions are plain inline text, not structured question-tool calls. Group independent, non-blocking decisions into concise numbered batches, separate true blockers, and state a recommendation for every decision. The structured ask-user integration is retired from the installed model tool surface.

### Claude Code

- Build one plugin implementation and plugin identity named `mpx`.
- Every public skill invokes as `/mpx:<bare-name>`; a bare alias supplied by Claude Code is convenience only and not part of the MPX contract.
- Build an immutable scope-resolved plugin artifact rather than merging separately maintained `mp`, `mp-gh`, personal, or KanbanFlow plugin trees.
- Map exposure into generated skill frontmatter: `full` preserves canonical description and trigger text; `name-only` emits minimal identity metadata with model invocation enabled; `explicit-only` emits no initial discovery metadata and disables model invocation; `off` omits the skill.
- Claude's settings-side `skillOverrides` is not the MPX mechanism because Claude does not apply it to plugin skills. MPX performs the equivalent projection from the shared resolved manifest.
- Skill bodies load only through an authorized model invocation or an actual slash command. Merely mentioning `/mpx:<name>` in prose is not command expansion, but `name-only` keeps the identity available for model resolution.
- Expose one compact skill-search capability backed by `mpx skill search --json --artifact-key <launch-bound-key>`. It returns only bounded model-invocable matches from that immutable manifest and does not become a second skill-body loader.
- Rewrite or retire `mp-gh` skills; provider selection is configuration/adapter driven rather than a second plugin.
- Keep status line, account launch configuration, and user settings in the Claude runtime/installer because they are not all plugin-packagable.
- `mpx runtime claude` resolves the launch CWD and optional launch-only content selector, builds/selects the exact artifact key, and passes only that artifact's plugin directory to Claude. Account launchers delegate to this command instead of selecting plugin paths independently.
- Build and validate every scope/project-resolved plugin artifact before installation or launch.

### Pi

- Register user-invocable `/mpx:<bare-name>` extension commands from the same resolved manifest for every `full`, `name-only`, or `explicit-only` skill; do not register `off` or pack-excluded skills.
- Add one model tool that loads a canonical skill body on demand. Its allowlist contains only `full` and `name-only`; it rejects `explicit-only`, `off`, excluded, ambiguous, or stale-manifest requests.
- Add only stable sorted discovery metadata to initial model context: name plus description/triggers for `full`, name only for `name-only`, and nothing for `explicit-only` or `off`.
- Explicit slash handlers and the model loader use one expansion path, one provenance wrapper, and the launch-bound project/content-scope manifest. Pi-specific adaptation happens in the runtime adapter rather than canonical content.
- `mpx runtime pi` resolves the launch CWD and optional launch-only `--content-scope`, supplies the exact artifact key to Pi, and the Pi adapter verifies it at session start and reload. A cross-project/content-scope CWD change produces a restart-required diagnostic rather than silently changing exposure.
- Expose the same launch-bound, artifact-key-validated skill-search contract as Claude. Search results include only currently model-invocable skills and never bypass loader policy.
- Do not register canonical MPX skills as native Pi resources: that would create `/skill:*` aliases, duplicate discovery metadata, and bypass the namespace adapter's policy.
- Generate Pi agent metadata/tool mappings from canonical agents.
- Keep Pi provider/model/thinking settings runtime-specific. Claude-only skill fields that Pi cannot reproduce produce compatibility diagnostics; they are never silently claimed as equivalent.
- Preserve real per-account `auth.json`, sessions, trust, and caches outside Git. The personal and work Pi roots must be authenticated to separate designated ChatGPT accounts and must never share or copy this native state.
- Replace every absolute import from `mpx-claude-code` with workspace package or artifact resolution.
- Make Pi footer consume the same status snapshot and current-worktree port resolver as Claude.

### Shared runtime observability and status presentation

Evolve the Phase C status snapshot into a provider-neutral runtime-observability contract. Shared packages own normalized data and derivation; the Claude status-line and Pi footer own only harness event capture, terminal layout, color, width, and supported interactive actions. One harness must not be reduced to the other's lowest common denominator: shared fields use the same meaning, while genuinely harness-only fields remain typed optional additions in that renderer.

Define a versioned `RuntimeStatusEnvelopeV1` that composes the validated project/worktree/service data from `StatusSnapshotV1`. It contains runtime, launch identity reference, capture time, a schema-validated adapter capability map, and typed field groups for identity, session, model, location/actions, Git/worktree, token/context usage, cost, provider quota, compaction, subagents, and development services/ports. Every field group carries `state` (`current`, `stale`, `unavailable`, or `error`), `source` (`native`, `provider`, `derived`, or `cache`), capture/freshness metadata, and a stable diagnostic code when no current value exists. Unknown envelope versions fail closed. Values use explicit units/currencies/time zones, and estimated cost is structurally distinct from provider-reported cost.

Each immutable runtime projection declares its capability map. A renderer may omit a shared field only when the adapter declares it unsupported with a stable reason; transient failures render `stale` or `error`, not unsupported. Harness-only additions live under validated `claude` or `pi` namespaces and cannot redefine shared fields. Shared snapshot/envelope fixtures, capability snapshots, and renderer tests enforce these rules.

The following are required in both harnesses whenever the native API or a safe MPX-owned adapter can supply them:

- visible `personal` or `work` identity without exposing an account identifier, token, or native auth path;
- session title and runtime-qualified session ID, with an unambiguous shortened display and full inspectable value;
- provider/model and effective effort or thinking level;
- current folder, canonical repository, main checkout or linked worktree, branch, and dirty/ahead/behind state where available;
- safe OSC-8 or equivalent actions for the current folder, terminal, and VS Code target, with escaped/validated paths and a plain-text fallback;
- current context/token consumption, context-window percentage, input/output/cache totals where available, estimated and provider-reported price kept distinct, and an explicit `unavailable` state rather than fabricated cost;
- account usage/quota windows, remaining allowance, reset time, throttling, and stale/error state without reading or logging raw credentials;
- compaction count, last reason/time, and current post-compaction context state;
- active, queued, background, completed, and failed subagent counts plus compact progress/fleet state;
- current-worktree development ports and listener health; and
- freshness/provenance so cached, inferred, provider-reported, and native values cannot be confused.

Retain additional useful runtime-specific fields such as Claude review/CI links or Pi extension/provider state when there is no honest cross-harness equivalent. Missing native APIs require a documented capability finding and the narrowest safe adapter; a field may be absent from one renderer only when neither native data nor a secure derivation exists. Usage polling must be bounded, asynchronous, cached, and non-blocking. Status adapters never parse or copy raw credential stores when a native command/API can provide the value, and status logs/snapshots exclude prompts, secrets, account identifiers, and unnecessary absolute paths.

Acceptance uses fixture and live-session matrices for personal/work Claude and personal/work Pi, narrow/wide terminals, repositories and worktrees with spaces, unavailable/stale usage services, pre/post compaction, and foreground/background subagents. Semantic parity is tested at the shared snapshot; renderer snapshots may differ only for declared harness capabilities and layout.

## 15. Sessions and unfinished-work inbox

Replace snapshot-only resurrection with a provider-neutral session domain.

Session identity includes runtime plus native session ID. Track:

- Runtime, identity, selected native account root, immutable launch tuple/hash and `launchKey`.
- Session ID/file reference.
- CWD, canonical repository, and worktree.
- Title/model/reasoning where available.
- Process fingerprint and activity timestamps.
- Status: `active`, `paused`, `unfinished`, `needs-review`, `completed`, `abandoned`, `unknown`.
- Optional next action, note, related issue/review, and user priority.
- Resume plan and last verification.

Commands:

```text
mpx session list
mpx session mark <id> unfinished --note ... --next-action ...
mpx session handoff <id> --summary ... --next-action ...
mpx session complete <id> --disposition completed|abandoned
mpx session inbox
mpx session resume <id>
mpx session branch <id> --files shared|worktree [--terminal-tab]
mpx session save
mpx session reconcile
```

`handoff`, pause-on-exit metadata capture, and inbox mutation are deterministic no-model operations. A generated summary is a separate explicit action and never runs merely because a terminal closes. Resume and branch links show runtime, identity, project, worktree, and file mode before launch.

Claude/Pi lifecycle adapters update state. Native branching uses Pi `/clone`, `/fork`, CLI `--fork`, or the supported in-process fork API, and Claude `/branch` or `--resume <id> --fork-session`; MPX adds lineage, account-root validation, file-workspace selection, and safe terminal launch rather than reimplementing transcripts. A Pi session is discoverable, resumable, and branchable only within its recorded personal or work native root and designated ChatGPT account. MPX never searches the opposite root as a fallback and fails closed when the recorded root is missing, mismatched, or authenticated to the wrong account. A future GUI or optional Obsidian projection may display and mutate this through stable contracts, but MPX remains fully usable without either.

Existing `agent-resurrect` saves and Pi active-session records receive a one-time, non-destructive import command. The new runtime does not continuously read legacy stores.

## 16. Migration and coexistence strategy

### Core rule

Keep old repositories, installations, and data untouched while building and verifying the new system. Do not activate old and new hook/plugin stacks simultaneously in the same session unless a specific coexistence test requires it.

`mpx-claude-code` and `mpx-pi` remain active migration sources until final convergence. Migration defaults to preserving current behavior, not preserving provider-specific implementation. Every maintained skill, agent, extension, hook, script, rule, instruction, reference, template, theme, keybinding, package integration, status feature, and account workflow receives one recorded disposition:

- **canonicalized:** generalized into a provider-neutral MPX package or content workflow;
- **Claude-specific:** retained in the immutable Claude projection because the capability is genuinely Claude-only;
- **Pi-specific:** retained in the immutable Pi projection because the capability is genuinely Pi-only;
- **externalized:** version-pinned and wrapped behind an MPX contract, with provenance, license, capability, and credential review;
- **retired:** removed only with an explicit rationale showing that it is obsolete, redundant after an equivalent replacement, unsafe, or impossible on the target harness.

Unclassified omission is a migration failure. Canonicalization is the default. Every `Claude-specific`, `Pi-specific`, `externalized`, or `retired` disposition is an exception that requires a documented capability reason showing why canonicalization is unsuitable, independent review, and enumeration in the final parity report. A provider-specific skill may be rewritten, merged, or renamed, but its triggers, decision points, safety gates, provider actions, review/CI behavior, and handoff semantics must remain testable through the canonical workflow.

Because both source repositories may continue changing during implementation, record source commit IDs, dirty-state file hashes, package versions, and the disposition map at the convergence baseline. Re-run the same inventory immediately before cutover, reconcile every added, changed, deleted, or renamed source, regenerate projections, and block retirement while any drift is unexplained.

### Source history

1. Clean and commit or intentionally archive outstanding changes in every source repository.
2. Record source commit IDs and remotes.
3. Import histories into destination subdirectories using a history-preserving method such as `git filter-repo` plus merge, or `git subtree` where appropriate. For each consumed repository, preserve every commit reachable from its default branch and release tags; record and archive any remaining refs rather than selecting history ad hoc. For `mpx-pi`, import every maintained runtime/config source plus licenses/vendor records, and retain `PI_MIGRATION.md` only as a non-normative historical journal under `docs/history/`.
4. Tag imported boundaries.
5. Keep old remotes read-only until final cutover.
6. Rename/archive GitHub repositories only after destination history and release/install paths validate.

### No permanent legacy readers

- Do not make `mpx init` import `.worktree-hub.json` or `.mpx/kanbanflow.json`.
- Do not make status lines read `statusline-projects.json`.
- Do not make new CLI commands read old port/worktree/session config during normal operation.
- One-time migration commands may import session saves or machine preferences into new state.
- Project manifests are authored deliberately for the target schema.

### Rollback

Before each install mutation, snapshot:

- Repository commits/remotes/paths.
- Shell profiles and managed blocks.
- Claude account config and plugin registrations.
- Pi symlink map and settings links.
- Windows Terminal settings and icons.
- Scheduled tasks.
- Raycast deployment artifacts/quicklinks.
- Obsidian paths and links.
- Session saves/registries.
- Port config and worktree MRU.
- User MPX config/state database.

Each migration phase documents an inverse operation and proves it before retiring the old component.

## 17. Machine integration and rename checklist

The existing system has path/name references in these surfaces and all must be handled:

### Shell and PATH

- `~/.bashrc` sources old worktree shell functions and contains absolute Claude/Pi/ports/worktrees launch paths.
- PowerShell profile contains installer-managed blocks.
- Existing functions/aliases include Claude account launchers, `ports`, `pk`, `wtr`, worktree helpers, and project shortcuts.
- PATH includes Pi agent bins.

Target:

- One marker-owned MPX install block per shell.
- `mpx` resolves from one installed bin location.
- Minimal shell helper only where parent-shell `cd` is required.
- Old marker blocks remain until `mpx install verify` passes, then are removed by their existing uninstallers or a verified migration plan.

### Claude

- Personal and work account config roots.
- Live `--plugin-dir` launch paths.
- Plugin marketplace IDs, enabled MCP/LSP/browser integrations, and caches.
- Global instructions, language/project rules, settings, output style, hook wiring, status-line/action assets, notifications, templates, and personal/local skills.
- Historical project/session path keys and usage/subagent transcript adapters.
- Current Claude-managed worktrees.

Validate both accounts separately and preserve native credential/history directories.

### Pi

- `~/.pi/agent` and `~/.pi/agent-work` entry-by-entry symlinks and account setup behavior.
- Settings, packages, extensions, agents/subagents, prompts, themes, keybindings, selected skills, and appended instructions.
- MCP/web/question/tool-display integrations and their private configuration boundaries.
- Native auth/models/sessions/trust/package state/caches left real and isolated per account.
- Themed launcher, terminal canvas/progress, footer, title, compaction, and notification behavior.
- Generated agent and immutable projection drift checks.

### Windows Terminal

Current profiles include old repositories such as `mpx-claude-code`, `mpx-pi`, `mpx-ports`, and `mpx-worktrees`. Consolidate into an `mpx` profile only after launch validation. Update starting directories, icons, and any callers using profile names.

### Raycast

Update generated/deployed quicklinks for:

- Repository URLs.
- Project folder/editor targets.
- Terminal profile names.
- Obsidian dashboard URIs.
- Ports/worktrees/session commands.

Re-run the Raycast generation/import process and validate every resulting action, not only source text.

### Obsidian

Update project dashboards and issue references under the MPX project area and mini-project boards only where they remain useful. Decide whether to rename the `MpxClaudeCode` project folder to `Mpx`; update inbound links, dashboard queries, URI targets, and board metadata atomically. Do not read or rewrite unrelated private notes.

The local Issue provider is plugin-independent. Its root may be inside or outside Obsidian, and it does not inject issues into the existing Tasks dashboard. Optional board promotion and Obsidian issue/session views are rebuildable adapters over the canonical Markdown store, not additional authorities.

### Scheduled Tasks, shortcuts, and session data

- Detect and migrate the agent-resurrect autosave task if installed.
- Verify task command, working directory, account, trigger, last result, and manual run.
- Detect Desktop/Start Menu shortcuts and regenerate only those owned by the old installer.
- Preserve save files until imported and verified.
- Keep old saves read-only through rollback.

### Environment variables

Update bootstrap variables such as `MPX_SKILLS_DIR` only after the new path exists. Continue resolving machine roots from the existing `MPX_*` variables. Add new variables only when they bootstrap user-local config; do not mirror project configuration into environment variables.

## 18. Phased execution

### Completed phases — compact regression summary

Implementation detail and review history stay in the package documentation, ADRs, Git history, and [`docs/PHASE_F_ACCEPTANCE.md`](docs/PHASE_F_ACCEPTANCE.md). The accepted contracts remain regression obligations for every pending phase.

| Phase | Delivered boundary | Regression contract retained |
| --- | --- | --- |
| A | Reproducible monorepo baseline, source/integration inventory, safety audit, and rollback evidence. | Destination and snapshots remain reproducible and secret-free. |
| B | Versioned config, provider/result envelopes, canonical skill catalog, pack/exposure resolution, provenance, bounded search, and read-only CLI foundations. | Deterministic schema/manifest resolution, collision and malicious-input rejection, and no secrets in resolved output. |
| B2 | Immutable launch tuple/key, identity/mode/preset/grant/routes, four exposure states, launch defaults, alias fast paths, and fail-closed selection. | Explicit/project/scope/built-in precedence, identity-domain checks, route safety, audit behavior, and four-state provenance/hash/path fixtures. |
| C | Global port leases, main/worktree allocation, reconciliation, Windows inspection, CLI operations, and the initial provider-neutral status snapshot. | Arithmetic, exclusivity, fixed-shared warnings, concurrency, crash recovery, and snapshot conformance. |
| D | Safe Windows-capable worktree create/prepare/remove/reconcile lifecycle with durable continuation and thin shell integration. | Paths with spaces, dirty/locked state, failure, cancellation, preparation, and removal safety. |
| E | Trusted provider registry, GitHub/GitLab/KanbanFlow adapters, provider-neutral Issue/Review/CI contracts, CLI operations, and generalized delivery skills. | Backend conformance and structured unsupported/error behavior. |
| F | Immutable Claude/Pi projections, launch-bound four-state skill loading/search, generated agents, runtime launch and host approval, gated Docker resolution, shared dangerous-command policy, basic hooks/status ports, audits, and selected source provenance. | Cross-runtime exposure and lazy-loading behavior, artifact integrity, alias resolution, canonical-skill equivalence, and validated current-worktree ports. |

The **completed regression suite** is the retained executable evidence for every row: `pnpm run build`, `pnpm run check`, `pnpm run typecheck`, `pnpm test`, `pnpm run validate:generated`, source verification where provenance inputs are available, and `git diff --check`. The behavioral obligations in the table are normative even if test files move; [`docs/CONFIG.md`](docs/CONFIG.md), [`docs/LAUNCH.md`](docs/LAUNCH.md), [`docs/PORTS.md`](docs/PORTS.md), [`docs/WORKTREES.md`](docs/WORKTREES.md), [`docs/PROVIDERS.md`](docs/PROVIDERS.md), and [`docs/RUNTIME_ADAPTERS.md`](docs/RUNTIME_ADAPTERS.md) map them to current package contracts.

Phase F accepted a deliberately reduced runtime slice. It did **not** establish complete parity with the live `mpx-claude-code` and `mpx-pi` setups: the Pi extensions tree was excluded, vendored subagents remained inactive, several Claude hooks/rules/local skills were not migrated, and rich status, MCP/web/question tools, managed development servers, sessions, installation, and F2 isolation remained outside that gate. Phase F1 closes this planning and implementation gap without reopening the accepted Phase F contracts.

### Phase F1 — Source convergence and Claude/Pi capability parity

Treat the current maintained source trees, including dirty and untracked work, as active migration inputs rather than relying only on the earlier provenance selection.

- Build a machine-readable convergence manifest by traversing both source repository roots, not a hand-selected directory list. Classify every tracked, dirty, and untracked path except `.git`, generated caches/build output, dependency stores, native private account state, and known accidental filesystem artifacts; every exclusion still receives a reason. Coverage includes root and nested settings, package/lock/workspace manifests, marketplace/editor/CI/installer/environment configuration, README/handoff/docs, skills and supporting files, agents, extensions, package integrations, hooks, scripts, instructions, rules, references, templates, prompts, output styles, status assets/configuration, themes, keybindings, account setup, assets/sounds, tests, licenses, and vendor records. Record source commit, dirty-file hash, destination, disposition, adaptation notes, and verification evidence without capturing credentials or private session content.
- Rescan all canonical, GitHub-specific, personal/local, Pi-adapted, and dynamically projected skills. Import recent changes before editing canonical copies. Generalize provider selection behind MPX Issue/Review/CI and tool contracts while preserving each workflow's triggers, decisions, safety gates, concurrency, provider actions, privacy constraints, fallback/manual handoffs, and referenced assets. Include previously excluded or deferred workflows such as continuation/decision harvesting, GitHub delivery and repository setup, personal workstation/content skills, and Sentry guidance unless an explicit reviewed retirement replaces them equivalently.
- Migrate shared skill contracts and references as first-class content, including subagent/reviewer/executor protocols, commit workflow, tracker resolution, exploration, testing, design, documentation, and authoring guidance. Preserve skill-version/drift rules and ensure generated runtime frontmatter never becomes a second maintained source.
- Converge canonical agent intent and every active Claude/Pi agent. Preserve model/effort/thinking mappings, tool restrictions, output schemas, `Explore` semantics, the small approved nesting boundary, provider-specific delivery behavior, review specializations, language references, and generated-agent drift checks.
- Port all active instruction and rule surfaces: root/global `AGENTS.md` and `CLAUDE.md` intent, `APPEND_SYSTEM.md`, compaction-only instructions, language and project/framework rules, output style, machine-path/worktree/port discipline, and runtime-specific loading/trust behavior. Keep project-targeted rules scoped rather than broadening them globally. Canonical authoring forbids em dashes in generated prose, keeps `AGENTS.md` edits extremely concise, removes a rule when the underlying issue is resolved instead of appending a success comment, batches independent user decisions inline with recommendations, and makes skill creation reference canonical agent vocabulary and shared writing-for-agents guidance.
- Port the complete guard/hook behavior through shared policy plus harness adapters: package-manager enforcement, dangerous-command blocking, pre-commit/secret checks, Fallow audit, post-write format/lint, post-command context, machine/session context, compaction injection, and notifications. Preserve fail-closed versus fail-open behavior intentionally and test event-order differences.
- Activate a supported subagent system in Pi rather than shipping inactive provenance. Preserve `Agent`, result retrieval, steering, background groups, scheduling when requested, worktree isolation, memory/transcripts, completion notifications, widgets/fleet view, and canonical agent discovery. Child agents inherit and may only narrow the parent launch tuple, routes, mounts, network, skills, and executor; nested delegation remains explicit and bounded.
- Provide immutable, policy-bound Pi equivalents for current `pi-mcp-adapter`, `pi-web-access`, compact tool display, auto-title, compaction instructions, terminal activity state, fullscreen behavior, and extension event coordination; retire the structured ask-user UI in favor of canonical inline batched questions. Preserve the Firecrawl search provider and scrape fallback already present in `pi-web-access` behind shared `web_search` and `fetch_content`, not duplicate Pi tools; keep it unavailable until identity-specific configuration exists and define paid-credit, fallback, caching, SSRF, and credential policy. Pin or vendor external packages only after provenance, license, update, tool-authority, credential, and sandbox review; replace mutable absolute package/worktree paths with MPX-owned resolution.
- Implement the provider-neutral managed development-service domain and Pi adapter for `start`, `status`, `logs`, `restart`, and `stop`, including bounded logs, configured-port readiness, process-tree ownership, lifecycle cleanup, status events, and Windows behavior. Expose it through `mpx dev ...` and a launch-bound `dev_server` tool; it must use assigned worktree ports and must not silently execute on the host when the selected executor is Docker.
- Replace the reduced runtime status with the shared observability contract in Section 14. Both Claude and Pi must show identity, title/session ID, model/effort, folder/editor/terminal actions, repository/worktree/branch, tokens/context/cost, provider usage, compactions, subagents, and ports. Preserve Claude's Task panel and review/CI actions and Pi's fleet/widgets or other true harness-specific surfaces instead of deleting them for superficial uniformity.
- Preserve account-specific settings, themes, keybindings, package/model choices, trust behavior, and terminal canvas/progress where they are part of the current workflow. Compare repository declarations with a privacy-safe live personal/work inventory of enabled plugin/package IDs, versions, capability routes, and source locations; classify differences without reading package credentials or private configuration. Keep native credentials, package state, sessions, trust decisions, and caches in their designated personal/work roots; generated projections and installers must never copy them.
- Eliminate active runtime imports from old repositories and `~/.codex`. Move required implementations such as compact-context behavior into canonical packages; retain old files only as attributed history or final-cutover input.

**Gate:** the convergence manifest has no unclassified active source; every `canonicalized`, `Claude-specific`, `Pi-specific`, `externalized`, or `retired` entry has evidence; every current skill and agent has semantic mapping and generated-runtime coverage; both harnesses pass the hook/tool/status/subagent/development-service capability matrix; external dependencies are pinned and reviewed; no active projection imports an old checkout; and the completed regression suite remains green.

### Phase F2 — Required Docker isolation and authentication proof

Run the proof against the complete Phase F1 runtime and tool inventory, not the earlier reduced adapter. Adding or widening any model-triggerable file, shell, process, browser, Git, MCP, web, subagent, or development-service path invalidates the affected evidence and requires the proof to run again.

Use standalone `sbx`; ignore the legacy `docker sandbox` plugin and do not attempt state migration without a documented conversion path. Pin the runtime version and every kit by immutable version/digest or source commit. Generate state-local unmounted sandbox environment files; prove both clone-mode sandbox-remote fetch and direct provider push/PR/MR/merge paths; use RO reference/opposite-domain mounts and no shared mutable skill store; document mount/confidentiality limits and environment recreation rules. Prove that clone mode is launched from a main checkout rather than a linked host worktree, and that host-worktree compatibility keeps Git operations on the host.

For Pi, do not claim proxy-managed OAuth through a third-party kit: Docker currently documents that this is unsupported. Prove the host-side Pi/sandbox-executor split with the ChatGPT/Codex subscription: native host file/shell/process/browser/Git tools are absent, every model-triggerable operation crosses the launch-bound MPX executor, and no OAuth token or native `auth.json` enters the VM. Keep personal/work Pi OAuth, `auth.json`, native sessions/history, trust, and caches in separate roots authenticated to two separate ChatGPT accounts; neither account's native state may be copied, mounted, or exposed to the other root or the VM. A fully in-sandbox Pi remains blocked until Docker or another executor can provide an equivalent OAuth-isolation contract.

**Gate:** the selected `sbx` client/daemon satisfy the pinned feature contract and diagnostics; built-in Claude/Codex credential isolation works; every Phase F1 tool and subagent path is exercised through the intended executor; the Pi split-executor proof shows no host-capability bypass and no token in the VM; clone fetch/direct-provider delivery, no-shared-skills, mount, named network policies, managed local-service, and resume behavior pass. Docker becomes the default only after this gate.

### Phase G — Sessions and local workflow records

- Import session schemas/scanners/resume planning.
- Add paused and unfinished state, a no-model handoff command, concise summary and next action, completion disposition, and durable inbox. Runtime exit hooks may capture metadata and mark a session paused without invoking a model; richer summaries are explicit user actions.
- Add provider-neutral conversation branching with native Claude and Pi adapters. Record parent and child runtime-qualified IDs, immutable launch identity/root, and whether files are shared or isolated. Prevent duplicate writers to one native transcript.
- Support safe optional side-by-side Windows Terminal tabs without shell interpolation. Conversation branching does not imply file isolation: shared mode reports collision risk, while modifying parallel work defaults to a new MPX worktree unless the user selects the current checkout.
- Persist identity, opaque native binding/account references, canonical root digest, mode, executor, resolved grants, skill artifact key, `launchKey`, repository, and worktree without persisting a root path, native credentials, account identifiers, or prompt content.
- Wire Claude/Pi lifecycle events and feed durable title, runtime-qualified session ID, resume state, branching lineage, and freshness into the shared observability envelope without making status rendering the session authority.
- Resume or branch Pi only through the recorded `pi` or `piw` identity/root and fail closed on a missing, mismatched, or differently authenticated root.
- Implement the local Markdown Issue provider with a configurable plugin-independent root, independent project-local numbering, the versioned frontmatter/body codec, derived dependency frontier, conflict-safe writes, and normalized CLI contract. Keep board promotion and Obsidian/task-dashboard views optional adapters rather than provider dependencies.
- Generate privacy-safe rebuildable Obsidian issue/session views when configured and validated resume links.
- Add one-time session-save import without merging personal and work histories.
- Replace old scheduled autosave with MPX-owned installation.

**Gate:** local Issue conformance covers independent monotonic IDs, the complete frontmatter/body schema, labels, local and normalized state, dependency frontier and relationships, unknown-content preservation, concurrent/external edits, optional board promotion, and rebuildable configured views; active session discovery, no-model handoff, mark unfinished, restart, branch lineage, file-workspace disclosure, side-by-side launch, inbox persistence, and resume use the correct identity/native root/mode/executor in both runtimes; personal/work Pi histories and sessions remain isolated, cross-root operations are rejected, and rollback preserves old saves and local Markdown issues.

**Implementation status:** the provider-neutral session contracts/store, partitioned captures and inbox, CLI commands, Claude discovery, Claude/Pi lifecycle ingestion, confirmation-bound relaunch planning, globally serialized root-attested Pi enrollment/re-enrollment, supported live OAuth availability probing, pre-side-effect launch/resume gates, one-time legacy save and Pi-registry import, session observation contribution, and MPX-owned scheduled-capture installer component are implemented. Root-attested local mode is accepted for Phase G. The remaining gate work includes no-model handoff and completion disposition, native branch adapters and lineage, shared/worktree selection and terminal tabs, the local Markdown Issue provider and optional projections, Phase F1 composition into `RuntimeStatusEnvelopeV1`, Phase F2 Docker resume admission, and Phase I immutable installed-runner authority. MPX does not continuously read the legacy Pi registry, substitute host execution, or schedule a mutable checkout runner.

**Accepted limitation:** the supported Pi auth command reports availability, provider, and auth type but no stable non-secret account subject. Root-attested mode therefore detects missing/changed roots and unavailable or wrong-provider/wrong-auth-type state, but cannot detect an account switch within the same root. MPX does not export credentials, decode JWTs, read `auth.json`, run token/credential commands, or claim stable-subject verification.

### Phase H — Project and template rollout

Parallelize independent repository adaptations:

- `yoursafe-components`
- `meeplog`
- `prejemesi`
- Grovekeeper as a normal project
- `template-sveltekit` and its setup skill

Do not add a React Native application to the rollout matrix; this does not exempt an active React Native setup skill or reference from Phase F1 convergence.

**Gate:** each target runs its dev/test surfaces on assigned non-default ports with coupled URLs correct; `mpx dev` and the launch-bound development-service tool start, observe, restart, and stop the declared services without orphaning processes or crossing executor boundaries.

### Phase I — Installation and system registration

- Install new CLI and user config; detect standalone `sbx` independently from Docker Desktop and report unsupported, legacy-only, unauthenticated, or client/daemon-mismatch states without making Docker a required dependency.
- Register immutable Claude and Pi runtime projections, all approved runtime-specific hooks/extensions/packages, MCP routes, web adapters, inline question policy, status actions, themes/keybindings, and managed development-service integration from the Phase F1 convergence manifest; do not register the retired structured question adapter.
- Replace shell blocks with one managed launcher block that preserves `cc`/`ccd`/`ccw`/`ccwd` and `pi`/`piw` identity shortcuts.
- Verify each native Claude/Pi account root, Git/provider/SSH route, MCP-sharing choice, and session/history boundary independently. For Pi, verify that `pi` and `piw` select their fixed personal/work roots, that root-attested probes fail closed on missing enrollment, root drift, unavailable authentication, wrong provider, or wrong auth type, and that neither root exposes the other's native auth or session state. Do not claim that this mode distinguishes accounts switched within one unchanged root.
- Update Windows Terminal, Raycast, Obsidian, scheduled tasks, shortcuts, environment paths, and repository remotes.
- Run clean-machine and existing-machine installation simulations.
- After the CLI, user config, immutable runtime files, and managed launchers are installed, complete Pi enrollment before the Phase I gate: sign in through native Pi separately in each configured personal/work root; run the no-write `mpx account enroll --identity NAME --json` plan; review the identity and canonical root; commit that exact plan with `--confirm-plan DIGEST`; then require `mpx account list`, `status`, and `verify` to report both bindings ready. Exercise cross-root rejection and unavailable-auth failure. If native `/login` changes the account inside an unchanged root, or if a configured root changes, require explicit `mpx account re-enroll` planning and confirmation before launch or resume.

**Gate:** `mpx install verify`, every identity/harness routing matrix, the full convergence-manifest installation matrix, the completed personal/work Pi enrollment and verification sequence, and the external integration checklist pass with the old system still recoverable. Fresh personal/work Claude and Pi launches expose their intended complete capability and status surfaces without reading code from either source checkout.

### Phase J — Final source reconciliation, cutover, and retirement

- Keep `mpx-claude-code` and `mpx-pi` active and recoverable through the validation period. Immediately before cutover, recapture each source commit and dirty/untracked inventory and compare it with the Phase F1 convergence baseline.
- Reconcile every added, changed, deleted, renamed, or newly referenced skill, agent, extension, hook, script, instruction, rule, reference, template, package, setting, status feature, test, license, and vendor record. Import and re-generalize late skill/workflow changes; do not waive drift because an earlier generated/provenance check passed.
- Re-run semantic skill and agent comparisons, generated projection checks, hook/tool capability tests, status matrices, external package/version checks, and personal/work runtime smoke tests. Produce a final parity report listing every source item, destination/disposition, behavior evidence, and the small set of explicitly reviewed exceptions.
- Observe normal use with legacy activation available as rollback, then disable old launchers/plugins/extensions without deleting source or native state. Repeat the complete acceptance suite with legacy activation disabled and monitor for old path/config/namespace access.
- Remove old activation and marker blocks only after the disabled-legacy run passes. Retire the hand-maintained `~/.codex` mirror only after no required runtime dependency remains.
- Archive or rename old repositories and update redirects/remotes only after their maintained trees, reachable history, vendor/license provenance, and historical journals are represented in MPX and no installed/runtime/generated path references an old checkout.
- Retain immutable migration snapshots and the final source/convergence manifests for the defined rollback window.

**Gate:** the final source-drift scan is empty or fully reconciled; the parity report has no unclassified or unexplained exception; all runtime, source-convergence, project, installer, identity/account, status, session, executor, and rollback matrices pass with legacy activation disabled; no old checkout is required; and the rollback drill succeeds from snapshots.

### Post-migration standalone backlog

These are not migration completion gates and must target installed MPX rather than old repositories:

- audit and refine Playwright verification without memory-only project configuration;
- refine interactive tutorials and `${MPX_AI_GENERATED}` project/category layout;
- decide whether podcast, slides, and mind-map need thin dedicated NotebookLM entry skills;
- add `notes-triage` for recent-note classification, load-bearing emphasis, and `#p/` checks with confirmation before rewrites;
- compare and handpick capabilities from Cursor's MIT-licensed `pstack` by semantics, not wholesale copying, including `how`, `why`, `recall`, `blast-radius`, `architect`, `teach`, verification maintenance, `unslop`, technical writing, orchestration playbooks, agents, and principles. Adapt or reject Cursor/Graphite-specific commands, model panels, transcript-mining privacy risks, duplicate orchestrators, and rules that conflict with MPX safety policy;
- adopt a tiny explicit-only `wait-what` skill after comparing Matt Pocock's source: re-pitch only the last answer with missing context, ASD-STE100 plain English, and the project's canonical vocabulary when `CONTEXT.md` or `CONTEXT-MAP.md` exists;
- audit Dietrich Gebert's MIT-licensed `ponytail` against MPX `code-clean`, reviewers, instructions, and Caveman provenance. Preserve validation, security, accessibility, and error handling while importing only the smallest non-duplicated rule or skill; and
- define any remaining unclear simplification, skill-trigger, and writing-for-agents ideas before adoption.

A separate Firecrawl extension is retired because maintained `pi-web-access` already supplies search and scrape integration. Phase F1 migrates that implementation behind the shared web contract.

## 19. Rigorous validation plan

### Static repository validation

- Capture commit plus dirty/untracked file hashes for `mpx-claude-code` and `mpx-pi`; compare them with the convergence manifest at Phase F1 baseline and again immediately before Phase J cutover.
- Require a destination/disposition and behavior evidence for every active source item. Excluded/deferred provenance entries do not count as parity, and a source hash check cannot substitute for an executable capability test.
- Traverse every tracked, dirty, and untracked path in both source repository roots under the Phase F1 inclusion/exclusion rules; recursively follow trusted skill/reference/package links and require a reason for every excluded path.
- Fail on unexplained source additions, changes, deletions, renames, mutable external package paths, duplicated maintained sources, stale generated projections, or active dependencies on old checkouts and `~/.codex`.
- Search tracked files for old absolute roots and repository names.
- Search active content for `/mp:`, `/mp-gh:`, `mp-*` public skill identities, `agent-resurrect`, old CLI names, `.worktree-hub.json`, `.mpx/kanbanflow.json`, and `statusline-projects.json`.
- Allow old names only in migration history/docs explicitly marked historical.
- Validate package licenses, `private` flags, publish allowlists, and generated artifacts.
- Verify no credential/session/state file is tracked.
- Verify generated Claude/Pi agents and runtime artifacts are reproducible and drift-free.
- Permit a retired source item only when the final parity report includes its explicit rationale, replacement or non-goal, and approval evidence.

### Config and trust

- Valid fixture per provider.
- Missing, malformed, unknown-field, and unsupported-version failures.
- User scope resolution for `MPX_PROJECTS` and `MPX_WORK`.
- Project cannot define executable commands or broaden user trust.
- Repo-defined post-create scripts blocked before trust.
- Trust records are bound to repository identity, commit/config hash, and package manifest/lockfile/script fingerprints; changing any fingerprint invalidates automation approval.
- Package install lifecycle hooks are treated as arbitrary repository code, not as intrinsically safe typed operations.
- Resolved config and logs contain no tokens, keyring values, private key paths where redaction is required, or secret environment values.
- `mpx init` is byte-idempotent after confirmation.
- No legacy config import occurs.

### Ports

- Main managed services get exact preferred ports.
- Main leases are created before linked worktree allocation.
- `8100/8101` produces `8102/8103`, then `8104/8105`.
- `5173/6006` produces `5174/6007`, then `5175/6008`.
- Mixed families do not overlap.
- Explicit family override behavior is deterministic.
- Managed cross-repo preferred conflicts are rejected at init/registration.
- `fixed-shared` duplicate claims are allowed and warned.
- Project-scoped shared database is identical in every worktree and not reallocated.
- Concurrent allocators cannot select the same exclusive port.
- Crash between registry reservation and file write recovers safely.
- External listeners cause candidate rejection/conflict reporting.
- Deleted/Fork-created/manual worktrees reconcile correctly.
- Port ceiling, reserved range, malformed lease, config change, and stale lease tests pass.
- Status line shows assigned ports and separately probes listening state.
- Claude and Pi show the same current-worktree ports.

### Worktrees

- Main resolution from Git common directory.
- Standard sibling folder for paths with spaces and branch slashes.
- Name/path traversal rejection.
- Correct base precedence and noninteractive failure.
- `.worktreeinclude` matching, containment, symlink, tracked-file exclusion, source/main fallback, and secret-copy trust.
- No editor process starts.
- Background preparation returns promptly but records a worker.
- Ordered steps, dependencies, timeout, failure, cancellation, log redaction, and restart reconciliation.
- Failed preparation preserves diagnostics.
- Dirty/locked worktree removal refuses safely.
- Removal stops only MPX-owned process fingerprints and releases leases at the correct point.

### Providers and credentials

- Provider ID maps deterministically to trusted adapter and executable.
- User executable override requires trust and validates path/version.
- GitHub/GitLab enterprise host behavior.
- `gh`, `glab`, `kf`, and SSH auth probes do not print tokens.
- Account/host mismatch fails before mutation.
- Capability matrix and normalized output snapshots.
- Gerrit review creation uses its semantic adapter rather than a substituted PR command.

### Skills and runtimes

- Canonical skill identities, pack membership, default exposure, descriptions, and trigger text validate without duplicated identity or copied descriptions.
- Scope classification uses canonical path-segment matching and longest-root precedence; user-local project pack/exposure overrides resolve through canonical `project.id`; the launch-only `--content-scope` selector is process-bound and reported.
- Artifact keys change with runtime, scope, project, canonical content, effective user config, or mapping version; launchers select the exact artifact and reject stale or cross-project/scope session reuse.
- Pack exclusion, `full`, `name-only`, `explicit-only`, and `off` produce deterministic manifest snapshots with identical availability and exposure decisions for Claude and Pi.
- Initial-context snapshots contain full discovery metadata only for `full`, names only for `name-only`, and no identity or description for `explicit-only`, `off`, or excluded skills. No full skill body appears before invocation.
- A natural-language request invokes an intended `full` skill; an inline explicit name can resolve `name-only`; an actual slash invokes `explicit-only`; prose slash text does not bypass policy.
- Model loaders accept only current `full` and `name-only` entries and reject `explicit-only`, `off`, excluded, ambiguous, stale, and path-escaped requests.
- Bounded skill search requires the runtime's launch-bound artifact key, remains fixed after CWD changes, rejects stale/mismatched keys, returns relevant `full` and `name-only` metadata on demand, and never reveals other exposure states.
- Trusted project `.agents/skills` remain outside the MPX namespace, require an explicit native-compatible `full` or `explicit-only` exposure declaration, are inventoried for context/compatibility diagnostics, and fail validation on missing/mismatched exposure, attempted `/mpx:*`, or runtime collision.
- Provider-specific implementation does not add redundant skill descriptions.
- `/mpx:<name>` resolves in both Claude and Pi.
- No catalog-owned native Pi `/skill:*` duplicate is present.
- No doubled `/mpx:mpx-*` names.
- Old `/mp:*` is absent after final cutover.
- Canonical skill invokes `mpx`, not provider CLIs.
- Claude runtime generation maps exposure without relying on plugin-inapplicable `skillOverrides`; Pi produces compatibility diagnostics for unsupported runtime semantics.
- Agent model/tool/thinking mappings generate correctly.
- Claude hooks and Pi adapters produce equivalent blocking/context behavior where intended.
- Plugin install from cache contains all required files and no outside symlink dependency.
- Compare every source skill and agent with its canonical mapping for behavior, not filename identity: triggers, decisions, safety gates, provider actions, concurrency, fallback/manual handoff, model/tool policy, output schema, and referenced assets remain covered.
- Tracker-neutral resolution, unified commit workflow, compaction-only instruction injection, `Explore` read-only breadth, reviewer/executor contracts, and GitHub/GitLab/KanbanFlow delivery semantics pass dedicated regressions.
- Personal/local workflows and runtime-specific skills are present only in their intended identity packs and preserve their privacy, machine-root, external-provider, and manual-action constraints.

### Runtime capabilities and status parity

- Run the capability matrix for personal/work Claude and personal/work Pi from immutable installed projections, not source checkouts.
- Shared guard policy plus Claude/Pi lifecycle adapters cover package-manager enforcement, dangerous commands, pre-commit/secrets, Fallow, post-write format/lint, post-command context, machine/session context, compaction, and notifications with documented fail-open/fail-closed behavior.
- Canonical subagents execute in both harnesses with correct model/effort/thinking and tools; routing tests prove broad search uses `Explore`, test-shaped implementation uses `mpx-tdd-executor`, other pre-analysed implementation uses `mpx-executor`, executors never self-review, known checks use `mpx-checker`, and independent reviewers stay read-only. Background/result/steer, bounded nesting, worktree isolation, scheduling when requested, lifecycle cleanup, completion notifications, and harness-specific Task/fleet displays are verified.
- Pi MCP, web access, inline batched questions, compact tool display, auto-title, terminal activity, compaction instructions, fullscreen behavior, themes, keybindings, and extension-event coordination work from pinned or MPX-owned implementations; the structured question tool is absent from installed model authority. Firecrawl remains one identity-configured provider or fallback behind shared web tools, has no duplicate model tool, and follows explicit paid-credit, security, and fallback policy. Claude keeps equivalent native/plugin capabilities where available.
- Context7 and Chrome DevTools routes work in every intended identity/runtime combination; unsupported routes fail structurally and never borrow credentials or configuration from the opposite identity.
- `mpx dev` and `dev_server` start/status/logs/restart/stop use assigned ports, bounded logs, readiness probes, owned process trees, cleanup, and the selected executor without implicit host fallback.
- The shared runtime-observability envelope validates identity, session title/ID, model/effort, repository/worktree/branch, link actions, tokens/context/cost, provider usage, compactions, subagents, development services/ports, freshness, and provenance without secrets.
- Both renderers display every shared field supported by their safe adapter. Tests cover missing/stale/error data, narrow/wide terminals, long/escaped paths, main/worktree state, manual/automatic compaction, provider changes, and running/queued/background/completed/failed agents.
- Claude-specific Task/review/CI/Windows actions and Pi-specific fleet/widget/provider details remain present and are declared adapter capabilities rather than removed for visual sameness.
- Synchronous status rendering performs no network, process, or socket work; asynchronous polling is bounded, cached, identity-bound, and visibly stale on failure.

### Launch, identity, and executor validation

- Every tuple dimension, including skill policy, and `launchKey` is process/session immutable; changed rights or disclosure require visible relaunch.
- Identity routes native roots/Git/providers/SSH/MCP while CWD classification grants nothing; unknown CWD fails closed.
- Built-in mode matrices, identity-domain project checks, RO-default cross-domain grants, explicit RW, elevation reason/banner/sanitized audit, protected control-plane apply, and next-launch-only UI pass.
- Host reports exact interception and never claims isolation; Docker reports direct/clone/extra-mount and confidentiality limits.
- Explicit-only tests prove that actual slash/UI/CLI invocation succeeds, prose slash text is inert, autocomplete remains user-visible, and model loaders reject the state. Full and name-only tests prove their distinct discovery and lazy-loading contracts.
- Project launch-default tests prove explicit/project/scope/built-in precedence and show that committed project files cannot select identity, grants, executor, writable mounts, credential routes, or a broader network policy.
- Docker tests prove clone commit/fetch handoff and authorized push/PR/MR/merge, host-worktree Git limitations, project/local service connectivity, effective named network policy and policy-log diagnostics, no shared mutable skills, and the host-side Pi executor's lack of model-triggerable host file/shell/process/browser/Git capabilities.
- Descriptors/config/logs contain no secret, private key, native-auth path, OAuth token, or prompt. Docker tests are required for supported launchers and capability-gated only on platforms explicitly declared unsupported.

### Project runtime verification

For each target repository, allocate non-default ports and verify the actual listener, URL generation, and tests:

- `yoursafe-components`: Components, Storybook/Docs, asset URL, Playwright, HTTPS/certs.
- `meeplog`: app, preview, Storybook, worker `/health`, public API URL, Vitest APIs.
- `prejemesi`: app, preview, Storybook, Playwright, Vitest APIs, auth origin/trusted origins; shared database remains one instance.
- Grovekeeper: Vite/Tauri URL coupling, HMR where applicable, preview/Playwright, Storybook.
- Generated Svelte template: create two linked worktrees and run dev/preview/Storybook/E2E on distinct assignments.

Use strict ports so silent framework auto-increment cannot masquerade as success.

### Sessions

- Discover active Claude personal/work sessions and discover Pi sessions separately in the personal and work native roots.
- Stable runtime-qualified identity and selected native account root; resume each Pi session only through its recorded `pi` or `piw` root and designated ChatGPT account, and reject cross-root resume.
- Mark unfinished with note and next action, create a no-model handoff, and record completion disposition.
- Restart machine or process and preserve inbox.
- Resume into the correct account, cwd, worktree, model/reasoning policy, and session file.
- Branch through the correct native adapter, preserve lineage, reject duplicate transcript writers, disclose shared versus isolated files, and safely open optional side-by-side terminal tabs.
- Reconcile dead processes without losing unfinished state.
- One-time legacy save import is idempotent and non-destructive.
- Scheduled capture runs and reports a healthy last result.

### Installer and machine integration

- `mpx install plan` is read-only and complete.
- Apply is idempotent and marker ownership does not duplicate blocks.
- Verify checks actual targets rather than source intentions.
- Uninstall removes only MPX-owned entries and preserves credentials/data.
- Claude personal and work launchers load correct account/plugin combinations.
- Pi auth/session data remain real files in separate personal/work native roots authenticated to separate designated ChatGPT accounts.
- Windows Terminal profile opens at new repo and uses the intended icon.
- Raycast repo/editor/terminal/Obsidian/CLI links all execute.
- Obsidian dashboards and inbound links resolve after folder/page rename.
- Scheduled tasks and shortcuts point to new commands.
- Environment variables and PATH contain no stale required path.
- Old system can still launch during validation and can be restored after a simulated failed cutover.

### Future GUI independence

- Run the entire core/CLI test suite with Grovekeeper absent.
- Delete/disable any future GUI process and verify ports, worktrees, sessions, providers, status lines, and installers continue working.
- Validate stable JSON snapshots from a standalone consumer fixture.
- Ensure the state database is owned and migrated by MPX, not by a GUI.

## 20. Completion criteria

The migration is complete only when:

- New `mpx` repository is the canonical source.
- README and complete user, operator, and reference docs cover installation, identities, credentials, skills, agent routing, providers, local issues, sessions, ports, worktrees, runtime differences, rollback, and common workflows; documented commands are exercised against the installed system.
- `mpxconfig.json` is documented, validated, and used by target projects.
- Main and linked checkout port invariants pass across repositories.
- Claude and Pi use `/mpx:*`, shared canonical content, and the same resolved skill availability/exposure manifest.
- Every active skill, agent, hook, extension, script, instruction, rule, reference, template, package integration, and user-visible runtime workflow from the final `mpx-claude-code` and `mpx-pi` scan is canonicalized, retained in the correct runtime, safely externalized, or explicitly retired with evidence; no source drift remains unexplained.
- Skill packs, named skill policies including zero-initial-context `clean`, user-local content/project overrides, four-state exposure, split human/model search, lean initial context, and lazy body loading pass cross-runtime tests.
- Generic Issue terminology and adapters replace Task/ticket/provider command prose.
- Local Markdown issues pass schema, numbering, relationship, concurrency, and optional projection tests without depending on an Obsidian task plugin; SQLite, if enabled, is rebuildable and non-authoritative.
- Worktree creation is safe, standard, no-editor, port-aware, and preparation-aware.
- Both harnesses provide the required shared status/observability fields and retain useful harness-specific status surfaces; Pi subagents, MCP/web tools, inline batched questions, managed development services, hook guards, titles, compaction behavior, terminal activity, and runtime UI reach verified current-workflow parity.
- The main agent remains orchestrator/evaluator and deterministic routing selects canonical exploration, implementation/TDD, checking, review, specialist, and delivery roles without self-approval or authority widening.
- `mpx session inbox`, no-model handoff, and native conversation branching provide durable unfinished-work tracking and safe parallel continuation.
- Target projects and Svelte scaffolding run on assigned ports.
- Required Docker launch, identity routing, mode/workspace/network/grant reporting, Pi split-executor isolation, machine installation, and all external integrations validate; host filesystem execution remains explicitly elevated.
- No old system component, checkout, mutable external worktree path, or `~/.codex` implementation is required for normal operation.
- Rollback snapshots and drills have passed before old repositories/installations are retired.

## 21. Evidence used for this plan

Primary inspected sources include:

- Active `C:/_MP_projects/mpx-claude-code/plugins/mp/`, `plugins/gh/`, `local/skills/`, `instructions/`, `rules/`, `rules-per-project/`, settings, templates, assets, sounds, setup, handoff, and package/test configuration, including dirty and untracked migration inputs.
- Active `C:/_MP_projects/mpx-pi/extensions/`, `agents/`, `skills/`, `prompts/`, `themes/`, settings, keybindings, subagent configuration, account/terminal scripts, package/vendor records, historical journal, and tests, including dirty and untracked migration inputs.
- `C:/_MP_projects/mpx-claude-code/docs/WORKTREE_HUB.md`
- `C:/_MP_projects/mpx-claude-code/docs/PLUGIN_CONVERSION.md`
- `C:/_MP_projects/mpx-claude-code/plugins/mp/scripts/lib/worktree-hub.mts`
- `C:/_MP_projects/mpx-claude-code/plugins/mp/scripts/setup-worktree.mts`
- `C:/_MP_projects/mpx-claude-code/plugins/mp/scripts/status-line.mts`, its status/compaction/subagent helpers and tests, and `plugins/mp/hooks/`.
- `C:/_MP_projects/mpx-pi/README.md`
- `C:/_MP_projects/mpx-pi/PI_MIGRATION.md` (historical Pi implementation journal/provenance; not an active plan)
- `C:/_MP_projects/mpx-pi/extensions/footer.ts`, `guard-hooks.ts`, `auto-title.ts`, `compact-instructions.ts`, `agent-resurrect.ts`, terminal-progress/fullscreen adapters, and namespace commands.
- `C:/_MP_projects/mpx-pi/extensions/subagents/` and `extensions/dev-server/`, including their event contracts, UI, dependencies, provenance, and tests.
- Current Pi package integrations for web access, MCP, structured questions, and compact tool display as declared by the maintained settings source.
- `C:/_MP_projects/kanbanflow-cli/src/config.rs`
- `C:/_MP_projects/kanbanflow-cli/src/token.rs`
- `C:/_MP_projects/kanbanflow-cli/skills/shared/KF_WORKFLOW.md`
- `C:/_MP_projects/mpx-ports/README.md`
- `C:/_MP_projects/mpx-worktrees/README.md`
- `C:/_MP_projects/agent-resurrect/README.md`
- `C:/_MP_github_cloned/matt-pocock-skills/skills/engineering/setup-matt-pocock-skills/SKILL.md`
- `C:/_MP_github_cloned/matt-pocock-skills/CONTEXT.md`
- Target project and template package/framework/test configuration under `prejemesi`, `meeplog`, Grovekeeper, `template-sveltekit`, and `yoursafe-components`.
- Installed Pi documentation for skills, extensions, packages, providers, models, SDK, settings, and environment variables.
- Claude Code skill and plugin documentation for progressive disclosure, invocation controls, `skillOverrides`, plugin namespaces, and command expansion.
- Agent Skills specification for portable canonical frontmatter and supporting-file layout.
- Claude Code worktree documentation for `.worktreeinclude`.
- Machine integration inventory covering shell profiles, Windows Terminal, Claude/Pi config links, Raycast artifacts, Obsidian project dashboards, and installer-owned state.
- Privacy-safe aggregate session path classifications in Section 2A.
- Prior local standalone `sbx` and legacy Docker Desktop plugin inspection as historical evidence only; launch readiness must be re-verified on the actual host at implementation time.
- `https://github.com/docker/sbx-releases` for proprietary standalone release metadata and `C:/_MP_github_cloned/sbx-kits-contrib` for Apache-2.0 contributed kit source, including the Pi kit's current credential limitations.
- Current Docker Sandboxes security, credential, kit, network-policy, clone-workflow, and local-development documentation, especially the explicit limitation that third-party sandbox agents do not receive proxy-managed OAuth.
- Current Claude Code skill invocation/context documentation and Pi skill/provider documentation establishing that MPX `name-only` requires runtime-specific projection and that Pi's ChatGPT/Codex OAuth normally lives in its native host auth store.

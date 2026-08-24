# MPX Unified System Migration

**Status:** Sole authoritative active migration plan; Phases B–F implemented, Phase F2 Docker isolation proof and later phases pending
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

Deliver one installed `mpx` CLI, one canonical skill/agent source, one Claude Code plugin named `mpx`, one Pi runtime adapter, and stable versioned JSON/library contracts that a future GUI can consume. `mpx-pi` is a migration source, not a permanent product or independent plan; after Phase J no `mpx-pi` checkout remains active, while native Claude/Pi account state remains in harness-owned roots outside the MPX repository as designed.

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

Normal interactive use must not require remembering this tuple. A terminal already opened in a project is the primary selector. `cc`, `ccw`, `pi`, and `piw` pass only their explicit harness and personal/work identity choice to MPX; `mpx launch` resolves every other value from the current CWD and user-local launch defaults. A Windows Terminal project profile continues to set its starting directory and invokes the same short launcher, so opening a project tab and typing `ccw` or `pi` remains the fast path.

Launch-default precedence is: explicit command argument; user-local project launch default keyed by canonical `project.id`; user-local longest-root scope launch default; built-in safe default. A committed project manifest may declare required development endpoints and services but never chooses identity, grants, executor, credential route, or a permission-widening default. A launcher with an explicit identity must fail closed when the selected project does not belong to that identity domain; it must not silently switch identities. The resolved default must be displayed compactly before the first turn and be inspectable with `mpx launch explain --cwd . --json`.

Identity selects native Claude/Pi roots and their auth/history/sessions/trust/cache, Git author routing, provider CLI routes, SSH route, and explicit MCP sharing. Native stores remain authoritative: MPX config contains no secret values, private keys, or copied native credentials/auth paths. CWD classification never selects identity and grants no filesystem rights. Provider `connections` move from scopes/projects to identities. Identities, modes, presets, and connections never enter committed `mpxconfig.json`.

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
mpx dev start|stop|status

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
- Preserve real `auth.json`, sessions, and caches outside Git.
- Replace every absolute import from `mpx-claude-code` with workspace package or artifact resolution.
- Make Pi footer consume the same status snapshot and current-worktree port resolver as Claude.

## 15. Sessions and unfinished-work inbox

Replace snapshot-only resurrection with a provider-neutral session domain.

Session identity includes runtime plus native session ID. Track:

- Runtime, identity, immutable launch tuple/hash and `launchKey`.
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
mpx session mark <id> unfinished --note ...
mpx session inbox
mpx session resume <id>
mpx session save
mpx session reconcile
```

Claude/Pi lifecycle adapters update state. A future GUI may display and mutate this through stable contracts, but MPX remains fully usable without any GUI.

Existing `agent-resurrect` saves and Pi active-session records receive a one-time, non-destructive import command. The new runtime does not continuously read legacy stores.

## 16. Migration and coexistence strategy

### Core rule

Keep old repositories, installations, and data untouched while building and verifying the new system. Do not activate old and new hook/plugin stacks simultaneously in the same session unless a specific coexistence test requires it.

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
- Plugin marketplace IDs and caches.
- Global instructions/settings/output-style/status-line links.
- Historical project/session path keys.
- Current Claude-managed worktrees.

Validate both accounts separately and preserve native credential/history directories.

### Pi

- `~/.pi/agent` entry-by-entry symlinks.
- Extensions, agents, prompts, themes, and selected skills.
- Native auth/models/sessions left real.
- Themed launcher.
- Generated agent drift checks.

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

Update project dashboards and issue references under the MPX project area and mini-project boards. Decide whether to rename the `MpxClaudeCode` project folder to `Mpx`; update inbound links, dashboard queries, URI targets, and board metadata atomically. Do not read or rewrite unrelated private notes.

### Scheduled Tasks, shortcuts, and session data

- Detect and migrate the agent-resurrect autosave task if installed.
- Verify task command, working directory, account, trigger, last result, and manual run.
- Detect Desktop/Start Menu shortcuts and regenerate only those owned by the old installer.
- Preserve save files until imported and verified.
- Keep old saves read-only through rollback.

### Environment variables

Update bootstrap variables such as `MPX_SKILLS_DIR` only after the new path exists. Continue resolving machine roots from the existing `MPX_*` variables. Add new variables only when they bootstrap user-local config; do not mirror project configuration into environment variables.

## 18. Phased execution

### Phase A — Baseline and safety

- Create the new Git repository at `C:/_MP_projects/mpx` without moving old sources.
- Add root instructions, workspace tooling, this plan, and ADRs.
- Capture integration snapshots and source commit inventory.
- Run a secret/path/publication audit.
- Define rollback commands and artifact locations.

**Gate:** destination is reproducible; every mutable integration has a backup and restore test.

### Phase B — Contracts first

This completed baseline implemented the original scope/config/provider contracts and four exposure states. Phase B2 preserves that four-state contract and adds user-local project and scope launch defaults.

- Implement config schema/resolver/provenance.
- Implement result/error envelopes.
- Implement user scope/provider registry contracts.
- Define the baseline canonical skill-catalog metadata, pack membership, scope/project pack and exposure precedence, project-extension boundary, identity/collision rules, artifact key, runtime binding, and resolved-manifest schema.
- Implement read-only skill inventory, exposure explanation, and bounded search over fixtures before importing runtime content.
- Add GitHub/GitLab/KanbanFlow fixture configs.
- Implement `mpx config`, `mpx skill`, `mpx init`, and `mpx doctor` read-only paths.

**Gate:** schema fixtures, skill scope/exposure fixtures, collision tests, deterministic manifest snapshots, bounded search tests, and malicious-config tests pass; no secret enters resolved output.

### Phase B2 — Launch contracts and fast defaults (implemented)

The corrected contract retains read-only identity, mode, preset, grant, descriptor/key, provider/SSH/MCP routing, split-search, and `--content-scope` work. It uses exactly four exposure states with no marker or activation-minting surface, and implements project/scope launch-default resolution, workspace/network policy axes, alias fast-path resolution, and provenance explaining every default.

Actual harness spawning, trusted interactive confirmation and approval minting, persistent audit storage, runtime imports/integration, and Docker execution remain deferred to Phase F/F2.

**Gate:** fail-closed CWD, identity-domain mismatch, deterministic explicit/project/scope/built-in default precedence, tuple immutability, route/secret safety, elevation audit, and four-state manifest/provenance/hash/path/rejection fixtures pass. `cc`, `ccw`, `pi`, and `piw` resolve a known project without additional launch arguments.

### Phase C — Ports and state

This baseline is implemented; the tasks below record delivered scope and remain acceptance obligations for later integration.

- Implement port families, global registry, main reservation, local lease file, concurrency, and reconciliation.
- Add Windows process-inspection adapter and JSON output.
- Implement `mpx ports` commands.
- Build provider-neutral status snapshots and fixture renderers against the shared resolver; do not modify or import the old Claude/Pi runtime sources yet.

**Gate:** exact family arithmetic, cross-repo exclusivity, fixed-shared warnings, concurrent allocation, crash recovery, and status-snapshot fixture parity pass.

### Phase D — Worktree lifecycle

**Status: complete.** Production preparation, cancellation, worker restart reconciliation, and the Windows-path gate are implemented and verified. Durable creation continuation records content-bound include and preparation evidence and resumes Git → includes → ports → preparation after any persisted boundary; prunable/manual deletion reconciliation and explicit `--cwd` removal safety are covered.

- Port worktree picker/lifecycle from Bash and plugin-local scripts into packages.
- Implement standard sibling path, `.worktreeinclude`, no-editor behavior, lifecycle state, and background preparation worker.
- Add remove/reconcile safety.
- Implement shell `cd` integration as a thin wrapper.

**Gate:** create/prepare/remove/reconcile tests pass on Windows paths, spaces, dirty/locked worktrees, failure, and cancellation.

### Phase E — Provider-neutral issues and delivery

**Status: complete.** Final review and verification are green for the trusted provider registry and adapters, the KanbanFlow Issue/`mpxconfig.json` cutover in its dedicated worktree, provider-neutral CLI and canonical skills, identical fake-backend Issue conformance, and structured unsupported-capability and error results.

- Implement provider registry and built-in adapters.
- Rename KanbanFlow’s public Task vocabulary to Issue in its separate repo.
- Make `kf` read `mpxconfig.json` only.
- Rewrite generic skills to `mpx issue`, `mpx review`, and `mpx ci`.
- Remove GitHub/GitLab/Kanban command tables from canonical skills.

**Gate:** identical issue contract tests pass across fake GitHub, GitLab, and KanbanFlow backends; unsupported capabilities fail structurally.

### Phase F — Docker-first launch integration, runtime unification, and four-state skill projection

**Status: complete.** Spec, security, reliability, and performance reviews are clean, and the full Phase F tests and gates pass. Evidence includes launch-bound neutral manifests and Claude/Pi projections; the exact `full`, `name-only`, `explicit-only`, and `off` states with separate model/human discovery; alias and runtime execution with default Docker safely gated pending F2, no fallback, and explicit host approval; canonical content and provenance; shared policy, hooks, and status with live runtime parity; project skills; read-only routes with Claude MCP support and structured Pi incompatibility; launch audits; and source verification.

Phase F2 isolation and authentication proof remains pending. Docker does not become the default until that gate passes, and Phase F2 or any later phase is not marked complete here.

- Implement Docker-first launch resolution, identity-native runtime roots, Git/provider/SSH/MCP routing, mode/skill-policy/workspace/network/grant reporting, launch banners/audits, and immutable `launchKey` validation. Host filesystem execution is explicit elevation only.
- Make account aliases delegate to the launch resolver while preserving fast personal/work selection and requiring relaunch for any rights change. From a known project directory, the aliases need no profile arguments beyond their built-in harness and identity selection.
- Fully import the maintained `mpx-pi` runtime/config tree and the Claude sources; move shared content into one canonical tree while Pi-only extensions, settings projections, themes, account setup, and vendor provenance move under `runtimes/pi/`.
- Classify every canonical skill by pack and default exposure; migrate personal skills into canonical content and rewrite or retire provider-specific duplicates.
- Build one `mpx` Claude plugin implementation plus immutable scope/project-resolved artifacts and launch-time artifact selection.
- Convert skills to bare identities and `/mpx:*`.
- Generate Claude exposure metadata and the Pi command/catalog/loader manifest from the same resolver output.
- Implement separate search contracts: bounded artifact-bound model search for `full`/`name-only`, and explicit human CLI/TUI slash autocomplete/search across all user-invocable states without implicit model disclosure.
- Rename canonical agents and regenerate Pi agents.
- Replace all absolute cross-repository imports and Claude-specific placeholders in canonical content.
- Port hooks/status/footer through package APIs and connect both runtime renderers to the Phase C status snapshot.
- Inventory the hand-maintained `~/.codex` mirror, move any still-required Pi dependency such as `compact-context.js` into canonical MPX packages, and mark obsolete mirror content for Phase J removal.

**Gate:** Claude personal, Claude work, and Pi resolve the same intended skill availability and exposure; `full`, `name-only`, `explicit-only`, and `off` behave as specified; skill bodies remain lazy; a canonical skill behaves equivalently in both harnesses; fast aliases resolve the project defaults; and Claude and Pi render equivalent validated current-worktree ports.

### Phase F2 — Required Docker isolation and authentication proof

Use standalone `sbx`; ignore the legacy `docker sandbox` plugin and do not attempt state migration without a documented conversion path. Pin the runtime version and every kit by immutable version/digest or source commit. Generate state-local unmounted sandbox environment files; prove both clone-mode sandbox-remote fetch and direct provider push/PR/MR/merge paths; use RO reference/opposite-domain mounts and no shared mutable skill store; document mount/confidentiality limits and environment recreation rules. Prove that clone mode is launched from a main checkout rather than a linked host worktree, and that host-worktree compatibility keeps Git operations on the host.

For Pi, do not claim proxy-managed OAuth through a third-party kit: Docker currently documents that this is unsupported. Prove the host-side Pi/sandbox-executor split with the ChatGPT/Codex subscription: native host file/shell/process/browser/Git tools are absent, every model-triggerable operation crosses the launch-bound MPX executor, and no OAuth token or native `auth.json` enters the VM. Keep personal/work auth and session state separate. A fully in-sandbox Pi remains blocked until Docker or another executor can provide an equivalent OAuth-isolation contract.

**Gate:** the selected `sbx` client/daemon satisfy the pinned feature contract and diagnostics; built-in Claude/Codex credential isolation works; the Pi split-executor proof shows no host-capability bypass and no token in the VM; clone fetch/direct-provider delivery, no-shared-skills, mount, named network policies, local-service, and resume behavior pass. Docker becomes the default only after this gate.

### Phase G — Sessions

- Import session schemas/scanners/resume planning.
- Add unfinished state and inbox.
- Persist identity, mode, executor, resolved grants, skill artifact key, and `launchKey` without copying native credentials or prompt content.
- Wire Claude/Pi lifecycle events.
- Add one-time session-save import without merging personal and work histories.
- Replace old scheduled autosave with MPX-owned installation.

**Gate:** active discovery, mark unfinished, restart, inbox persistence, and resume into the correct identity/mode/executor for both runtimes; personal/work native history remains isolated and rollback leaves old saves usable.

### Phase H — Project and template rollout

Parallelize independent repository adaptations:

- `yoursafe-components`
- `meeplog`
- `prejemesi`
- Grovekeeper as a normal project
- `template-sveltekit` and its setup skill

Do not include React Native.

**Gate:** each target runs its dev/test surfaces on assigned non-default ports with coupled URLs correct.

### Phase I — Installation and system registration

- Install new CLI and user config; detect standalone `sbx` independently from Docker Desktop and report unsupported, legacy-only, unauthenticated, or client/daemon-mismatch states without making Docker a required dependency.
- Register Claude plugin and Pi runtime.
- Replace shell blocks with one managed launcher block that preserves `cc`/`ccd`/`ccw`/`ccwd` and `pi`/`piw` identity shortcuts.
- Verify each native Claude/Pi account root, Git/provider/SSH route, MCP-sharing choice, and session/history boundary independently.
- Update Windows Terminal, Raycast, Obsidian, scheduled tasks, shortcuts, environment paths, and repository remotes.
- Run clean-machine and existing-machine installation simulations.

**Gate:** `mpx install verify`, every identity/harness routing matrix, and the external integration checklist pass with old system still recoverable.

### Phase J — Cutover and retirement

- Observe normal use through a deliberate validation period.
- Confirm no old path/config/namespace is accessed.
- Remove old activation and marker blocks, then retire the hand-maintained `~/.codex` mirror after the Phase F inventory proves no required runtime dependency remains.
- Archive or rename old repositories and update redirects/remotes. Archive `mpx-pi` only after its complete maintained tree, vendor/license provenance, and historical journal are present in MPX and no runtime path references the old checkout.
- Retain immutable migration snapshots for a defined rollback window.

**Gate:** full acceptance suite passes after old activation is removed; rollback drill succeeds from snapshots.

## 19. Rigorous validation plan

### Static repository validation

- Search tracked files for old absolute roots and repository names.
- Search active content for `/mp:`, `/mp-gh:`, `mp-*` public skill identities, `agent-resurrect`, old CLI names, `.worktree-hub.json`, `.mpx/kanbanflow.json`, and `statusline-projects.json`.
- Allow old names only in migration history/docs explicitly marked historical.
- Validate package licenses, `private` flags, publish allowlists, and generated artifacts.
- Verify no credential/session/state file is tracked.
- Verify generated Pi agents and runtime artifacts are reproducible and drift-free.

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

- Discover active Claude personal/work and Pi sessions.
- Stable runtime-qualified identity.
- Mark unfinished with note/next action.
- Restart machine/process and preserve inbox.
- Resume into correct account, cwd, worktree, model/reasoning policy, and session file.
- Reconcile dead processes without losing unfinished state.
- One-time legacy save import is idempotent and non-destructive.
- Scheduled capture runs and reports a healthy last result.

### Installer and machine integration

- `mpx install plan` is read-only and complete.
- Apply is idempotent and marker ownership does not duplicate blocks.
- Verify checks actual targets rather than source intentions.
- Uninstall removes only MPX-owned entries and preserves credentials/data.
- Claude personal and work launchers load correct account/plugin combinations.
- Pi auth/session data remain real files.
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
- `mpxconfig.json` is documented, validated, and used by target projects.
- Main and linked checkout port invariants pass across repositories.
- Claude and Pi use `/mpx:*`, shared canonical content, and the same resolved skill availability/exposure manifest.
- Skill packs, named skill policies including zero-initial-context `clean`, user-local content/project overrides, four-state exposure, split human/model search, lean initial context, and lazy body loading pass cross-runtime tests.
- Generic Issue terminology and adapters replace Task/ticket/provider command prose.
- Worktree creation is safe, standard, no-editor, port-aware, and preparation-aware.
- `mpx session inbox` provides durable unfinished-work tracking.
- Target projects and Svelte scaffolding run on assigned ports.
- Required Docker launch, identity routing, mode/workspace/network/grant reporting, Pi split-executor isolation, machine installation, and all external integrations validate; host filesystem execution remains explicitly elevated.
- No old system component is required for normal operation.
- Rollback snapshots and drills have passed before old repositories/installations are retired.

## 21. Evidence used for this plan

Primary inspected sources include:

- `C:/_MP_projects/mpx-claude-code/docs/WORKTREE_HUB.md`
- `C:/_MP_projects/mpx-claude-code/docs/PLUGIN_CONVERSION.md`
- `C:/_MP_projects/mpx-claude-code/plugins/mp/scripts/lib/worktree-hub.mts`
- `C:/_MP_projects/mpx-claude-code/plugins/mp/scripts/setup-worktree.mts`
- `C:/_MP_projects/mpx-claude-code/plugins/mp/scripts/status-line.mts`
- `C:/_MP_projects/mpx-pi/README.md`
- `C:/_MP_projects/mpx-pi/PI_MIGRATION.md` (historical Pi implementation journal/provenance; not an active plan)
- `C:/_MP_projects/mpx-pi/extensions/footer.ts`
- `C:/_MP_projects/mpx-pi/extensions/mp-namespace-commands.ts`
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

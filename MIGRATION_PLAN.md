# MPX2 Migration Plan

## Outcome

Build a new, small MPX in `C:/_MP_projects/mpx2`, switch daily use away from the current control
plane, adapt or explicitly retire every retained workflow, then archive the legacy repositories and
rename `mpx2` to `mpx`.

Orca owns worktrees, terminals, agent status, notifications, review UI, orchestration UI, hibernation,
and operational visibility. MPX owns authored content, small Claude/Pi projections, account-specific
launch wrappers, project metadata, correct native-session resume, approved Pi extensions, and
approved command safeguards. Agent Resurrect remains a candidate companion, not an automatic retirement.

This plan does not authorize deleting legacy data or changing installed launchers before the
acceptance gates pass. [DECISIONS.md](DECISIONS.md) records confirmed current choices; this plan owns
implementation work, pending validation, and acceptance. Unfinished grills prepare remaining decisions.
Move confirmed outcomes here and into decisions, then remove completed grills rather than retaining
parallel specifications or historical alternatives.

## Confirmed architecture

### Repository

- Initialize `mpx2` as one private TypeScript package using pnpm.
- Create a private GitHub repository during implementation. Its fresh history becomes authoritative;
  preserve old repository histories separately. Confirm exact remote names before renaming or
  archiving any remote.
- Use conventional commits and run `pnpm run typecheck` before each commit.
- Treat the current dirty `C:/_MP_projects/mpx` working tree as the newest content intent.
- Use `mpx-claude-code` and `mpx-pi` as behavioral references when adapting each workflow.
- Commit deterministic `dist/packs`, `dist/claude`, and `dist/pi` output with its generating source change.

### Source and projections

```text
content/
  skills/<bare-name>/
  agents/<bare-name>.md
  instructions/{shared,claude,pi}/
  hooks/
  rules/
  output-styles/
  runtime-profiles.json

dist/
  packs/<pack>/claude/.claude/skills/...
  packs/<pack>/pi/skills/...
  claude/{agents,instructions,...}
  pi/{agents,instructions,...}
```

The compiler may only:

- select the allowed skill packs;
- generate native skill names `mp-<name>`;
- preserve generated specialist-agent names `mpx-<name>`;
- map exposure, model class, thinking, capabilities/tools, and native frontmatter;
- replace a small declared allowlist of named body placeholders;
- copy bodies and support files otherwise unchanged;
- reject unresolved placeholders, broken local references, duplicate generated names, and malformed
  canonical metadata.

Do not add content hashes, immutable manifests, per-session output, launch bindings, artifact stores,
stale-content authority, approval digests, or runtime integrity revalidation.

### Content exposure

- Pack selection reduces context, not filesystem access. Without repository selection, personal
  wrappers load development plus personal and work wrappers load development. Explicit repository
  selection replaces those defaults without account access restrictions. An explicit empty pack list
  loads no MPX globals; missing selection uses defaults.
- Filter only MPX-managed global packs; project and independently installed native skills remain eligible.
  Invalid repository configuration warns and uses wrapper defaults. Unavailable fallback pack paths
  warn and continue with native skills only. Direct native launches may bypass selection.
- Each skill declares its own exposure in canonical frontmatter: normal catalog exposure,
  name-only, or explicit-only. Normal exposure means native name/description discovery with a lazy
  body, not eager injection of the entire skill. Personal skills default to explicit-only.
- Prefer native exposure controls. Name-only must provide a name and reliable loading mechanism for
  mid-prompt references. Pi may use a minimal generic description if context/loading tests pass;
  Claude may do likewise if exact native settings integration is disproportionate. Do not build a
  custom settings-management layer merely to obtain exact name-only exposure;
  do not silently replace name-only with explicit-only. Explicit-only has no advertised context entry
  and only requires leading-command invocation. Cross-skill invocation is optional if straightforward.
- Reserve `mp-` exclusively for MPX globals; the user guarantees project skills will not use it.
  Use native Claude `/mp-<name>` and Pi `/skill:mp-<name>` commands. Do not add custom `/mpx:` aliases,
  custom collision handling, or guaranteed project-first precedence; native accidental-collision
  behavior is sufficient.
- Repository skills remain canonical under `.agents/skills/<name>` and use native project naming.
  Excluding a global pack does not exclude project skills.
- Projects own symlinks needed to share `.agents/skills` between harnesses: Pi autodiscovers that
  source, and Claude uses `.claude/skills`. Do not add `mpx project setup` solely for skill linking.
  Existing setup responsibilities remain unless separately reviewed and retired. Preserve unrelated
  entries at any link-path conflict.
- Pack filtering is mandatory. Store committed per-pack MPX output outside auto-discovered global skill
  roots. Repository `mpxconfig.json` selects packs, with linked worktrees resolving the main checkout.
  Pi wrappers pass each selected pack as a repeated `--skill` directory without `--no-skills`; Claude
  wrappers pass `--add-dir` pack roots containing `.claude/skills`. This additive design preserves native
  project and unrelated package discovery. Do not mutate shared account links when starting a session.
- No per-session generated content, prompts, catalogs, manifests, registries, session artifacts, or
  credential routing. Pi's current in-process SDK subagents create a child `DefaultResourceLoader` and
  must receive selected paths explicitly rather than relying on a child shell wrapper. Keep native project
  discovery and subagent selection consistent, and test simultaneous sessions with different packs.
- The mechanism is approved, but installed Claude `--add-dir`/subagent behavior and Pi interactive behavior
  still require prototypes and acceptance. Do not describe them as tested. Native settings edits/exposure
  mapping and selected harness compatibility remain open.
- Live sessions require native reload/restart to refresh discovery; resumed sessions must load the
  approved current resources without resurrecting obsolete MPX integrations.

### Discovery implementation validation

The requirements and additive architecture are settled. Complete these checks against the selected
installed harnesses before treating discovery as ready:

- Resolve Pi from the selected executable; inspect its current skill/settings documentation and
  resource loader. Confirm additive `--skill` paths preserve trusted native project, shared-global,
  and unrelated package resources. Keep MPX pack output outside automatic discovery roots.
- Verify Claude `--add-dir` skill loading, native trust, and subagent availability on the installed
  version. Native main-session discovery and named-skill subagent preloading are separate test contexts.
- Map canonical exposure to supported native metadata/settings, not invented frontmatter semantics.
  For exact Claude name-only, evaluate session-only `skillOverrides` via inline `--settings`; verify
  nested merging and caller-supplied settings preserve unrelated overrides. Use the approved minimal-
  description approximation if this would require custom settings management. No persistent native
  settings edits are authorized merely by selecting this candidate.
- Propagate selected pack paths into Pi's SDK child `DefaultResourceLoader`; verify named-skill
  preloading as well as ordinary child discovery. Top-level wrapper arguments alone do not propagate.
- Exercise both accounts/harnesses, main checkouts and fresh worktrees, reload/restart, concurrent
  repository selections, default/empty/invalid selections, and unavailable fallback paths.
- Inspect actual initial catalogs and loaded body/support paths, including normal/name-only/explicit-
  only skills, mid-prompt and multi-skill requests, leading commands, and native Pi Tab completion.
  Files on disk or a successful loader unit test do not establish interactive behavior.
- Preserve project-owned links and unrelated entries. Verify fresh clones/worktrees can expose their
  project skills with a documented project-owned setup action where needed.

Use focused helper/configuration tests, native-loader tests, and interactive smoke checks. Validate
model/effort selection from execution evidence for retained named agents. Do not require the historical
platform's full test suite for this smaller implementation.

### Configuration

Use two configuration levels and no root-level config:

1. Temporary migration config at `%APPDATA%/mpx2/config.json`, later moved to
   `%APPDATA%/mpx/config.json` after preserving the old file.
   - personal/work Pi and Claude account roots;
   - personal/work domain roots using `${MPX_PROJECTS}` and `${MPX_WORK}`;
   - warning behavior and personal/work default packs;
   - optional native executable overrides.
2. Repository `mpxconfig.json`:
   - project ID;
   - repository provider and remote;
   - issue provider and provider-specific metadata;
   - package manager;
   - optional explicit pack selection, including an empty list.

Support GitHub, GitLab, and Gerrit repositories/reviews; GitHub and KanbanFlow issues. Defer the
local issue provider entirely: the user has not used it, so no data migration or import is needed.
If selected, report that local issues are unsupported rather than silently choosing another provider.
Repository and issue-provider selections are independent; neither selects credentials.

A registered project is a Git repository whose main checkout has a valid `mpxconfig.json`. Resolve a
linked worktree through Git's common directory. A missing or invalid manifest makes the directory
unregistered but does not silently guess metadata.

### Environment contract

Retain user-owned machine roots and executable overrides:

- `MPX_PROJECTS`, `MPX_WORK`, `MPX_CLONED`, `MPX_APPS`;
- `MPX_ONEDRIVE`, `MPX_AI_GENERATED`, `MPX_OBSIDIAN_VAULT`;
- `MPX_PI_EXECUTABLE`, `MPX_CLAUDE_EXECUTABLE` when needed.

Launchers set only stable runtime context such as `MPX_ACCOUNT` and
`MPX_ACTIVE_CONTENT_ROOT`. Remove session, route, executor, approval, artifact, digest, and ownership
environment protocols.

### Launch behavior

End-state commands are `mpx`, `pi`, `piw`, `cc`, `ccw`, and native escape hatch `xpi`, supported in
Git Bash only. Temporary `lpi` provides isolated legacy `mpx-pi` access during migration.

- `xpi` uses native `--no-extensions` without MPX injection; native skills/instructions remain enabled.
  Explicit extensions may still load. Display the effective loaded extensions and a discovery-disabled
  label rather than claiming the session is extension-free without evidence.
- Label managed launches MPX2 and temporary `lpi` launches legacy. Keep legacy extensions outside normal
  automatic discovery, avoid duplicate notifications, and fail clearly if legacy execution is unavailable.
  Do not build complex extension exclusion machinery or archive GitHub repositories automatically;
  remote archival remains a user decision.

- `pi` and `cc` select personal native roots.
- `piw` and `ccw` select work native roots.
- Wrappers select `PI_CODING_AGENT_DIR` or `CLAUDE_CONFIG_DIR`, stable content context, and visual
  label. They resolve the main checkout's `mpxconfig.json`, then add selected committed pack output:
  repeated Pi `--skill` directories without `--no-skills`, or Claude `--add-dir` roots containing
  `.claude/skills`. They never generate session-specific content or route Git/provider credentials.
  Direct native executable launches bypassing these wrappers do not automatically include MPX globals.
- Git author, SSH, provider CLI authentication, MCP, credentials, and native settings remain native.
- Personal-in-known-work shows an orange warning and waits for Enter; `Ctrl+C` cancels.
- Either identity in an unregistered directory shows a warning and waits for Enter.
- Work-in-known-personal is allowed without an identity warning.
- Missing executable or selected account root blocks only that launch with a direct diagnostic.

Before the final repository rename, the installed `mpx` command and all four wrappers switch
atomically to MPX2. Old normal entry points become dormant; the only temporary legacy launch exception
is isolated `lpi` for `mpx-pi`. Do not reactivate old setup, compilation, or automatic discovery paths. Disconnection is not merely editing `.bashrc`: inventory command resolution, installed
content links, extension/package loading, Orca Quick Commands, and any MPX-owned background startup
integration. Replace or disable only confirmed legacy entry points and dependencies; preserve native
accounts, settings, transcripts, unrelated processes, and any retained Agent Resurrect installation.
Verify fresh shells and reboot behavior. Do not disconnect the active installation during planning.

### Build, sync, and status UX

Package scripts call the same CLI implementation:

```bash
pnpm build
pnpm sync
pnpm status
pnpm setup-project C:/path/to/repo

mpx build
mpx sync
mpx status
mpx project setup C:/path/to/repo
mpx resume
```

- `build` deterministically refreshes committed per-pack skills and non-skill harness output.
- `sync` builds, then updates approved non-skill account-root entries and mirrors approved managed hooks.
  MPX skill packs are not linked into auto-discovered global roots.
- `status` is read-only and reports source/output drift, expected links, effective pack selection,
  path conflicts, and hook state.
- `project setup` manages links only. It does not edit `mpxconfig.json`, `orca.yaml`, or `.gitignore`.
- A sync failure reports exact source, destination, and action; independent entries continue and the
  command ends with a failure summary. Rerunning converges after correction.
- Never overwrite a non-owned conflict without interactive approval.

### Pi extensions

**Requirements grilling is complete.** The scope below and in `DECISIONS.md` is settled; remaining
package selection, adaptation, and acceptance are implementation work. Extensions are required, not
optional consequences of copying agent definitions. Keep original `mpx-pi` as the behavioral and
provenance reference, prefer a pinned upstream implementation, and obtain approval for any newly
proposed behavioral loss or custom adaptation rather than copying either legacy tree wholesale.

Native Pi does not supply all currently used capabilities such as subagents and MCP transport.
Retain approved native-account packages without restoring MPX's credential gateway. Distinguish
extension transport from safeguard policy and from Orca-owned status/worktree operations.

Classify each implementation as native core, unchanged third-party, locally modified third-party, or
custom before recommending migration. Verify upstream provenance, actual installed targets, and local
changes; neither a package name nor popularity establishes compatibility. Evaluate a pinned upstream
subagent package first; prefer native settings and supported interfaces, adding local adaptations
only for demonstrated gaps. Do not replace the installed fork until acceptance and approval.

Version one requires background subagents, result retrieval, steering, and visibility for both running
and finished agents, with actual model/effort, elapsed time, and token data where supported. Validate
these displays through completion, failure, and cancellation. Current-session finished history is
required; reconstruction after reload/resume is a desirable follow-up, not a cutover blocker. Show
unknown when data is unavailable, never the parent model or a fabricated zero. Foreground delegation,
nested orchestration, Orca worker panes, automatic child-worktree isolation, scheduling, and persistent
agent memory are not V1 prerequisites. Preserve deferred legacy source; do not remove optional upstream
features merely to defer their adoption. Native session persistence is not the deferred memory feature.
The user creates issue worktrees in Orca; Pi and its subagents stay in that selected checkout.
Do not migrate automatic main-session worktree creation/switching. Avoid overlapping parallel edits.

Remove footer port features and Pi's permanent shortcut-help rows while preserving the keyboard
shortcuts. Keep running agents in their live panel and use footer space for finished-agent information.
Preserve compaction visibility and align useful Claude/Pi information without assuming identical
runtime data. Keep native session restoration correctness in the resume acceptance gate rather than
rebuilding an extension-owned session service; optional footer history reconstruction does not weaken it.

Retain native-account MCP (`pi-mcp-adapter`), web access (`pi-web-access`), and structured question UI
(`rpiv-ask-user-question`) for cutover. Resolve effective package versions/load targets and test both
accounts without silent upgrades, credential routing, or unrelated settings changes. Retain
model-generated Pi conversation titles using an explicitly configured lightweight model/effort;
verify the suggested Codex Luna/low choice against native model availability. On failure, derive a
short title from the first prompt without selecting another model, interrupting work, or overriding
manual naming.
Manual development-server startup in Orca is sufficient for V1: do not port the custom Pi
`dev_server` process manager. Update retained skills/instructions that assume that tool to explain
project commands and when to ask the user to start a server; do not replace it with an opaque
background process or recreate a manager under another name.

Use native `treeFilterMode: "no-tools"` in personal/work Pi settings. Both accounts' newline action
keeps Shift+Enter and Ctrl+J and adds Ctrl+Enter. The user confirmed Orca still fails to deliver
Ctrl+Enter as newline, including in extension-free Pi; scrolling and tree filtering work.
Defer the Orca fix: its Windows routing grants Pi Shift+Enter CSI-u but lacks Pi-specific
`ctrlEnterEncoding: 'csi-u'`, allowing Ctrl+Enter to fall back to ordinary Enter. The installed Pi
decoder accepts the correct CSI-u sequence. Changing terminal shortcut priority does not fix this
route. Keep the Pi binding and use Shift+Enter or Ctrl+J for now. A later Orca change needs focused
routing regression tests and installed-app acceptance; no Orca source/deployment change is approved.

Use native Pi tool rendering for V1. Do not migrate the custom `pi-tool-display` fork at cutover;
preserve its source and dirty changes. Keep the separately approved footer and subagent visibility
work. Verify native embedded working status, clickable output, diffs, navigation, and error backgrounds
without wrapping built-in execution solely for display. The native comparison and scrolling trial
are documented in [extensions/README.md](extensions/README.md); they do not replace active launchers.

Apply the custom fullscreen wheel adjustment only in Windows Terminal outside Orca; use Pi's native
scrolling for Orca and unknown hosts. Orca markers take precedence over inherited `WT_SESSION`.
Test fresh launch and reload in both terminals; do not compensate by increasing Orca's TUI multiplier.

Pi status must include outstanding subagents and explicitly tracked background work. The installed
Orca Pi hook observes the parent lifecycle without the subagent pending-work aggregate; verify the
reported premature-done sequence with disposable sessions before selecting an upstream hook improvement
or narrow adapter. Keep a single authoritative status path and let Orca own desktop notifications for
whole-session done or human-needed events. Exercise child completion while peers/parent remain active,
queued follow-ups, questions during background work, cancellation, and reload with no duplicate alerts.
Evaluate Orca's native terminal-attention option before adding custom visual attention. Fine-grained
labels and Windows taskbar flashing require capability validation, not an assumed settings toggle.

**Optional UI follow-up:** evaluate `pi-zen-mode` for message-focused completed-round folding. It is
not a V1 dependency or approved installation: the inspected version also hides selected live output,
patches internal renderers, and documents older-Pi compatibility. Prefer an upstream option supporting
live current work with folded completed rounds. Keep this presentation-only: no context pruning,
transcript rewriting, or loss of accessible original results. Revisit richer rendering only after
the native V1 baseline, not as a cutover prerequisite.

#### Extension migration inventory

This carries the completed grill's capability dispositions into implementation. Paths are relative
to `$MPX_PROJECTS/mpx-pi/extensions/` (original) and
`$MPX_PROJECTS/mpx/runtimes/pi/extensions/` (current) unless specified. Source observations are not
installed acceptance. Retain required daily behavior before cutover, preserve unrelated native
settings/packages, and verify that no approved adapter imports archived checkouts or removed MPX
services. Implementation choices inside the approved scope do not reopen requirements grilling.

| Capability | Source / comparison | Settled V1 disposition | Remaining implementation evidence |
| --- | --- | --- | --- |
| Background launch/results/steering | `subagents/index.ts`, runner, manager; original upstream fork, later resource/model changes | Required; evaluate pinned upstream first | Concurrent execution, cancellation, steering, consumed results and notification ordering |
| Model/effort and named definitions | `model-resolver.ts`, `invocation-config.ts`, `model-scope.ts`, `custom-agents.ts`; MPX adds compiler overlays/file checks | Native definitions plus approved canonical metadata projection; no manifest authority | Record actual model/effort; native precedence, approved links, tool grants, reload |
| Fresh/inherited/resumed child context | `subagents/context.ts`, runner | Evaluate upstream behavior without MPX session storage | Account/context isolation; no stale prior-run results; saved-state fidelity |
| Nested delegation | `subagents/nested-tools.ts`; already upstream, later scope fixes | Future improvement, not prerequisite | If adopted, depth/ownership/tool boundaries and child cancellation |
| Scheduling | `schedule.ts`, `schedule-store.ts`; original capability, later lifecycle checks | Not V1 prerequisite; preserve source | If adopted, opt-in behavior, reload, conflicts and parent-exit semantics |
| Persistent agent memory | `memory.ts`, later `safe-directory.ts` | Not V1 prerequisite; distinct from native sessions | If adopted, user/project/local and account/path separation |
| Child worktree isolation | Runner/manager and `worktree/`; legacy placement dependency | No automatic child checkout creation in V1 | Agents stay in user-created Orca worktree; avoid overlapping edits |
| Named-skill preload | `subagents/skill-loader.ts`, child `DefaultResourceLoader` | Approved selected-pack consistency required | Explicit child pack propagation, preload lookup, linked/native project resources, concurrent selections |
| Fleet/conversation UI | `subagents/ui/`; original widget/menu with local changes | Required running/finished visibility, upstream-first | Actual model/effort/time/tokens, headless behavior; current-session history only |
| Old namespace commands | `mp-namespace-commands.ts`, `kf-namespace-commands.ts`; replaced in MPX | Replace with approved native skill commands | Native Tab completion and explicit-only invocation; no neighboring-checkout imports |
| Managed catalog/reference expansion | Added `canonical-skills.ts`, `skill-references.ts` | Native additive discovery replaces custom aliases/manifests | Approved exposure and main/child discovery matrix |
| Footer/editor | Original absolute Claude helper imports; current `footer.ts`, local `lib/` and themes | Adapt useful display; remove ports/help rows and obsolete identity/provider state | Native editor behavior, completed-agent unknown fields, compaction, account labels |
| Automatic titles | `auto-title.ts`; substantially retained | Configured lightweight model/effort plus prompt-derived fallback | Availability, manual-name preservation, bounded request, failures and session switching |
| Fullscreen scrolling | `fullscreen-scroll-speed.ts`; original unconditional adjustment | Windows Terminal-only trial; native Orca/unknown behavior | Trial tests/reload plus physical terminal comparison; old bundled override not patched |
| Compaction guidance | `compact-instructions.ts`, local `config/COMPACT.md`; former environment override | Governed by approved hook policy | Canonical source, native fallback and live preservation, not stale account overrides |
| Main-session worktree switching | Original setup helper; current MPX CLI and managed-launch restrictions | Do not migrate; user creates/opens issue worktree in Orca | No hidden session jumping or legacy worktree-service dependency |
| Development-server manager | `dev-server/`; retained with footer events | Do not migrate; manual Orca/project startup sufficient | Update tool assumptions in skills; no replacement opaque background manager |
| Terminal progress | `terminal-progress/`; activity implementation changed | One aggregate status path feeding Orca | Parent waiting on children remains working; question and background-work transitions |
| Flash/beep notifications | Original guard notification path; current `notifications.ts` and Windows script | Orca-only alerts, no MPX fallback | Disconnect active duplicate registrations; preserve user-owned sound; no child/cancel alerts |
| Guards and machine-root context | Original external hooks; current local `guards/` and trust gating | Approved safeguards/thin transports; hooks retain their own policy/timing | Installed personal/work interception and allowed root inheritance; Manual is not proof of Pi permission dialogs |
| Agent Resurrect registration | `agent-resurrect.ts`; current MPX removed original ownership fields | Resume follow-up owns adapter selection; no blind rollback | Test installed variant and ownership compatibility with native session restoration |
| MPX session lifecycle bridge | Added `session-lifecycle.ts` with session/contracts dependencies | Do not migrate legacy session service | No old lifecycle publications, registry reads, or runtime ownership environment |
| Extension composition | Added `index.ts`, package/config/helper bundle | Plainly owned adapters in the single MPX2 package | Native load/reload, no duplicate registration, source/install/archive independence |
| MCP transport | Native `pi-mcp-adapter` | Retain for cutover without MPX credential routing | Actual loaded version, account configuration, child availability and errors |
| Web access | Native `pi-web-access` | Retain for cutover | Resolve account artifact mismatch, search/fetch and intended child availability |
| Structured question UI | Native `@juicesharp/rpiv-ask-user-question` | Retain for cutover | Choices/previews/custom input/cancel and child-to-parent UI behavior |
| Tool display | Native settings select modified `pi-tool-display` worktree, not just npm | Native Pi instead for V1; preserve fork/dirty fixes | Remove only its confirmed loading entry at cutover; do not alter unrelated packages |
| Machine-root compatibility shim | Installed `mpx-directory-environment.ts`; work copy re-exports personal | Hook/environment implementation check, not a new routing layer | Verify approved wrappers preserve roots before retiring old-executor workaround |
| Orca status/prefill/titlebar | Installed files marked `@orca-managed-pi-extension` | Preserve Orca ownership and approved account mirroring | Work account lacked these files at audit; verify current installed state |

#### Preserved extension evidence and acceptance gaps

- Audit references: original `mpx-pi@8464b23`; current `mpx@b8e323e` with dirty surrounding files.
  Preserve current dirty intent and inspect history before assuming original paths predate MPX changes.
- Subagent provenance: `@tintinweb/pi-subagents` `0.14.3` at
  `8976c63f9857fb308926dd1d7369c2b7e059ffdc`, imported by `mpx-pi@36731fe` with initially unchanged
  TypeScript. `subagents/VENDORED.md` records later model snapshots, widget columns, notification
  batching and cancellation changes. Do not attribute upstream nesting or safety checks solely to MPX.
- Upstream candidate inspected at
  [e955e29c51b7a6cce37e1108cd2d6c57a77e151c](https://github.com/tintinweb/pi-subagents/tree/e955e29c51b7a6cce37e1108cd2d6c57a77e151c)
  declares version `0.19.0` and Pi peers `>=0.84.0`. Repository metadata does not prove published
  artifact contents or runtime compatibility. Installed Pi inspected was `0.85.1`.
- Upstream defaults to background execution. Running rows can show model/effort with `showModel`,
  initially off; finished widget rows omit model/effort/tokens although other views expose them.
  Validate the approved finished footer against real lifecycle data before proposing a fork.
  Upstream includes internal spawn-option stripping, dynamic tool-scope enforcement and schedule
  conflict checks, so these need not become locally maintained patches.
- Upstream `rememberAgents` saves native child sessions and captures actual model/effective thinking,
  but this does not prove cold restoration or correct account/last-state fidelity. Selected-pack
  propagation remains unverified; lack of a literal `additionalSkillPaths` is not proof of no alternative.
- Current child-loader anchor: `subagents/agent-runner.ts:785–918`; agent overlays:
  `subagents/custom-agents.ts:94–265`; named preload: `subagents/skill-loader.ts:33–118`.
  Old managed skill wiring is in `canonical-skills.ts` and `skill-references.ts`; launch resource/env
  wiring is `$MPX_PROJECTS/mpx/runtimes/pi/runtime-pi/src/index.ts:440–510`.
- Inspected native account artifacts: MCP `2.32.1`, question UI `2.9.0`, personal web `0.28.0`,
  work npm web `0.27.0` with generated web copy `0.28.0`. Resolve effective loading, not just package
  ranges or artifact presence; unchanged third-party bytes have not been independently established.
  Empty settings `extensions` arrays do not disable directory discovery.
- Native settings explicitly load `$MPX_CLONED/pi-tool-display.worktrees/feat/compact-tool-shell`
  at inspected `ebe25f4`. Preserve the dirty full-execution-context forwarding fix and its test even
  though the fork is not selected for V1; dropping that fix in a future revival can lose native
  Bash session/model context and image-capability handling.
- Installed personal/work Agent Resurrect copies matched original `mpx-pi`, not current MPX's
  ownership-stripped variant (`agent-resurrect.ts:91–106`; original ownership history `cadba39`).
  The separate resume investigation must use actual installed targets, not inferred current sources.
- Pi's existing finished footer is in-memory; Claude's tally persists separately. Pi compaction
  entries lack Claude's post-compaction token field, and its reason mapping is process-local.
  Missing data must remain unknown; optional history reconstruction must not fabricate parity.
- The installed machine-root shim reads approved HKCU roots because the old executor dropped them;
  the work-account file re-exports the personal file. Verify wrapper inheritance before retiring it.
  Distinguish this environment repair from model-context root injection governed by hook policy.
- Complete personal/work load, native reload, error/cancellation, concurrent-session, named-agent
  model/effort and child-loader tests. Confirm no imports or runtime reads of old services, launch
  bindings, generated session prompts/catalogs, or archived paths. Native packages and Orca-managed
  files remain user/Orca-owned except for explicitly approved managed entries. No full extension
  cutover or resume acceptance has been claimed; scoped trial evidence is in `extensions/README.md`.

### Resume

Correct resume is critical and blocks cutover. The core need is recent/unfinished sessions, not an
MPX session database or archival browser. The approved starting interface is `mpx resume`, reading
native stores across all account roots, showing recent sessions with current-project priority and
clear account/harness labels. Keep unfinished or explicitly saved sessions reachable.

- Restore the correct native session, cwd/worktree, harness, account, provider/model, and effort.
  Verify actual restored state; selecting the right account root alone does not prove correctness.
- Claude `--resume <native-id>` and Pi `--session <native-session-file>` are candidate native resume
  primitives. Determine which additional arguments are needed without overriding saved state with
  launcher defaults. Never silently substitute an unavailable model or effort level. If an older
  transcript lacks recoverable state, require explicit user selection of the unknown model/effort
  fields before launch and label it as an override rather than recovered state.
- Native transcripts remain authoritative; the MPX picker reads them in place, not into a database.
- Keep direct account-specific native resume usable and expose the selected resume interface through
  an Orca Quick Command.
- Do not use Orca history-row resume for work accounts until wrapper/root and other required state
  restoration are verified. Native process visibility does not prove recoverable account/model state.
- Retain Agent Resurrect for evaluation. Try its current native-Pi workflow before changing it; capture
  actual warnings/failures and compare history only when needed. The reported Windows Terminal baseline
  does not prove a regression cause. No blind rollback or automatic retirement is authorized.
- Saving/restoring open groups is an optional follow-up. Investigate Agent Resurrect launching native
  sessions through Orca's supported interfaces. Restoration outside Orca without orchestration is an
  acceptable candidate if explicitly described and agreed; do not silently claim orchestration resumed.

Further resume experiments do not block starting migration. Native resume acceptance remains a
cutover gate; Agent Resurrect integration and optional groups need not be resolved before building.
The native picker remains the baseline, not a reason to reject a simpler verified external solution.
No further resume interview is required before implementation; obtain user agreement only for a
material change to this contract or a fallback that changes intent.

#### Resume implementation and remaining acceptance

- Read native transcripts in place, following the active branch for model/effort. Avoid launcher
  defaults overriding saved state. Installed Pi can fall back when a model is unavailable and clamp
  unsupported effort; detect those cases rather than treating a native launch as successful fidelity.
  Claude model restoration has launch/environment exceptions; verify saved effort on the deployed version.
- Missing account roots/executables, invalid sessions, and missing/moved worktrees require direct
  diagnostics. Never silently change accounts, substitute state, or create a new conversation while
  claiming restoration. Ask before a changed cwd or other fallback, distinguishing missing historical
  metadata from an unavailable resource. Do not infer required state from titles or process arguments.
- If Agent Resurrect is retained, inspect `src/scan.js`, `src/resurrect.js`, `src/lib/native-launcher.js`,
  and the installed Pi registration extension. Managed/unknown ownership filtering can hide native
  registrations; native launch scripts bypass aliases and clear MPX context. Preserve approved account
  and content selection without legacy lifecycle dependencies. Do not replay saved skip-permissions flags.
- Orca `terminal create` is a tested terminal backend, not Run/worker recovery. Use an explicit workspace
  selector and verify cwd, account labels, and command/environment delivery. Keep work-account history-row
  restoration unaccepted until tested. External native restoration remains an explicitly agreed option;
  worker/Run recovery belongs to the later Orca orchestration investigation.
- Test personal/work Pi and Claude through ordinary wrappers and supported Orca paths. Compare intended
  and observed session ID/file, account root, executable, cwd/worktree, provider/model, and effective effort.
  Use recognizable markers and mid-session state changes, including launch defaults conflicting with history.
- Cover normal close/reopen, native process exit, Orca restart, reboot and interrupted sessions; real
  worktrees and moved/missing cwd; unavailable model/effort/account/executable and invalid transcripts;
  multiple sessions in one cwd, already-open sessions without duplicate launches, and older transcripts
  containing legacy MPX instructions. Verify current approved resources with legacy entry points disabled.
- Use disposable fixtures and human verification where needed. Never copy account roots/credentials or
  rewrite real transcripts for testing; coordinate reboot separately. Test Agent Resurrect and group
  save/restore only if selected, without making optional groups a native-resume prerequisite.

#### Existing native Pi evidence

The disposable Pi `0.85.1` pilot used personal/work native roots in place, changed Luna/medium to
Sol/low, exited, and resumed exact files without model/effort flags. RPC state and actual marker
responses preserved session identity, cwd, provider/model, and effort. Native TUI continuation worked
through Windows Terminal and Orca `1.4.200`; Orca screen reads verified the footer/marker, and the user
confirmed Windows Terminal Sol/low. Reopening user-closed Windows Terminal pilots also preserved
continuity. Account settings were unchanged during RPC testing and startup defaults after TUI launch.

This was a stripped-down native baseline with tools/extensions disabled, not a blank account:
`APPEND_SYSTEM.md` still loaded and Windows Terminal used its default profile. It did not validate
managed content/extensions, ordinary wrapper parity, Agent Resurrect discovery, Claude, real worktrees,
unavailable-resource handling, reboot, or Run ownership. The remaining checks above still apply.

### Orca integration

Source authority for investigation is local Orca commit
`729491597f33031089148bc2fba41a99e0b95de7` under `C:/_MP_github_cloned/orca`.

- Built-in Orca Pi and Claude cards launch personal accounts.
- Project Quick Commands launch `piw`, `ccw`, and `mpx resume` in clearly labeled tabs.
- Use labels such as `WORK · Pi` and `WORK · Claude`, native agent icons/status, and repository badge
  colors. Do not paint terminal backgrounds or depend on Windows Terminal color helpers.
- Configure worktree roots with nesting and a per-project base such as `../worktrees`, producing:
  - `C:/_MP_projects/worktrees/<repo>/<worktree>`;
  - `C:/_MP_work/worktrees/<repo>/<worktree>`.
- Repository `orca.yaml` may call `mpx project setup . --non-interactive`; MPX reports the snippet but
  does not write the file.
- Use project/default terminal commands to start development servers. Let projects/frameworks select
  free ports and print URLs. Orca discovers listeners, associates them with worktrees, and presents
  clickable URLs; MPX keeps no port registry.

### Orca hooks

Orca owns status hooks. MPX sync mirrors only Orca-managed material from personal to work roots:

- merge the exact Orca-managed Claude hook entries while preserving unrelated settings;
- copy only Pi files carrying `@orca-managed-pi-extension`;
- never link personal and work account roots;
- never copy credentials, histories, caches, or unrelated extensions.

The work Claude root already has Orca registrations. The work Pi root currently lacks Orca's status,
prefill, and titlebar extensions and must be tested after synchronization.

### Hook migration and acceptance

Hook requirements grilling is complete. [DECISIONS.md](DECISIONS.md#approved-safeguards) owns safeguard
policy; its retained/retired hook decisions also govern the following implementation ledger. Approval
is not installed acceptance. No lifecycle or operational hook migrates implicitly.

| Behavior / legacy source | Implementation and cutover requirement |
| --- | --- |
| `dangerous-command-guard` | Required: shared policy with thin Claude/Pi adapters; protected branch and allowed-cleanup fixtures; infrastructure failure blocks the affected invocation |
| `enforce-pkg-mgr` | Required: deterministic project evidence and effective-directory handling, no `mpxconfig.json` authority or stylistic warnings |
| Staged-secret portion of `pre-commit-gate` | Required: standalone bounded scanner, approved exclusions and redacted diagnostics; incomplete scans warn/allow unless a positive finding was detected |
| Full project checks / commit-message warnings | Retire bundled execution after standalone secret protection is verified; preserve repository-native gates and project-specific instructions |
| `fallow-gate` | Required for opted-in repositories before legacy disconnection: project-owned push-only audit, bounded output, approved failure/deadline behavior |
| `format-lint-file` | Optional at cutover: configured formatting only, awaited and reported; stop child processes before returning; disable legacy hook if replacement is deferred |
| `post-bash-context` | Retire PR-existence lookups, install reminders, and repeated PR URLs without replacement |
| `compact-instructions` | Required: shared canonical instructions merged with manual input, native fallback, actual manual/automatic summary-preservation tests |
| Per-prompt style / deprecated post-compaction bundle | Retain concise style reinforcement in both runtimes; retire the old bundle; add further quality/tool reminders only if retention tests justify them |
| `machine-paths` | Required: approved root allowlist delivered on launch/resume/compaction and inherited by subagents without repeated prompt noise |
| Completion sound/flash | Orca-owned; verify whole-session/question behavior and disconnect duplicates; preserved tada sound is already selected by the user |
| Herdr / deprecated custom terminal-title helpers | Retire; preserve native titles and approved Pi title behavior |
| Pi terminal progress | Retain only if live Orca tests establish a signal dependency; use the single aggregate status path |
| MPX session recorder | Do not migrate; leave tested legacy source retirement patch unactivated rather than publishing a legacy release solely for it; preserve records/transcripts |
| Runtime artifact/content-integrity validation | Do not migrate, consistent with the architecture's exclusion of runtime integrity authority |

Use `$MPX_PROJECTS/mpx-claude-code/plugins/mp/hooks/hooks.json` and adjacent scripts for original
Claude evidence; compare `$MPX_PROJECTS/mpx/runtimes/pi/extensions/guard-hooks.ts`, its `guards/`, and
`$MPX_PROJECTS/mpx/packages/runtime-hooks/src/index.ts` for current policy/transport differences.
Orca integration evidence is in `$MPX_CLONED/orca`; recheck deployed behavior rather than treating
source, generated output, account registration, or Manual labels as proof of safeguard coverage.

Acceptance checks:

- Test equivalent benign and destructive command fixtures across Claude/Pi and Windows/Git Bash:
  quoting, multiple targets, wrappers, traversal, PowerShell, compound commands, and directory changes.
  Include generated-root ancestry (`node_modules/.vite`), outer `2>NUL` redirects around Windows
  commands, and non-Bash file-writing paths. Test protected default/named branches and feature leases.
- Inject failures independently per hook. Dangerous-guard faults block the affected command; secret
  scanner and Fallow infrastructure faults use their approved visible fail-open policies. Never crash
  the harness or report incomplete scans/audits as clean.
- Measure total secret-scan and formatting deadlines, including process startup, on large inputs.
  Verify no formatter survives a timeout to race subsequent edits and no background mutation is hidden.
- Verify compaction instructions, style reinforcement, and machine roots in personal/work Claude/Pi,
  including manual instructions, automatic compaction, resume, missing-source fallback, and subagents.
- Verify installed interception and one intended registration per retained behavior across supported
  launchers/accounts. Preserve unrelated user and Orca hooks; isolate temporary `lpi`. `mpx status`
  reports installed, missing, conflicting, and stale state without mutation.
- Bound diagnostics and inspect only each hook's required inputs; never read unrelated account
  credentials/transcripts or print secret matches. Preserve unrelated files during acceptance.
- Run focused tests before applicable MPX2 repository checks. Test notification/status behavior through
  the aggregate Orca acceptance matrix; native resume/save warnings stay in the separate resume follow-up.

## Migration phases

1. **Bootstrap:** initialize the private repository; add one package, tests, canonical layout, and
   the minimal config/CLI shell.
2. **Compiler:** implement metadata/placeholder projection and committed-output drift tests.
3. **Discovery and account installation:** prototype the approved additive wrapper mechanism, then
   implement committed per-pack output, status, exposure, repository selection, main-checkout worktree
   resolution, and Pi child-loader propagation without touching active legacy launchers. Preserve
   non-skill installation concerns; do not install MPX skills into auto-discovered global roots.
4. **Extensions, launch, and resume:** implement the settled extension scope and resolve the separate
   resume follow-up; complete extension acceptance, wrappers, warnings, labels, native-root selection,
   and recent-session resume with model/effort verification.
5. **Orca pilot:** configure worktree roots, personal agent cards, work Quick Commands, project setup,
   hook mirroring, dynamic dev ports, and visual labels.
6. **Daily-core adaptation:** port issue/PR/CI, execute, review, check-fix, commit variants, ship,
   design init/brief/mockup/refine, grill, handoff, and every required agent/reference/script.
7. **Hooks:** implement the settled hook ledger and complete its acceptance checks, including required
   safeguards, compaction, machine roots, style reinforcement, and conditional Fallow/Orca integration.
   Track optional formatting separately; do not reopen settled policy merely because tests remain.
8. **Early operational cutover:** run the full identity matrix, then atomically point `mpx`, `pi`,
   `piw`, `cc`, and `ccw` at MPX2. Stop using old MPX entirely.
9. **Complete inventory:** evaluate every remaining current skill. For each conflict, behavior loss,
   Orca replacement, or discard proposal, stop and obtain user approval. Adapt before exposing.
10. **Final rename:** after every retained skill is resolved, archive the explicitly retired MPX,
    `mpx-pi`, and `mpx-claude-code` checkouts intact under `C:/_MP_projects/_archive/`. Preserve dirty
    state and old histories; exclude any still-used Agent Resurrect installation. Rename `mpx2` to
    `mpx`, keep its fresh Git history authoritative, rerun sync to repair links, and re-run acceptance.
    Remote renaming/archival requires confirmed targets, not assumptions from the local folder rename.
11. **Sandbox follow-up:** after core cutover, pilot a persistent Windows VM through Orca SSH. Treat
    Windows SBX as later experimental work.

## Required migration inventory

Create a durable table before porting content with one row per current skill, agent, instruction,
rule, helper script, hook, extension, and required native package. Include original extension
counterparts and any installed-only capability that daily workflows actually use. Include original
non-archived skills under `mpx-claude-code/plugins/mp/skills`, `plugins/gh/skills`, and `local/skills`,
resolved from `MPX_PROJECTS`; exclude its `deprecated` content. Follow every retained skill's templates,
references, scripts, agents, and shared instructions, updating provider assumptions throughout.
Keep shared support files inside MPX2 so runtime references do not depend on neighboring or archived
repositories. Use original KanbanFlow CLI workflows as provider-specific evidence where needed:

```text
identity | current source | original counterpart | behavioral differences | dependencies |
disposition | required rewrite | acceptance evidence | user approval
```

Allowed dispositions are `daily-core`, `adapt-later`, `replaced-by-orca`, and `archive`. No item may
be archived or materially reduced without explicit user approval.

## Early cutover acceptance

- `pnpm build`, `pnpm run typecheck`, tests, and `pnpm status` pass; a repeated build leaves Git clean.
- Committed Claude and Pi projections differ only where declared. Frontmatter, local references,
  executable helpers, and representative native-provider workflows pass focused checks.
- Repository selection reduces MPX global metadata while preserving project and independent native
  skills. Verify personal/work defaults and explicit repository replacement. Invalid configuration
  warns and uses defaults; unavailable fallback paths warn and use native skills only. Direct native launches
  need not apply MPX filtering.
- All four launch commands use the intended native account and preserve Manual permission prompts.
- Personal-in-work and unregistered-directory prompts require Enter; `Ctrl+C` cancels.
- Orca reports working/waiting/done/permission status for all four launch paths.
- Global and repository skills each appear once; project-owned skill links work in the main checkout
  and a new Orca worktree. Native accidental-collision behavior is sufficient; filesystem link
  conflicts do not overwrite unrelated entries. Test shared global paths and native project trust.
- Per-skill exposure has the agreed catalog/body behavior. A prompt naming multiple discoverable
  skills can load them in the requested order; explicit-only skills remain explicitly invocable.
- Main sessions and subagents observe the same allowed global packs and native project discovery.
  Concurrent repositories with different narrowing do not change one another's resources.
- Representative daily-core workflows, specialist agents, and approved extensions/packages work
  without imports, launches, or runtime reads from archived MPX checkouts.
- The selected resume implementation restores recent/unfinished sessions across every account/harness
  combination after restart and reboot, including correct cwd, provider/model, and effort. Record
  actual restored state and test unavailable resources and retained legacy transcripts.
- A dev server in two worktrees receives separate free ports and both URLs appear under the correct
  Orca worktree.
- Approved prerequisite safeguards satisfy their policies in `DECISIONS.md`, including negative cases,
  compound commands, failure paths, bounded secret-scan latency, and installed launcher/account coverage.
- Legacy command, content, extension, and background startup paths are disconnected at cutover;
  fresh shells and Orca invoke the intended wrappers without disturbing retained native tools.

## Rollback

- Preserve the current dirty checkouts and native account data until final acceptance.
- Before early cutover, record current aliases and installed link targets.
- Rollback changes all five installed commands together; never mix old launchers with new content
  setup.
- Hook rollback removes only entries/files proven MPX2- or Orca-managed.
- Never delete native credentials, transcripts, account settings, or unrelated skills.

## Explicit non-goals

- MPX-owned worktree, terminal, status, notification, dashboard, dev-service, or port managers.
- Per-session content generation or content integrity authority.
- MPX session registry, PID tracking, workflow notes, or resurrection approvals.
- Git/SSH/provider/MCP credential routing.
- Full installer transactions, receipts, release stores, rollback journals, or adoption frameworks.
- Custom `/mpx:` aliases, command namespace machinery, or collision handling.
- Local issue-provider implementation or migration during core cutover.
- Automatic Agent Resurrect retirement, speculative rollback, or mandatory group-snapshot features.
- Sandbox implementation before core cutover. In the later sandbox pilot, verify content/support-path
  mounts and native tool/authentication access inside the environment; host links are not portable mounts.
- Orca-specific rewrite of `execute` in this migration; investigate it separately.

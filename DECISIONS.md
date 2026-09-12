# Migration decisions

## Authority

This file records confirmed current choices. [MIGRATION_PLAN.md](MIGRATION_PLAN.md) owns implementation
work, validation, and cutover gates. Unfinished grill documents prepare remaining decisions; they are
not parallel specifications. Consolidate confirmed answers into these authorities and remove completed
grills after preserving their remaining actionable checks. Keep current requirements, not session
chronology or superseded alternatives. Recommendations alone do not constitute approval.

## Scope and ownership

- Build a fresh private TypeScript/pnpm package in `mpx2`, eventually renamed to `mpx`, with a private
  GitHub repository. Preserve old histories and confirm remote targets before changing them.
- Orca owns worktrees, terminals, status, notifications, review/orchestration UI, and operational visibility.
  MPX owns canonical content, a small compiler, account wrappers, project metadata, approved extensions,
  native-session resume, and individually approved safeguards.
- Treat the current dirty MPX content as the newest skill intent. Compare original Claude/Pi sources for
  useful mechanisms and guidance. Inventory non-archived workflows and their support files; adapt
  dependencies before exposing them. Removal or material behavioral reduction requires user approval.
- Commit deterministic Claude/Pi output. Projection maps metadata and declared named placeholders;
  support files and remaining body content are preserved. Keep canonical specialist agents and semantic
  model classes, with generated agent names `mpx-*`.
- Use machine-root variables and stable account/content context. Keep runtime design free of session
  registries, per-session prompt generation, immutable manifests, and content-integrity authority.
- User account/domain configuration and repository `mpxconfig.json` are the configuration levels.
  Native tools own Git/SSH/provider authentication and native account settings, including MCP settings.
- Repository/review providers are GitHub, GitLab, and Gerrit; issue providers are GitHub and KanbanFlow.
  The two selections are independent. Local issue-provider implementation and import are outside core scope.
- Public shell support is Git Bash. Projects select free development ports; Orca provides visibility.
  Use Orca labels/badges/status rather than terminal painting or MPX-owned port state.

## Skill discovery and exposure

- Repository pack filtering is required for context relevance, not access control. Store committed
  per-pack MPX output outside auto-discovered global skill roots. Wrappers add selected pack paths to
  native discovery without changing shared links or suppressing native project/independent skills.
- Repository `mpxconfig.json` selects packs; linked worktrees use the main checkout's selection.
  Without a selection, personal wrappers load development plus personal and work wrappers load
  development. Explicit selection replaces those defaults without account access restrictions.
  An explicit empty list loads no MPX globals while retaining native skills.
- Invalid configuration warns and uses wrapper defaults. Unavailable fallback pack paths warn and
  continue with native skills only. Direct native launches bypassing wrappers do not automatically
  include MPX globals.
- Reserve `mp-` exclusively for MPX global skills; projects use names outside that prefix. Commands are
  Claude `/mp-<name>` and Pi `/skill:mp-<name>`. Native accidental-collision behavior is sufficient;
  custom aliases and collision handling are outside scope.
- Each skill declares canonical exposure: normal advertises name/description with a lazy body;
  name-only supplies a name and reliable loading mechanism for mid-prompt references; explicit-only
  has no advertised context entry and requires only leading-command invocation. Personal skills
  default to explicit-only.
- Prefer native exposure controls. Pi may approximate name-only with a minimal generic description
  if context/loading tests pass. Claude may use the same approximation when exact native integration
  is disproportionate. Do not build a settings-management layer solely for name-only exposure.
- Explicit-only invocation by another skill or agent is optional only if straightforward; use
  name-only for supporting skills that need discoverability otherwise.
- Restart/reload is sufficient for discovery changes. Projects own links needed to expose shared
  `.agents/skills` to harness-native discovery. MPX project setup is not required solely for skill linking.
- Preserve Pi Tab completion for native skill commands, using native completion where sufficient.
- Main sessions and subagents must receive consistent selected packs. Native trust rules and native
  project resources remain in effect. The approved additive design still requires installed-harness
  acceptance; approval of the design is not evidence that runtime behavior has passed.

## Launch, installation, and extensions

- Personal/work wrappers retain separate native roots and commands `pi`, `piw`, `cc`, and `ccw`.
  Personal-in-work or unregistered-directory launches warn and wait for Enter; Ctrl+C cancels,
  with no countdown. Work-in-personal is allowed without an identity warning.
- Resolve worktrees through their main Git checkout and valid project manifest. Orca owns placement
  and setup; MPX does not provide a worktree service.
- Build, sync, and status are explicit commands. Any retained project setup manages approved links
  only, without rewriting project, Orca, or ignore configuration. Sync failures are scoped and leave
  unrelated entries intact; unrelated link obstructions require approval before replacement.
- Mirror only Orca-managed hook material across native account roots, preserving credentials,
  settings, histories, and unrelated extensions.
- Pi extension requirements grilling is complete. Original `mpx-pi` remains the behavioral/provenance
  reference; prefer pinned upstream packages for implementation where they meet the approved scope.
  Preserve useful fixes and native-account packages without obsolete dependencies. New behavioral
  losses or custom adaptations still require approval; implementation acceptance is not yet complete.
- Classify extension provenance before selection: Pi core, unmodified third-party packages, modified
  third-party forks, and fully custom code. Prefer maintained native packages where they meet the need;
  evaluate local changes individually and scrutinize custom machinery. Popularity alone is not acceptance.
  Evaluate a pinned upstream subagent package first; add local adaptations only for demonstrated gaps.
  This is a prototype-selection decision, not approval to replace an installed package.
- Version one requires background subagents, result retrieval, and steering, with running and finished
  agents visible and model, effort, elapsed time, and token usage shown where supported by actual data.
  Separate Orca worker panes and foreground delegation are not version-one requirements. Nested
  orchestration and automatic child-worktree isolation are future improvements, not cutover blockers.
  Scheduling and persistent agent memory are also not V1 prerequisites. This does not authorize deleting
  legacy code or require stripping optional upstream features; native session persistence is distinct
  from cross-session agent memory.
- The user creates each issue worktree in Orca and launches Pi there. Do not migrate automatic
  main-session worktree creation/switching or automatic child-worktree creation for version one.
  Agents share the selected checkout; concurrent editing must avoid conflicting file changes.
- Remove port features and Pi's permanent shortcut-help rows from the footer, not the shortcuts
  themselves. Keep running agents in their live panel and finished-agent information in the freed footer
  space. Aim for consistent Claude/Pi information and retain compaction visibility.
- Finished-agent history is required during the current session only. Reconstructing it after
  reload/resume is a desirable follow-up, not a cutover blocker; correct native conversation resume
  remains independently mandatory. Show unknown for unavailable model, effort, elapsed time, or tokens
  rather than substituting the parent model or numeric zero.
- Retain MCP transport, web search/fetch, and structured question UI through native account packages
  for cutover, subject to effective-loading and compatibility checks. Preserve user-owned settings;
  package retention does not authorize MPX credential routing or silent version upgrades.
- Retain model-generated Pi conversation titles using an explicitly configured lightweight model and
  effort. The suggested Codex Luna/low combination remains subject to availability verification, not
  a hardcoded fallback. On failure, derive a title from the first prompt without switching models or
  blocking the session; preserve manually assigned names.
- Keep Ctrl+Enter in Pi's native newline binding alongside Shift+Enter and Ctrl+J. Defer the identified
  Orca Windows Ctrl+Enter routing fix; use Shift+Enter or Ctrl+J meanwhile. Do not change Orca source,
  deploy a modified app, or change global shortcut priority for this issue now.
- Use native Pi tool rendering for V1; do not migrate the custom `pi-tool-display` fork at cutover.
  Preserve its source and dirty changes, and leave the active installation unchanged until cutover.
  Keep native `treeFilterMode: "no-tools"` for message-focused navigation. Richer rendering and
  `pi-zen-mode` are optional future work, not V1 dependencies; display folding must not prune model
  context or rewrite transcripts. This does not retire the separately approved footer/subagent UI.
- Keep the three-line fullscreen wheel adjustment only in Windows Terminal outside Orca. Orca and
  unknown terminals use native Pi scrolling; positive Orca identification overrides inherited Windows
  Terminal markers. Validate actual wheel behavior in both terminals.
- Pi activity must aggregate main-agent, subagent, and explicitly tracked background work before
  reporting completion. A parent waiting for children is still working. Human-needed state remains
  distinct. Prefer one authoritative integration feeding Orca, not competing status writers.
- Orca owns desktop attention for whole-session completion and human-needed events. Individual child
  completions must not independently produce desktop sound/flash, and pending follow-up work must not
  cause transient done notifications. Evaluate native terminal attention first; richer state labels
  and taskbar flashing remain capability-dependent, not assumed available.
- Manual development-server startup through Orca/project terminal commands is sufficient for version
  one. Do not migrate Pi's custom development-server process manager; agent-controlled start/restart/log
  operations are not cutover prerequisites.

## Resume and cutover

- Correct recent/unfinished-session resume blocks cutover. Restore harness, account, native session,
  cwd/worktree, provider/model, and effective effort; verify actual state after reboot. When an older
  transcript lacks recoverable model or effort, show the unknown fields and require explicit user
  selection before launch. Label that selection as an override, not recovered state.
- A combined recent-session picker with project priority is the starting interface. Native transcripts
  remain authoritative; a simpler verified external solution is eligible without building a session archive.
- Try the current Agent Resurrect native-Pi save/restore workflow before changing it. Investigate
  observed save warnings or restore failures against the reported reliable baseline, not speculative
  causes; no repair may be necessary. Saving/restoring open groups is optional. External native
  restoration without Orca orchestration remains a candidate requiring agreement after evidence.
- Switch daily-core launchers and `mpx` together after acceptance. Disconnect confirmed legacy command,
  resource, and background entry points while preserving native installations and retained tools.
  `pi` launches MPX2; `xpi` uses native `--no-extensions` without MPX injection, retaining native skills
  and instructions. Accept explicitly loaded extensions rather than building complex exclusion logic,
  but show the actual loaded extensions at startup, never claim none without verification.
- Provide temporary isolated `lpi` access to legacy `mpx-pi`, outside normal automatic discovery and
  without duplicate legacy/Orca alerts. Show clear MPX2, native discovery-disabled, and legacy startup
  labels. An unavailable legacy installation fails clearly instead of silently switching modes.
- Disconnect old systems when MPX2 is operational. GitHub archival remains user-owned and requires
  further evaluation; do not archive repositories automatically.
- Final folder rename waits until all retained skills are resolved. Archive only explicitly retired
  checkouts intact under `$MPX_PROJECTS/_archive`, preserving dirty state and old histories.
- Hook behavior and cutover requirements are settled; implementation and live acceptance remain.
  Use one policy definition with thin Claude/Pi transports, not wholesale copies of legacy hook
  directories. New behavioral reductions or scope changes require approval.
- Remove automatic project-check execution from the global MPX commit hook. Typechecking is a
  project-level concern: project instructions or repository-native hooks define applicable commands;
  do not impose a global `pnpm run typecheck` mandate or guess substitutes when that script is absent.
  Remove any such global instruction if found. Preserve repository-owned hooks without bypassing them.
- The five-second budget applies to the MPX commit hook, not repository-native gates. Add no recent-check
  cache or commit certificate. Retire bundled project-check execution at cutover only after verifying
  the standalone secret scanner.
- Remove global commit-message format and subject-length warnings at bundled-gate cutover. Retain
  conventional-commit guidance; repositories own any deterministic message enforcement. No replacement
  global warning hook is required.
- Retain Fallow as a global integration only for repositories explicitly opted in through recognized
  repository configuration. Run it before push, not commit, using only the project-owned script or local
  dependency; never use a global executable, automatic download, or global version floor.
- A valid failing Fallow verdict blocks push. Missing installation, malformed output, process failure,
  or the thirty-second deadline visibly warns and allows without claiming success or retrying. Emit a
  bounded diagnostic and project-owned remediation command, not complete audit JSON.
- Remove Fallow's VS Code bypass and normalize project-trust behavior across Claude and Pi. Resolve
  literal directory changes to the effective repository; unresolved transitions warn and skip. Require
  state-mutating work before push to finish in a separate tool call, while read-only prefixes remain
  valid. Fallow parity is a legacy-disconnection prerequisite only for opted-in repositories.
- Retain post-edit formatting only for explicitly configured project formatters, respecting ignores
  and using installed project tooling without downloads. Remove automatic lint execution/autofixes;
  project workflows own them. Format only the edited file, allowing whole-file formatting, never stage.
- Complete formatting before returning successful edit/write or supported patch-tool results and
  report formatter changes. Do not add shell-write inference or filesystem watchers. Apply consistent
  project trust and tool-event handling across Claude and Pi.
- Limit total formatting time per edit to five seconds; missing tooling, errors, and timeouts warn
  without blocking continued work or rolling back the agent edit. Stop the formatter process tree
  before returning so it cannot race later edits. Formatting is optional at cutover: disable the old
  hook and use explicit project commands if its replacement is not ready.
- Remove global post-command reminders at cutover: no automatic PR-existence lookup after push,
  vulnerability-output reminder, or repeated PR URL. Preserve original tool output; applicable
  workflows own explicit PR checks. No replacement global hook is required.
- Retain shared instructions for manual and automatic compaction, supplementing user instructions and
  preserving native summary behavior. Preserve relevant decisions, constraints, failed approaches, and
  continuation context rather than exhaustive history; quote exact wording when interpretation matters.
- Use one canonical compaction-instruction source without stale account fallbacks or unnecessary
  overrides. If customization fails, warn briefly and permit native compaction without retry loops or
  extra summaries solely to add MPX sections. Verify live Claude/Pi preservation before cutover.
- Retain concise response-style reinforcement on every user prompt in Claude and Pi without an
  unnecessary shell subprocess. Retire the deprecated post-compaction project/tool reminder bundle;
  preserve useful conventions in canonical instructions, not guessed checks, stale script lists, or
  unverified safeguard claims. Repeat code-quality/tool-preference guidance after compaction only if
  live tests show native instruction retention is insufficient.
- Retain machine-root context for `MPX_PROJECTS`, `MPX_WORK`, `MPX_CLONED`, `MPX_APPS`, `MPX_ONEDRIVE`,
  `MPX_AI_GENERATED`, and `MPX_OBSIDIAN_VAULT`, with their approved labels. Skip unset roots without
  guessing; never dump all `MPX_*` variables or hardcode personal
  paths in shared content. Make roots available on fresh sessions, resume, and after compaction,
  reinjecting only when needed rather than on every prompt; avoid unnecessary Pi subprocesses.
- Machine-root injection remains non-blocking: missing variables are normal, actual injection failures
  briefly warn. Verify delivery and subagent inheritance across Claude/Pi personal/work launchers
  before cutover, preserving the same allowlist.
- Orca is the sole completion/attention notification owner; MPX provides no standalone fallback.
  Alert on whole-session completion only after main-agent, child, and tracked background/follow-up
  work has settled, or on blocking questions requiring human input. Do not alert on individual child
  completion or deliberate cancellation. Orca owns sound/focus/presentation settings; notification
  failures never block work.
- Preserve the Windows tada sound in a user-owned persistent location outside legacy repositories;
  the user confirmed selecting it in Orca. Legacy source files may remain archived; preventing duplicate
  notifications requires disconnecting or isolating active registrations, not deleting source or merely
  archiving GitHub.
- Retire Herdr reporting and deprecated custom terminal-title helpers; preserve native titles and
  approved Pi title behavior. Retain Pi terminal-progress integration only where live tests show Orca
  requires its signals. Reporting failure must not interrupt agent work or present stale/unavailable
  status and resume data as healthy.
- Do not migrate the MPX recorder. The user accepts losing managed discovery/restore and can retain
  native session IDs manually; preserve transcripts and existing records. Keep the completed legacy
  source retirement patch without deploying a new legacy release solely for this change. Native MPX2
  resume acceptance still blocks operational cutover.
- Target native-first resurrection centered on the unified Pi launcher. Use reliable historical
  behavior as a comparison baseline, not a wholesale rollback. Disposable save/resume pilots are
  authorized with isolated account/session/save data; coordinate reboot testing separately.
- Sandbox work follows core cutover. Orca-specific execute/Run orchestration remains a separate decision.

## Approved safeguards

### Dangerous commands

- Retain the dangerous-command guard with the approved updates and require it before operational
  cutover. Positive matches block outright; neither existing implementation is approved unchanged.
  Guard infrastructure errors or timeouts block only the affected shell invocation with a direct
  diagnostic, not the whole session; do not silently allow an uninspected command.
- Allow non-recursive file deletion, empty-directory removal, non-force recursive scratch cleanup,
  and forced-recursive deletion wholly beneath recognized generated/cache or explicit scratch/temp roots.
  Apply equivalent semantics across Bash, PowerShell, and Windows command forms; recognize generated
  roots by ancestry, including nested cache paths, rather than only a target basename.
- For forced-recursive forms, block source/package/worktree deletion, broad absolute or traversal
  targets, opaque dynamic targets, and mixed-safe/unsafe lists. Block repository-wide `find ... -delete`
  and mutating `git clean` regardless of flag arrangement; allow dry runs. Orca owns worktree deletion.
- Fail closed on opaque shell/interpreter wrappers without treating ordinary variable use as opaque.
  This is recognizable-accident prevention, not script sandboxing.
- Block raw force and force-with-lease pushes to the detected default branch and `main`, `master`,
  `dev`, and `prod`; allow force-with-lease on other feature branches.
- Match destructive SQL in recognizable executable database contexts, not quoted examples. Retain
  blocks for filesystem formatting, raw-device overwrite, fork bombs, broad destructive permission
  changes, and persistent Windows PATH mutation.
- Prevent literal Windows `NUL` file creation across supported tool paths. Verify both matching and
  installed registration in every supported launcher/account.

### Package-manager enforcement

- Require deterministic package-manager mismatch enforcement before cutover. Derive the manager
  independently of `mpxconfig.json`; retain its configuration field only if it has a useful consumer.
- Evaluate each package invocation from its effective statically resolved directory. For dynamic or
  unresolved directory transitions, warn and skip that invocation rather than applying the starting
  project's manager.
- Block direct `npx tsc`, recommend a project check script or non-downloading focused compiler
  invocation, and keep shell-tool preference warnings outside this hook.

### Staged-secret scanning

- Require a standalone blocking staged-secret scan before cutover, independent of full project checks
  and not bypassed by `--no-verify`. Block high-confidence credentials/private keys; warn on generic
  assignments. Diagnostics never expose matched credentials.
- Staging/index mutation must finish in a separate tool call before commit. Use no persistent
  false-positive exception system. Preserve test/spec, environment example/sample/template, and
  lockfile exclusions; binary content is outside textual coverage.
- AWS access-key IDs alone warn. Credible GitHub/Slack tokens and multiline private-key material
  block; isolated key headers do not.
- Keep total latency below five seconds including Git collection. Scan added lines from a bounded
  aggregate staged diff without external diff/text conversion or per-file subprocesses. No project checks or retry loops
  run as part of the scanner.
- Infrastructure failure, timeout, oversized input, or unreadable diffs visibly warn and allow, never
  report clean. Positive findings always block, including findings detected before a later scan failure.

export interface ErrorSolution {
  command?: string;
  explanation: string;
}

const help: readonly ErrorSolution[] = [
  {
    command: 'mpx help --all',
    explanation:
      'Discover supported MPX commands. Retain the error code and report persistent failures; help lists commands but does not repair the failure.',
  },
];

const modeExplanations: readonly ErrorSolution[] = [
  { explanation: 'project mode uses the project canonical ID.' },
  {
    explanation:
      'developer mode gives identity-domain repositories read/write access and cloned repositories read-only access without project configuration; it has broader access.',
  },
  { explanation: 'personal-assistant mode permits assistant input and output.' },
  {
    explanation:
      'computer-control mode permits configuration access with staged executable settings.',
  },
  {
    explanation:
      'unrestricted mode has broad host access and requires separate trusted approval and a reason. It is not a recommended workaround, and no command bypasses approval.',
  },
  { explanation: 'These are usual configured modes; user configuration is authoritative.' },
];

const projectRequired: readonly ErrorSolution[] = [
  {
    command: '--mode developer',
    explanation:
      'Append to the original launch command when configured developer mode is appropriate, preserving identity, executor, and approval options. For work Pi, the managed alias is `piw-mpx --mode developer`.',
  },
  ...modeExplanations,
  {
    command: 'mpx init',
    explanation: 'Preview project initialization without writing the repository.',
  },
  {
    command: 'mpx init --confirm',
    explanation:
      'Only if you choose to create project configuration; confirmation writes the repository.',
  },
  {
    command: '--cwd <project-root>',
    explanation: 'Append to the original command when a project exists, replacing the placeholder.',
  },
];

const modeUnknown: readonly ErrorSolution[] = [
  {
    command: '--mode <configured-mode>',
    explanation:
      'Append only a mode that exists in user configuration to the original launch command, or omit an erroneous explicit mode to use its configured default.',
  },
  ...modeExplanations,
];

const doctor = (subject: string): readonly ErrorSolution[] => [
  {
    command: 'mpx doctor',
    explanation: `Diagnose ${subject}. Doctor reports problems; it is not an installation repair command.`,
  },
];

const configNotFound: readonly ErrorSolution[] = [
  {
    command: 'mpx init',
    explanation: 'Preview project initialization without writing the repository.',
  },
  {
    command: '--cwd <project-root>',
    explanation:
      'Append to the original command if configuration exists elsewhere; replace the placeholder.',
  },
  {
    command: 'mpx init --confirm',
    explanation:
      'Optional: create project configuration only after choosing to write the repository.',
  },
];

const userConfig: readonly ErrorSolution[] = [
  {
    explanation:
      'Correct the securely stored user-local configuration. On Windows, verify APPDATA is an absolute path and that the configured file is readable. Doctor cannot repair a missing user configuration.',
  },
];

const cwd: readonly ErrorSolution[] = [
  {
    command: '--cwd <known-root>',
    explanation:
      'Append to the original command, replacing the placeholder with a known configured domain root; verify domain-root configuration and filesystem permissions.',
  },
];

const contentScope: readonly ErrorSolution[] = [
  {
    command: '--content-scope <configured-scope>',
    explanation:
      'Append a configured scope to the original launch command, replacing the placeholder, or remove an erroneous explicit scope; correct configured content roots rather than generated artifacts.',
  },
];

const identityRequired: readonly ErrorSolution[] = [
  {
    command: '--identity <configured-identity>',
    explanation:
      'Append to the original launch command, replacing the placeholder with an explicitly configured identity name while preserving executor and approval options.',
  },
];

const identityMismatch: readonly ErrorSolution[] = [
  {
    explanation:
      'Use an identity configured for the required domain, or launch from the correct configured domain. Do not alter grants to bypass the domain boundary.',
  },
];

const namedOption = (flag: string, noun: string): readonly ErrorSolution[] => [
  {
    command: `${flag} <configured-${noun}>`,
    explanation: `Append a configured ${noun} name to the original launch command, replacing the placeholder, or omit the erroneous explicit option to use configured defaults. Do not weaken policy to bypass the error.`,
  },
];

const runtime: readonly ErrorSolution[] = [
  {
    command: 'mpx launch pi --help',
    explanation:
      'Show Pi launch command usage; use a Pi launcher with your configured identity and execution options.',
  },
  {
    command: 'mpx launch claude --help',
    explanation:
      'Show Claude launch command usage; use a Claude launcher with your configured identity and execution options.',
  },
  {
    explanation:
      'Use the launcher that matches the requested runtime; do not cross-route runtime arguments.',
  },
];

const runtimeArgs: readonly ErrorSolution[] = [
  {
    command: '--runtime-arg <argument>',
    explanation:
      'Use only on an `mpx launch pi` or `mpx launch claude` command, replacing the placeholder; runtime arguments are not valid for other command scopes.',
  },
];

const setup: readonly ErrorSolution[] = [
  {
    command: 'mpx setup',
    explanation:
      'Use the mutating installation workflow to replan or recover after preserving ownership evidence, locks, and setup state, stopping competing setup processes, and following existing remediation. It is not a guaranteed reset, cannot bypass forged receipts or drift, and must not delete state.',
  },
];

const setupLocked: readonly ErrorSolution[] = [
  ...setup,
  {
    explanation:
      'Close competing setup or Pi processes, then retry; do not remove the settings lock.',
  },
];

const content: readonly ErrorSolution[] = [
  {
    command: 'mpx content inspect',
    explanation:
      'Inspect the active projection from an active MPX session; do not edit generated artifacts.',
  },
  {
    command: 'mpx content check',
    explanation:
      'Check active compiled content. Inspect one binding with `mpx content inspect skill <identity>` or `mpx content inspect agent <identity>`, replacing the placeholder; relaunch with the original launcher when bindings are stale.',
  },
];

const sessions: readonly ErrorSolution[] = [
  {
    command: 'mpx session list',
    explanation: 'Inspect known sessions and use the full session ID when a short ID is ambiguous.',
  },
];

const resume: readonly ErrorSolution[] = [
  ...sessions,
  {
    command: 'mpx session resume <id> --dry-run --json',
    explanation: 'Inspect the proposed plan first, replacing <id> with the full session ID.',
  },
  {
    command: 'mpx session resume <id> --confirm-plan <confirmationDigest>',
    explanation:
      'Run only for the approved plan and current digest, replacing placeholders. This cannot bypass approval and must not mutate the registry.',
  },
];

const resumeApprovalUnavailable: readonly ErrorSolution[] = [
  ...sessions,
  {
    explanation:
      'Approval cannot be reconstructed or bypassed for this resume. Start a fresh launch through the original launcher and complete its trusted approval flow.',
  },
];

const workspace: readonly ErrorSolution[] = [
  { command: 'mpx workspace list', explanation: 'List managed workspaces before acting.' },
  {
    command: 'mpx workspace show <path>',
    explanation: 'Inspect the selected workspace, replacing the placeholder with its real path.',
  },
];

const dirtyWorkspace: readonly ErrorSolution[] = [
  ...workspace,
  {
    command: 'git status --short',
    explanation:
      'Inspect changes before removal; do not automatically commit, stash, or delete them.',
  },
  { command: 'git diff', explanation: 'Review dirty content before deciding how to preserve it.' },
];

const workspaceLock: readonly ErrorSolution[] = [
  ...workspace,
  { explanation: 'Wait for the lock owner or resolve its operation; do not remove lock files.' },
];

const workspaceInUse: readonly ErrorSolution[] = [
  ...workspace,
  {
    command: 'mpx workspace stop <service-id>',
    explanation:
      'Stop only the owned configured service, replacing the placeholder, then inspect sessions.',
  },
  ...sessions,
];

const serviceConfig: readonly ErrorSolution[] = [
  ...workspace,
  {
    command: 'mpx workspace logs <service-id>',
    explanation:
      'Inspect configured service logs, replacing the placeholder. Correct the declared service, package manager, and trusted executable configuration rather than choosing an arbitrary PATH executable; diagnostics do not automatically repair configuration.',
  },
];

const ports: readonly ErrorSolution[] = [
  ...workspace,
  {
    explanation:
      'Inspect allocation state; do not delete lease, registry, or lock state or kill arbitrary processes.',
  },
];

const portLock: readonly ErrorSolution[] = [
  ...ports,
  { explanation: 'Wait for the lock owner to finish; do not remove the port lock.' },
];

const workspaceInvalid: readonly ErrorSolution[] = [
  ...workspace,
  {
    explanation:
      'Choose a configured compatible workspace kind: clone, host-worktree, or direct. Verify compatibility with the selected runtime and executor.',
  },
];

const hostCloneUnsupported: readonly ErrorSolution[] = [
  {
    command: '--workspace <configured-workspace>',
    explanation:
      'Append to the original command and select a configured direct or host-worktree workspace, not clone. Host execution is not isolation.',
  },
];

const executorUnavailable: readonly ErrorSolution[] = [
  {
    explanation:
      'Docker execution is not currently implemented by MPX; installing Docker alone does not enable it. There is no automatic host fallback. Host execution requires an explicit choice, a reason, and trusted approval, and provides no isolation.',
  },
];

const hostTty: readonly ErrorSolution[] = [
  {
    explanation:
      'Run the approved original launch command from an interactive shell; do not bypass the TTY check.',
  },
];

const hostApproval: readonly ErrorSolution[] = [
  {
    explanation:
      'Start a fresh original launch and obtain matching trusted host approval and reason; no flag bypasses denied or mismatched approval.',
  },
];

const authority: readonly ErrorSolution[] = [
  {
    command: 'mpx help --all',
    explanation:
      'Find the supported command for the operation, then inspect the selected launch configuration and any operation-specific remediation above. Preserve authority, network, and paid-credit boundaries; help does not diagnose or grant access to providers and tools.',
  },
];

const relaunch: readonly ErrorSolution[] = [
  {
    explanation:
      'Exit the affected runtime and start it again through the original MPX launcher, retaining the intended identity and policy. This rebuilds and revalidates launch bindings; do not hand-edit generated context or reuse stale approvals.',
  },
  ...runtime,
];

const grantInvalid: readonly ErrorSolution[] = [
  {
    command: '--grant <access:resource>',
    explanation:
      'On the original launch command, use ro:<resource> for read-only or rw:<resource> for read/write access to a configured resource. Remove contradictory grants. Every grant requires a nonempty reason and separate matching trusted approval; syntax alone does not grant access.',
  },
];

const elevationReason: readonly ErrorSolution[] = [
  {
    command: '--reason "Explain why elevated access is needed"',
    explanation:
      'Append a genuine nonempty reason to the original launch command. A reason records intent; it does not replace trusted approval for host execution, grants, or unrestricted mode.',
  },
];

const exact = new Map<string, readonly ErrorSolution[]>([
  ['PROJECT_REQUIRED', projectRequired],
  ['LAUNCH_RESTART_REQUIRED', relaunch],
  ['LAUNCH_CONTEXT_REQUIRED', relaunch],
  ['LAUNCH_CONTEXT_INVALID', relaunch],
  ['RUNTIME_PROJECTION_REQUIRED', relaunch],
  ['RUNTIME_PROJECTION_INVALID', relaunch],
  ['RUNTIME_STATUS_BINDING_INVALID', relaunch],
  ['GRANT_INVALID', grantInvalid],
  ['GRANT_CONFLICT', grantInvalid],
  ['ELEVATION_REASON_REQUIRED', elevationReason],
  ['HOST_REASON_REQUIRED', elevationReason],
  ['MODE_UNKNOWN', modeUnknown],
  ['CONFIG_NOT_FOUND', configNotFound],
  ['CONFIG_INVALID', doctor('invalid project configuration')],
  ['USER_CONFIG_REQUIRED', userConfig],
  ['USER_CONFIG_UNREADABLE', userConfig],
  ['CWD_CLASSIFICATION_UNKNOWN', cwd],
  ['CWD_CLASSIFICATION_FAILED', cwd],
  ['CONTENT_SCOPE_UNKNOWN', contentScope],
  ['IDENTITY_REQUIRED', identityRequired],
  ['IDENTITY_UNKNOWN', identityRequired],
  ['IDENTITY_DOMAIN_MISMATCH', identityMismatch],
  ['SKILL_POLICY_UNKNOWN', namedOption('--skill-policy', 'skill-policy')],
  ['NETWORK_POLICY_UNKNOWN', namedOption('--network-policy', 'network-policy')],
  ['PRESET_UNKNOWN', namedOption('--preset', 'preset')],
  ['RUNTIME_REQUIRED', runtime],
  ['ALIAS_RUNTIME_MISMATCH', runtime],
  ['RUNTIME_ARGS_SCOPE_INVALID', runtimeArgs],
  ['INSTALL_PI_SETTINGS_LOCKED', setupLocked],
  ['SESSION_RESUME_PLAN_STALE', resume],
  ['SESSION_RESUME_CONFIRMATION_MISMATCH', resume],
  ['SESSION_RESUME_CONFIRMATION_REQUIRED', resume],
  ['SESSION_RESUME_APPROVAL_UNAVAILABLE', resumeApprovalUnavailable],
  ['WORKTREE_REMOVE_DIRTY', dirtyWorkspace],
  ['WORKTREE_LOCK_TIMEOUT', workspaceLock],
  ['WORKTREE_LOCK_IDENTITY_UNKNOWN', workspaceLock],
  ['WORKTREE_REMOVE_LOCKED', workspaceLock],
  ['WORKTREE_REMOVE_IN_USE', workspaceInUse],
  ['PORT_LOCK_TIMEOUT', portLock],
  ['HOST_CLONE_UNSUPPORTED', hostCloneUnsupported],
  ['WORKSPACE_INVALID', workspaceInvalid],
  ['EXECUTOR_UNAVAILABLE', executorUnavailable],
  ['HOST_TTY_REQUIRED', hostTty],
  ['HOST_APPROVAL_DENIED', hostApproval],
  ['HOST_APPROVAL_MISMATCH', hostApproval],
  ['WORKSPACE_SERVICE_UNKNOWN', serviceConfig],
  ['WORKSPACE_SERVICE_INVALID', serviceConfig],
  ['WORKSPACE_SERVICE_UNMANAGED', serviceConfig],
  ['WORKSPACE_PACKAGE_MANAGER_REQUIRED', serviceConfig],
  ['PREPARATION_EXECUTABLE_UNRESOLVED', serviceConfig],
  ['PREPARATION_EXECUTABLE_CHANGED', serviceConfig],
  ['PREPARATION_PACKAGE_MANAGER_UNAVAILABLE', serviceConfig],
  ['PREPARATION_PACKAGE_MANAGER_MISMATCH', serviceConfig],
]);

const families: readonly (readonly [string, readonly ErrorSolution[]])[] = [
  ['INSTALL_', setup],
  ['PI_LEGACY_', setup],
  ['SETUP_', setup],
  ['ACTIVE_CONTENT_', content],
  ['SKILL_', content],
  ['PROJECTION_', content],
  ['SESSION_', sessions],
  ['WORKSPACE_', workspace],
  ['WORKTREE_', workspace],
  ['PREPARATION_', serviceConfig],
  ['PORT_', ports],
  ['IDENTITY_', identityRequired],
  ['RUNTIME_', runtime],
  ['TOOL_', authority],
  ['PROVIDER_', authority],
  ['POLICY_', authority],
  ['PRESET_', authority],
  ['NETWORK_', authority],
  ['GRANT_', authority],
  ['HOST_', authority],
  ['APPROVAL_', authority],
  ['EXECUTOR_', authority],
  ['LAUNCH_', authority],
  ['CONFIG_', doctor('configuration diagnostics')],
  ['USER_CONFIG_', userConfig],
  ['CWD_', cwd],
  ['CONTENT_SCOPE_', contentScope],
];

export function errorSolutions(code: string): readonly ErrorSolution[] {
  return exact.get(code) ?? families.find(([prefix]) => code.startsWith(prefix))?.[1] ?? help;
}

export interface CommandActionMetadata {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly examples?: readonly string[];
  readonly common?: boolean;
}

export interface CommandGroupMetadata {
  readonly name: string;
  readonly summary: string;
  readonly common?: boolean;
  /** True only when `mpx <group>` intentionally performs an operation. */
  readonly defaultOperation?: boolean;
  readonly actions: readonly CommandActionMetadata[];
}

const action = (
  name: string,
  summary: string,
  usage: string,
  common = true,
  examples?: readonly string[],
): CommandActionMetadata => ({ name, summary, usage, common, ...(examples ? { examples } : {}) });

/** Canonical inventory for terminal help and generated CLI references. */
export const commandRegistry: readonly CommandGroupMetadata[] = [
  {
    name: 'init',
    summary: 'Initialize an MPX project.',
    common: true,
    defaultOperation: true,
    actions: [],
  },
  {
    name: 'status',
    summary: 'Show current project status.',
    common: true,
    defaultOperation: true,
    actions: [],
  },
  {
    name: 'doctor',
    summary: 'Diagnose project configuration and services.',
    common: true,
    defaultOperation: true,
    actions: [],
  },
  {
    name: 'launch',
    summary: 'Explain or start a runtime launch.',
    common: true,
    actions: [
      action('explain', 'Explain launch selection.', 'mpx launch explain [options]', true, [
        'mpx launch explain --identity work',
      ]),
      action('claude', 'Launch Claude.', 'mpx launch claude [options]'),
      action('pi', 'Launch Pi.', 'mpx launch pi [options]'),
      action('current', 'Show the process-bound launch.', 'mpx launch current'),
      action(
        'sbx-plan-export',
        'Export a sandbox launch plan.',
        'mpx launch sbx-plan-export [options]',
        false,
      ),
      action('cc', 'Launch Claude using the short alias.', 'mpx cc [options]', false),
      action('ccw', 'Launch Claude in the work preset.', 'mpx ccw [options]', false),
      action('piw', 'Launch Pi in the work preset.', 'mpx piw [options]', false),
    ],
  },
  {
    name: 'session',
    summary: 'Inspect and manage runtime sessions.',
    common: true,
    actions: [
      action('list', 'List sessions.', 'mpx session list [options]'),
      action('show', 'Show one session.', 'mpx session show <id>'),
      action('resume', 'Resume one session.', 'mpx session resume <id> [options]', true, [
        'mpx session resume abc123',
      ]),
      action('save', 'Capture active sessions.', 'mpx session save <id...> | --all-active'),
      action('branch', 'Create a child session.', 'mpx session branch <parent-id> [options]'),
      action('mark', 'Set workflow status.', 'mpx session mark <id> <status> [options]'),
      action('handoff', 'Record a session handoff.', 'mpx session handoff <id> [options]'),
      action('complete', 'Complete a session.', 'mpx session complete <id> [options]'),
      action('inbox', 'List session inbox entries.', 'mpx session inbox [options]'),
      action('reconcile', 'Reconcile discovered sessions.', 'mpx session reconcile [options]'),
      action(
        'completion',
        'Complete a session (compatibility alias).',
        'mpx session completion <id> [options]',
        false,
      ),
      action(
        'resurrect-export',
        'Export resurrection data.',
        'mpx session resurrect-export',
        false,
      ),
    ],
  },
  {
    name: 'issue',
    summary: 'Work with provider-neutral issues.',
    common: true,
    actions: [
      action('list', 'List issues.', 'mpx issue list [--state open|finished]'),
      action('view', 'View an issue.', 'mpx issue view --id <id>', true, [
        'mpx issue view --id 123',
      ]),
      action('create', 'Create an issue.', 'mpx issue create --title <title> --body <body>'),
      action('edit', 'Edit an issue.', 'mpx issue edit --id <id> --title <title> --body <body>'),
      action('comment', 'Comment on an issue.', 'mpx issue comment --id <id> --body <body>'),
      action('label', 'Label an issue.', 'mpx issue label --id <id> --label <label>'),
      action('move', 'Move an issue.', 'mpx issue move --id <id> --destination <target>'),
      action('finish', 'Finish an issue.', 'mpx issue finish --id <id>'),
      action(
        'dependency',
        'Add or remove a dependency.',
        'mpx issue dependency <add|remove> --id <id> --dependency-id <id>',
      ),
      action('show', 'View an issue (alias).', 'mpx issue show --id <id>', false),
      action(
        'update',
        'Edit an issue (alias).',
        'mpx issue update --id <id> --title <title> --body <body>',
        false,
      ),
      action('close', 'Finish an issue (alias).', 'mpx issue close --id <id>', false),
    ],
  },
  {
    name: 'review',
    summary: 'Work with provider-neutral code reviews.',
    common: true,
    actions: [
      action('view', 'View a review.', 'mpx review view --id <id>'),
      action(
        'create',
        'Create a review.',
        'mpx review create --title <title> --body <body> --source-branch <branch> --target-branch <branch>',
      ),
      action(
        'update',
        'Update a review.',
        'mpx review update --id <id> --title <title> --body <body>',
      ),
      action('comment', 'Comment on a review.', 'mpx review comment --id <id> --body <body>'),
      action('ready', 'Mark a review ready.', 'mpx review ready --id <id>'),
      action(
        'merge',
        'Merge a review.',
        'mpx review merge --id <id> [--method merge|squash|rebase]',
      ),
    ],
  },
  {
    name: 'ci',
    summary: 'Inspect and control provider-neutral CI.',
    common: true,
    actions: [
      action('status', 'Show CI status.', 'mpx ci status --id <id>'),
      action('watch', 'Watch CI status.', 'mpx ci watch --id <id>'),
      action('logs', 'Show CI run logs.', 'mpx ci logs --run-id <id>'),
      action('retry', 'Retry a CI run.', 'mpx ci retry --run-id <id>'),
    ],
  },
  {
    name: 'worktree',
    summary: 'Manage repository worktrees.',
    common: true,
    actions: [
      action('list', 'List worktrees.', 'mpx worktree list'),
      action('status', 'Show worktree lifecycle status.', 'mpx worktree status'),
      action('create', 'Create a worktree.', 'mpx worktree create <branch> [options]'),
      action('select', 'Select a worktree.', 'mpx worktree select <path>'),
      action('remove', 'Remove a worktree.', 'mpx worktree remove <path>'),
      action('prepare', 'Prepare a lifecycle item.', 'mpx worktree prepare <key>'),
      action('cancel', 'Cancel a lifecycle item.', 'mpx worktree cancel <key>'),
      action('reconcile', 'Reconcile worktree state.', 'mpx worktree reconcile'),
    ],
  },
  {
    name: 'dev',
    summary: 'Manage development services.',
    common: true,
    actions: [
      action('start', 'Start a service.', 'mpx dev start --id <id>'),
      action('status', 'Show service status.', 'mpx dev status [--id <id>]'),
      action('logs', 'Show service logs.', 'mpx dev logs --id <id> [--lines <count>]'),
      action('restart', 'Restart a service.', 'mpx dev restart --id <id>'),
      action('stop', 'Stop a service.', 'mpx dev stop --id <id>'),
    ],
  },
  {
    name: 'ports',
    summary: 'Manage project port assignments.',
    common: true,
    actions: [
      action('list', 'List port leases.', 'mpx ports list'),
      action('inspect', 'Inspect project ports.', 'mpx ports inspect'),
      action('ensure', 'Ensure project ports.', 'mpx ports ensure'),
      action('resolve', 'Resolve project ports.', 'mpx ports resolve'),
      action('kill', 'Kill a process by PID.', 'mpx ports kill <pid>'),
      action('release', 'Release project ports.', 'mpx ports release'),
      action('reconcile', 'Reconcile port state.', 'mpx ports reconcile [--rebuild]'),
    ],
  },
  {
    name: 'config',
    summary: 'Inspect and validate configuration.',
    common: true,
    actions: [
      action('show', 'Show project configuration.', 'mpx config show'),
      action('validate', 'Validate project configuration.', 'mpx config validate'),
      action('resolve', 'Resolve merged configuration.', 'mpx config resolve'),
      action('explain', 'Explain merged configuration.', 'mpx config explain'),
    ],
  },
  {
    name: 'provider',
    summary: 'Inspect configured providers.',
    common: true,
    actions: [
      action('list', 'List provider capabilities.', 'mpx provider list [--role repository|issues]'),
      action('explain', 'Explain routing for a role.', 'mpx provider explain <repository|issues>'),
      action('doctor', 'Diagnose provider access.', 'mpx provider doctor [--identity <name>]'),
    ],
  },
  {
    name: 'content',
    summary: 'Inspect the active generated runtime content.',
    common: true,
    actions: [
      action('current', 'Show active content paths.', 'mpx content current [--json]'),
      action('list', 'List active skills and agents.', 'mpx content list [--json]'),
      action(
        'show',
        'Print one exact generated file.',
        'mpx content show <skill|agent> <identity>',
      ),
      action('check', 'Verify all active compiler files.', 'mpx content check [--json]'),
    ],
  },
  {
    name: 'skill',
    summary: 'Inspect skill resolution.',
    common: true,
    actions: [
      action('list', 'List skills.', 'mpx skill list [resolution options]'),
      action('search', 'Search skills.', 'mpx skill search <query> [resolution options]'),
      action('show', 'Show a skill.', 'mpx skill show <id> [resolution options]'),
      action('explain', 'Explain skill selection.', 'mpx skill explain <id> [resolution options]'),
      action(
        'complete',
        'Complete a skill prefix.',
        'mpx skill complete <prefix> [resolution options]',
      ),
    ],
  },
  {
    name: 'account',
    summary: 'Manage runtime account bindings.',
    common: true,
    actions: ['enroll', 're-enroll', 'list', 'status', 'verify'].map((name) =>
      action(name, `${name} account binding.`, `mpx account ${name} [options]`),
    ),
  },
  {
    name: 'install',
    summary: 'Plan and manage MPX installation.',
    common: true,
    actions: ['intent', 'prepare', 'plan', 'apply', 'verify', 'rollback', 'uninstall'].map((name) =>
      action(name, `${name} installation.`, `mpx install ${name} [options]`),
    ),
  },
  {
    name: 'migration',
    summary: 'Operate migration safeguards.',
    actions: ['reconcile', 'report', 'rollback-drill', 'cutover-plan'].map((name) =>
      action(name, `${name} migration state.`, `mpx migration ${name}`),
    ),
  },
  {
    name: 'identity',
    summary: 'Inspect configured identities.',
    actions: [
      action('list', 'List identities.', 'mpx identity list'),
      action('show', 'Show an identity.', 'mpx identity show <name>'),
    ],
  },
  {
    name: 'mode',
    summary: 'Inspect configured modes.',
    actions: [
      action('list', 'List modes.', 'mpx mode list'),
      action('show', 'Show a mode.', 'mpx mode show <name>'),
    ],
  },
  {
    name: 'skill-policy',
    summary: 'Inspect skill policies.',
    actions: [
      action('list', 'List skill policies.', 'mpx skill-policy list'),
      action('show', 'Show a skill policy.', 'mpx skill-policy show <name>'),
    ],
  },
  {
    name: 'preset',
    summary: 'Inspect launch presets.',
    actions: [
      action('list', 'List presets.', 'mpx preset list'),
      action('show', 'Show a preset.', 'mpx preset show <name>'),
    ],
  },
  {
    name: 'view',
    summary: 'Manage generated local views.',
    actions: [action('rebuild', 'Rebuild the local issue view.', 'mpx view rebuild')],
  },
  {
    name: 'runtime',
    summary: 'Inspect a process-bound runtime.',
    actions: [
      action('claude', 'Inspect Claude runtime binding.', 'mpx runtime claude'),
      action('pi', 'Inspect Pi runtime binding.', 'mpx runtime pi'),
    ],
  },
  {
    name: 'help',
    summary: 'Show root or complete command help.',
    defaultOperation: true,
    actions: [],
  },
] as const;

export function commandGroup(name: string): CommandGroupMetadata | undefined {
  return commandRegistry.find((group) => group.name === name);
}

export function renderRootHelp(): string {
  const groups = commandRegistry.filter((group) => group.common);
  return (
    [
      'Usage: mpx [options] <command>',
      '',
      'Common commands:',
      ...groups.map((group) => `  ${group.name.padEnd(14)} ${group.summary}`),
      '',
      'Options:',
      '  -h, --help     Show help.',
      '  --cwd DIR      Use DIR as the working directory.',
      '  --json         Emit structured automation output for command results and errors.',
      '',
      "Run 'mpx <command> --help' for focused help.",
    ].join('\n') + '\n'
  );
}

export function renderAllHelp(): string {
  return (
    [
      'Usage: mpx help --all',
      '',
      'All commands:',
      ...commandRegistry.flatMap((group) =>
        group.actions.length
          ? group.actions.map((item) => `  ${group.name} ${item.name}`)
          : [`  ${group.name}`],
      ),
    ].join('\n') + '\n'
  );
}

export function renderGroupHelp(group: CommandGroupMetadata): string {
  const common = group.actions.filter((item) => item.common !== false).slice(0, 10);
  return (
    [
      `Usage: mpx ${group.name}${group.actions.length ? ' <action> [options]' : ' [options]'}`,
      '',
      group.summary,
      ...(common.length
        ? [
            '',
            'Common actions:',
            ...common.map((item) => `  ${item.name.padEnd(18)} ${item.summary}`),
          ]
        : []),
      '',
      `Run 'mpx ${group.name} <action> --help' for command usage.`,
    ].join('\n') + '\n'
  );
}

export function renderActionHelp(group: CommandGroupMetadata, item: CommandActionMetadata): string {
  return (
    [
      `Usage: ${item.usage}`,
      '',
      item.summary,
      ...(item.examples?.length
        ? ['', 'Examples:', ...item.examples.map((example) => `  ${example}`)]
        : []),
    ].join('\n') + '\n'
  );
}

const generatedHeader = (title: string): string[] => [
  `# ${title}`,
  '',
  '<!-- Generated by scripts/generate-cli-docs.mjs. Do not edit by hand. -->',
  '',
];

export function renderBasicReference(): string {
  const groups = commandRegistry.filter((group) => group.common);
  const lines = [
    ...generatedHeader('MPX CLI Basic Reference'),
    'Use `mpx --help` for terminal help and `mpx <group> --help` for focused guidance.',
    'For runtime content debugging, use `mpx content current`, `list`, `show`, and `check`; these inspect the active projection without rebuilding it.',
    '',
    '## Common command groups',
    '',
    ...groups.map((group) => `- \`mpx ${group.name}\` — ${group.summary}`),
    '',
    '## Common operations',
    '',
  ];
  for (const group of groups) {
    const actions = group.actions
      .filter((item) => item.common !== false)
      .slice(0, group.name === 'content' ? 4 : 3);
    if (actions.length === 0) {
      lines.push(`- \`mpx ${group.name}\` — ${group.summary}`);
    } else {
      lines.push(...actions.map((item) => `- \`${item.usage}\` — ${item.summary}`));
    }
  }
  const examples = groups
    .flatMap((group) =>
      group.actions.filter((item) => item.common !== false).flatMap((item) => item.examples ?? []),
    )
    .slice(0, 5);
  if (examples.length) {
    lines.push('', '## Examples', '', ...examples.map((example) => `- \`${example}\``));
  }
  lines.push(
    '',
    'Use [MPX_CLI_REFERENCE.md](MPX_CLI_REFERENCE.md) for the complete inventory.',
    '',
  );
  return lines.join('\n');
}

export function renderCompleteReference(): string {
  const lines = [
    ...generatedHeader('MPX CLI Reference'),
    'Complete command inventory generated from the CLI command metadata registry.',
    '',
  ];
  for (const group of commandRegistry) {
    lines.push(`## \`mpx ${group.name}\``, '', group.summary, '');
    if (group.defaultOperation) {
      lines.push(`- \`mpx ${group.name}\` — default operation`, '');
    }
    for (const item of group.actions) {
      lines.push(`### \`${item.usage}\``, '', item.summary, '');
      if (item.examples?.length) {
        lines.push('Examples:', '', ...item.examples.map((example) => `- \`${example}\``), '');
      }
    }
  }
  return lines.join('\n');
}

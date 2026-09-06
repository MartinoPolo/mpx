export type CommandAudience = 'human' | 'agent' | 'internal' | 'experimental';

export interface CommandActionMetadata {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly audience: CommandAudience;
  readonly examples?: readonly string[];
}

export interface CommandGroupMetadata {
  readonly name: string;
  readonly summary: string;
  readonly audience: CommandAudience;
  /** True only when `mpx <group>` intentionally performs an operation. */
  readonly defaultOperation?: boolean;
  readonly actions: readonly CommandActionMetadata[];
}

const action = (
  name: string,
  summary: string,
  usage: string,
  audience: CommandAudience,
  examples?: readonly string[],
): CommandActionMetadata => ({ name, summary, usage, audience, ...(examples ? { examples } : {}) });

/** Canonical inventory for dispatch, terminal help, and generated CLI references. */
export const commandRegistry: readonly CommandGroupMetadata[] = [
  {
    name: 'setup',
    summary: 'Install and configure MPX for this user.',
    audience: 'human',
    defaultOperation: true,
    actions: [],
  },
  {
    name: 'doctor',
    summary: 'Diagnose project configuration and services.',
    audience: 'human',
    defaultOperation: true,
    actions: [],
  },
  {
    name: 'init',
    summary: 'Initialize an MPX project.',
    audience: 'human',
    defaultOperation: true,
    actions: [],
  },
  {
    name: 'launch',
    summary: 'Start a native runtime with MPX routing and content.',
    audience: 'human',
    actions: [
      action('pi', 'Launch Pi.', 'mpx launch pi [options]', 'human'),
      action('claude', 'Launch Claude.', 'mpx launch claude [options]', 'human'),
    ],
  },
  {
    name: 'content',
    summary: 'Inspect and verify the active compiled content projection.',
    audience: 'human',
    actions: [
      action(
        'inspect',
        'Inspect the active projection or print one exact compiled file.',
        'mpx content inspect [<skill|agent> <identity>]',
        'human',
      ),
      action('check', 'Verify all active compiler files.', 'mpx content check', 'human'),
    ],
  },
  {
    name: 'issue',
    summary: 'Work with provider-neutral issues.',
    audience: 'human',
    actions: [
      action('list', 'List issues.', 'mpx issue list [--state open|finished]', 'human'),
      action('view', 'View an issue.', 'mpx issue view --id <id>', 'human', [
        'mpx issue view --id 123',
      ]),
      action(
        'create',
        'Create an issue.',
        'mpx issue create --title <title> --body <body>',
        'human',
      ),
      action(
        'edit',
        'Edit an issue.',
        'mpx issue edit --id <id> --title <title> --body <body>',
        'human',
      ),
      action(
        'comment',
        'Comment on an issue.',
        'mpx issue comment --id <id> --body <body>',
        'human',
      ),
      action('finish', 'Finish an issue.', 'mpx issue finish --id <id>', 'human'),
      action('label', 'Label an issue.', 'mpx issue label --id <id> --label <label>', 'agent'),
      action('move', 'Move an issue.', 'mpx issue move --id <id> --destination <target>', 'agent'),
      action(
        'dependency',
        'Add or remove an issue dependency.',
        'mpx issue dependency <add|remove> --id <id> --dependency-id <id>',
        'agent',
      ),
    ],
  },
  {
    name: 'review',
    summary: 'Work with provider-neutral code reviews.',
    audience: 'human',
    actions: [
      action('view', 'View a review.', 'mpx review view --id <id>', 'human'),
      action(
        'create',
        'Create a review.',
        'mpx review create --title <title> --body <body> --source-branch <branch> --target-branch <branch>',
        'human',
      ),
      action(
        'merge',
        'Merge a review.',
        'mpx review merge --id <id> [--method merge|squash|rebase]',
        'human',
      ),
      action(
        'update',
        'Update a review.',
        'mpx review update --id <id> --title <title> --body <body>',
        'agent',
      ),
      action(
        'comment',
        'Comment on a review.',
        'mpx review comment --id <id> --body <body>',
        'agent',
      ),
      action('ready', 'Mark a review ready.', 'mpx review ready --id <id>', 'agent'),
    ],
  },
  {
    name: 'ci',
    summary: 'Inspect and control provider-neutral CI.',
    audience: 'human',
    actions: [
      action('status', 'Show CI status.', 'mpx ci status --id <id>', 'human'),
      action('logs', 'Show CI run logs.', 'mpx ci logs --run-id <id>', 'human'),
      action('watch', 'Watch CI status.', 'mpx ci watch --id <id>', 'agent'),
      action('retry', 'Retry a CI run.', 'mpx ci retry --run-id <id>', 'agent'),
    ],
  },
  {
    name: 'session',
    summary: 'List and resume native runtime sessions.',
    audience: 'human',
    actions: [
      action('list', 'List sessions.', 'mpx session list [options]', 'human'),
      action('resume', 'Resume one session.', 'mpx session resume <id> [options]', 'human', [
        'mpx session resume abc123',
      ]),
      action(
        'resurrect-export',
        'Export bounded resurrection data.',
        'mpx session resurrect-export',
        'internal',
      ),
    ],
  },
  {
    name: 'workspace',
    summary: 'Inspect and manage project workspaces.',
    audience: 'human',
    actions: [
      action('list', 'List workspaces.', 'mpx workspace list', 'human'),
      action('show', 'Show a workspace.', 'mpx workspace show [path] [--machine]', 'human'),
      action('create', 'Create a workspace.', 'mpx workspace create <branch> [options]', 'human'),
      action('remove', 'Remove a workspace.', 'mpx workspace remove <path>', 'human'),
      action(
        'start',
        'Start a configured service.',
        'mpx workspace start <service-id> [path]',
        'human',
      ),
      action(
        'stop',
        'Stop a configured service.',
        'mpx workspace stop <service-id> [path]',
        'human',
      ),
      action(
        'logs',
        'Show configured service logs.',
        'mpx workspace logs <service-id> [path] [--lines <count>]',
        'human',
      ),
    ],
  },
  {
    name: 'port',
    summary: 'Manage verified port listeners.',
    audience: 'human',
    actions: [action('kill', 'Kill a verified listener by PID.', 'mpx port kill <pid>', 'human')],
  },
] as const;

const hasAudience = (
  value: { readonly audience: CommandAudience },
  audiences: ReadonlySet<CommandAudience>,
): boolean => audiences.has(value.audience);

export function commandGroup(name: string): CommandGroupMetadata | undefined {
  return commandRegistry.find((group) => group.name === name);
}

/** Looks up executable metadata without applying help visibility rules. */
export function commandAction(
  groupName: string,
  actionName: string,
): CommandActionMetadata | undefined {
  return commandGroup(groupName)?.actions.find((item) => item.name === actionName);
}

/** Returns a stable, sorted route inventory for exactly the requested audiences. */
export function commandLeaves(audiences: readonly CommandAudience[]): string[] {
  const visible = new Set(audiences);
  return commandRegistry
    .flatMap((group) => {
      const defaults = group.defaultOperation && hasAudience(group, visible) ? [group.name] : [];
      return [
        ...defaults,
        ...group.actions
          .filter((item) => hasAudience(item, visible))
          .map((item) => `${group.name} ${item.name}`),
      ];
    })
    .sort((left, right) => left.localeCompare(right));
}

const groupsFor = (audiences: readonly CommandAudience[]): CommandGroupMetadata[] => {
  const visible = new Set(audiences);
  return commandRegistry.filter(
    (group) =>
      (group.defaultOperation && hasAudience(group, visible)) ||
      group.actions.some((item) => hasAudience(item, visible)),
  );
};

export function renderRootHelp(): string {
  const groups = groupsFor(['human']);
  return `${[
    'Usage: mpx [options] <command>',
    '',
    'Commands:',
    ...groups.map((group) => `  ${group.name.padEnd(14)} ${group.summary}`),
    '',
    'Options:',
    '  -h, --help     Show help.',
    '  --cwd DIR      Use DIR as the working directory.',
    '  --json         Emit structured automation output for command results and errors.',
    '',
    "Run 'mpx <command> --help' for focused help.",
  ].join('\n')}\n`;
}

export function renderAllHelp(): string {
  return `${[
    'Usage: mpx help --all',
    '',
    'All human and agent commands:',
    ...commandLeaves(['human', 'agent']).map((leaf) => `  ${leaf}`),
  ].join('\n')}\n`;
}

export function renderGroupHelp(group: CommandGroupMetadata): string {
  const actions = group.actions.filter((item) => item.audience === 'human');
  return `${[
    `Usage: mpx ${group.name}${group.actions.length ? ' <action> [options]' : ' [options]'}`,
    '',
    group.summary,
    ...(actions.length
      ? ['', 'Actions:', ...actions.map((item) => `  ${item.name.padEnd(18)} ${item.summary}`)]
      : []),
    ...(actions.length ? ['', `Run 'mpx ${group.name} <action> --help' for command usage.`] : []),
  ].join('\n')}\n`;
}

export function renderActionHelp(group: CommandGroupMetadata, item: CommandActionMetadata): string {
  if (item.audience !== 'human') {
    return renderGroupHelp(group);
  }
  return `${[
    `Usage: ${item.usage}`,
    '',
    item.summary,
    ...(item.examples?.length
      ? ['', 'Examples:', ...item.examples.map((example) => `  ${example}`)]
      : []),
  ].join('\n')}\n`;
}

const generatedHeader = (title: string): string[] => [
  `# ${title}`,
  '',
  '<!-- Generated by scripts/generate-cli-docs.mjs. Do not edit by hand. -->',
  '',
];

function renderReference(
  title: string,
  audiences: readonly CommandAudience[],
  introduction: string,
): string {
  const visible = new Set(audiences);
  const lines = [...generatedHeader(title), introduction, ''];
  for (const group of groupsFor(audiences)) {
    lines.push(`## \`mpx ${group.name}\``, '', group.summary, '');
    if (group.defaultOperation && hasAudience(group, visible)) {
      lines.push(`- \`mpx ${group.name}\` — ${group.summary}`, '');
    }
    for (const item of group.actions.filter((entry) => hasAudience(entry, visible))) {
      lines.push(`### \`${item.usage}\``, '', item.summary, '');
      if (item.examples?.length) {
        lines.push('Examples:', '', ...item.examples.map((example) => `- \`${example}\``), '');
      }
    }
  }
  return lines.join('\n');
}

export function renderBasicReference(): string {
  return renderReference(
    'MPX CLI Basic Reference',
    ['human'],
    'Human command reference generated from the canonical CLI metadata registry.',
  );
}

export function renderCompleteReference(): string {
  return renderReference(
    'MPX CLI Reference',
    ['human', 'agent'],
    'Complete human and agent command reference generated from the canonical CLI metadata registry.',
  );
}

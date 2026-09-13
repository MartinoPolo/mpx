#!/usr/bin/env node
// One reviewed transfer from the dirty canonical MPX content. Never edits legacy sources or
// overwrites an existing MPX2 destination.
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
if (!process.env.MPX_PROJECTS || !path.isAbsolute(process.env.MPX_PROJECTS)) {
  throw new Error('An absolute MPX_PROJECTS is required; no source root is guessed.');
}
const sourceRoot = path.join(process.env.MPX_PROJECTS, 'mpx', 'content');
const sharedNames = [
  'AUTHORING.md', 'BOARD_CONVENTION.md', 'CONTENT_PATHS.md', 'DESIGN_PIPELINE.md',
  'DOCUMENTATION_STRATEGY.md', 'EXECUTOR_CONTRACT.md', 'EXPLORATION.md',
  'GIT_COMMIT_WORKFLOW.md', 'ISSUE_TRACKER.md', 'PLAYWRIGHT_TESTING.md',
  'PROJECT_DOC_TEMPLATES.md', 'PROVIDER_ROUTING.md', 'REPAIR_ORCHESTRATION.md',
  'REPORTING_LINKS.md', 'SENTRY.md', 'SUBAGENT_PROTOCOL.md', 'WRITING_FOR_AGENTS.md',
  'deep-modules.md', 'interface-design.md',
];
const providerNames = ['GERRIT.md', 'GITHUB.md', 'GITLAB.md', 'KANBANFLOW.md', 'LOCAL.md'];
const agents = {
  'check-reporter': ['advanced', 'high', ['read']],
  'chrome-devtools-tester': ['advanced', 'high', ['read', 'search', 'shell', 'browser']],
  'ci-analyzer': ['advanced', 'high', ['read', 'search', 'shell']],
  'context7-docs-fetcher': ['mechanical', 'low', ['read', 'context']],
  executor: ['advanced', 'low', ['read', 'search', 'shell', 'write']],
  'git-committer': ['mechanical', 'low', ['shell']],
  'issue-analyzer': ['advanced', 'high', ['read', 'search', 'shell', 'web']],
  'issue-finder': ['standard', 'low', ['read', 'search', 'shell']],
  'review-manager': ['standard', 'low', ['shell']],
  'tdd-executor': ['advanced', 'medium', ['read', 'search', 'shell', 'write']],
  'ui-variant-generator': ['advanced', 'medium', ['read', 'search', 'shell', 'write']],
  'unresolved-issue-tracker': ['standard', 'low', ['read', 'search', 'shell']],
};
const sourceAgentMetadata = JSON.parse(await fs.readFile(path.join(sourceRoot, 'agents', 'metadata.json'), 'utf8'));
for (const [name, expected] of Object.entries(agents)) {
  const source = sourceAgentMetadata.agents?.[`mpx-${name}`];
  const actual = source && [source.modelClass, source.thinking, source.capabilities];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Reviewed semantic metadata changed for mpx-${name}`);
  }
}

const planned = [];
function plan(source, destination) {
  planned.push({ source: path.join(sourceRoot, source), destination: path.join(root, destination) });
}
for (const name of sharedNames) plan(`instructions/shared/${name}`, `content/instructions/shared/${name}`);
for (const name of providerNames) plan(`instructions/shared/providers/${name}`, `content/instructions/shared/providers/${name}`);
plan('instructions/global/AGENTS.md', 'content/instructions/shared/AGENTS.md');
plan('instructions/runtime/pi/APPEND_SYSTEM.md', 'content/instructions/pi/APPEND_SYSTEM.md');
plan('instructions/runtime/claude/CLAUDE.md', 'content/instructions/claude/CLAUDE.md');
plan('skills/execute/tests.md', 'content/instructions/shared/EXECUTOR_TESTS.md');
plan('skills/execute/mocking.md', 'content/instructions/shared/EXECUTOR_MOCKING.md');
plan('output-styles/mpx-terse.md', 'content/output-styles/mpx-terse.md');
for (const name of Object.keys(agents)) plan(`agents/mpx-${name}.md`, `content/agents/${name}.md`);

async function walk(directory, relative = '') {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path.join(directory, entry.name), child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`Unsupported source entry: ${path.join(directory, entry.name)}`);
  }
  return files;
}
for (const relative of await walk(path.join(sourceRoot, 'instructions', 'rules'))) {
  plan(`instructions/rules/${relative}`, `content/rules/${relative}`);
}
for (const item of planned) {
  if (await fs.access(item.destination).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error))) {
    throw new Error(`Refusing to overwrite existing destination: ${item.destination}`);
  }
}
for (const item of planned) {
  await fs.mkdir(path.dirname(item.destination), { recursive: true });
  await fs.copyFile(item.source, item.destination);
}

async function transform(relative, change) {
  const file = path.join(root, relative);
  const before = await fs.readFile(file, 'utf8');
  const after = change(before);
  if (after === before) throw new Error(`Expected targeted adaptation did not change ${relative}`);
  await fs.writeFile(file, after);
}
function replaceOnce(text, before, after, label) {
  if (text.split(before).length !== 2) throw new Error(`${label}: expected one exact source block`);
  return text.replace(before, after);
}

for (const [name, [modelClass, thinking, capabilities]] of Object.entries(agents)) {
  await transform(`content/agents/${name}.md`, source => {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
    if (!match || !new RegExp(`^name: mpx-${name}$`, 'm').test(match[1])) throw new Error(`Unexpected agent frontmatter: ${name}`);
    const frontmatter = match[1].replace(`name: mpx-${name}`, `name: ${name}`);
    const metadata = `metadata:\n  mpx:\n    schemaVersion: 1\n    modelClass: ${modelClass}\n    thinking: ${thinking}\n    capabilities: [${capabilities.join(', ')}]`;
    return source.replace(match[0], `---\n${frontmatter}\n${metadata}\n---`);
  });
}

await transform('content/instructions/shared/AUTHORING.md', source => {
  source = replaceOnce(source,
`| Artifact           | Canonical path                          | Identity                                       |
| ------------------ | --------------------------------------- | ---------------------------------------------- |
| Skill              | \`content/skills/<name>/SKILL.md\`        | bare \`<name>\`; public projection \`/mpx:<name>\` |
| Agent              | \`content/agents/mpx-<role>.md\`          | \`mpx-<role>\`                                   |
| Shared instruction | \`content/instructions/shared/<NAME>.md\` | no frontmatter identity                        |`,
`| Artifact           | Canonical path                          | Identity                                      |
| ------------------ | --------------------------------------- | --------------------------------------------- |
| Skill              | \`content/skills/<name>/SKILL.md\`        | bare \`<name>\`; native \`{{MPX_SKILL_COMMAND}}<name>\` |
| Agent              | \`content/agents/<role>.md\`              | bare \`<role>\`; projected \`{{MPX_AGENT_PREFIX}}<role>\` |
| Shared instruction | \`content/instructions/shared/<NAME>.md\` | no frontmatter identity                       |`, 'AUTHORING identities');
  source = source.replace('Generated projections must record their canonical source/version and pass drift validation.', 'Generated projections must pass deterministic drift validation against canonical content.');
  return source;
});

await transform('content/instructions/shared/AGENTS.md', source => {
  source = replaceOnce(source,
`Discover dev-server and Storybook commands in \`package.json\` and referenced configuration. Missing
MPX port metadata must not block startup; use project defaults. If a port is occupied, choose
another only when the server and dependent URLs can be configured reliably; otherwise ask before
stopping the existing server.`,
`Discover development-server and Storybook commands in \`package.json\` and referenced project
configuration. Project servers are started manually in an Orca or project terminal. MPX does not
own server processes or port state. Use the parent-provided URL for browser work; if it is missing,
ask rather than starting, restarting, stopping, or guessing a server.`, 'AGENTS server policy');
  source = replaceOnce(source,
`Use skill locations exposed by the runtime. When installed, the shared MPX skill collection is at
\`~/.agents/skills/mpx/\`.`,
`Use skill locations exposed by the native runtime. Invoke MPX skills with their native command:
\`/skill:mp-<name>\` in Pi and \`/mp-<name>\` in Claude. Resolve compiled support content only from
the absolute \`MPX_ACTIVE_CONTENT_ROOT\`; do not guess an installation path.`, 'AGENTS skill paths');
  source = source.replace('See the installed `~/.agents/instructions/shared/SUBAGENT_PROTOCOL.md` for\ndetails.', 'Resolve and read `dist/{{MPX_HARNESS}}/instructions/shared/SUBAGENT_PROTOCOL.md` beneath\n`MPX_ACTIVE_CONTENT_ROOT` for details.');
  source = source.replace('Native\nprofiles read this policy at `~/.agents/instructions/shared/REPORTING_LINKS.md`.', 'Native\nprofiles read this policy from the stable `MPX_ACTIVE_CONTENT_ROOT` projection.');
  return source;
});

await transform('content/instructions/pi/APPEND_SYSTEM.md', source => {
  source = replaceOnce(source,
`## Worktrees

- When isolation is required, use the \`worktree\` tool before implementation. Call it alone with
  \`action: "create"\` or \`"enter"\`, then stop while the session moves. A shell \`cd\` is not a session
  handoff.`,
`## Checkouts

- Work in the checkout where the user launched Pi. The user creates and selects issue checkouts in
  Orca. Do not create, switch, or remove worktrees; request a user-created checkout when isolation is
  required.`, 'Pi checkout policy');
  return source.replace('(../../shared/REPORTING_LINKS.md)', '(../shared/REPORTING_LINKS.md)');
});
await transform('content/instructions/claude/CLAUDE.md', source => source.replace('@instructions/global/AGENTS.md', '@../shared/AGENTS.md'));

await transform('content/instructions/shared/DOCUMENTATION_STRATEGY.md', source => source.replace(
'**Workspace** — Top-level container for one repository, project folder, and window. **Issue** —\nAtomic work unit identified by one MPX Issue ID, worktree, branch, and color. **Session** — One\nagent execution tied to an issue, with transcript, cost, and state.',
'**Workspace** — Top-level container for one repository and project folder. **Issue** —\nAtomic work unit identified by one configured-provider Issue ID and branch. **Session** — One\nnative harness conversation working in the user-selected checkout.'));
await transform('content/instructions/shared/PROJECT_DOC_TEMPLATES.md', source => source.replace('MPX Issue ID', 'configured-provider Issue ID'));

await transform('content/instructions/shared/GIT_COMMIT_WORKFLOW.md', source => {
  source = source.replace('Extract an Issue identity from the branch using the repository\'s configured extraction command, if\npresent. Verify every candidate through the selected native provider guide\'s explicit-target Issue\nview command.', 'Extract explicit Issue identities from the branch name and commit messages. Verify every candidate\nthrough the independently selected Issue provider guide\'s explicit-target view command.');
  source = source.replace('\nMPX-Session: <session-reference>', '');
  source = source.replace('Add the `MPX-Session` trailer only when the runtime supplies an approved\nnon-secret reference. ', '');
  return source;
});

await transform('content/instructions/shared/ISSUE_TRACKER.md', source => source.replace(
`and load the matching [GitHub](providers/GITHUB.md), [GitLab](providers/GITLAB.md),
[KanbanFlow](providers/KANBANFLOW.md), [Gerrit](providers/GERRIT.md), or [Local](providers/LOCAL.md)
guide. Issue work uses only the Issue provider; PR and CI use only the repository provider. Native
authentication remains unchanged.`,
`and load the matching guide. Repository operations support [GitHub](providers/GITHUB.md),
[GitLab](providers/GITLAB.md), or [Gerrit](providers/GERRIT.md). Issue operations support
[GitHub](providers/GITHUB.md) or [KanbanFlow](providers/KANBANFLOW.md). The roles are independent.
[Local](providers/LOCAL.md) is explicitly unsupported; never reinterpret it as GitHub. Native
authentication remains unchanged.`));

await transform('content/instructions/shared/PROVIDER_ROUTING.md', source => {
  source = replaceOnce(source,
`Load exactly the selected [GitHub](providers/GITHUB.md), [GitLab](providers/GITLAB.md),
[KanbanFlow](providers/KANBANFLOW.md), [Gerrit](providers/GERRIT.md), or [Local](providers/LOCAL.md)
guide. \`generic\`, \`none\`, an unknown provider, a missing guide, or a role mismatch is unsupported.`,
`For repository operations, load exactly the selected [GitHub](providers/GITHUB.md),
[GitLab](providers/GITLAB.md), or [Gerrit](providers/GERRIT.md) guide. For Issue operations, load
exactly [GitHub](providers/GITHUB.md) or [KanbanFlow](providers/KANBANFLOW.md). The
[Local provider](providers/LOCAL.md) is explicitly unsupported. \`local\`, \`generic\`, \`none\`, an
unknown provider, a missing guide, or a role mismatch stops that branch; never substitute GitHub.`, 'provider matrix');
  source = source.replace('For local storage, use only the application entrypoint documented by its\nguide.', 'A local Issue provider is unsupported and receives a manual handoff.');
  source = source.replace('- Use only the selected native guide\'s documented commands or, for local Markdown, its documented\n  application entrypoint.', '- Use only the selected native guide\'s documented commands.');
  return source;
});

await transform('content/instructions/shared/providers/LOCAL.md', () => `# Local provider: unsupported

The native-first MPX2 contract does not implement or import a local Issue provider. If
\`issues.provider\` is \`local\`, stop the affected Issue branch and report that the provider is
unsupported. Do not reinterpret the value as GitHub, infer a provider from remotes, import a legacy
Markdown store, or route through old MPX application services.

Repository operations still use their independently configured GitHub, GitLab, or Gerrit provider.
Changing the Issue provider requires an explicit user configuration change.
`);
await transform('content/instructions/shared/providers/KANBANFLOW.md', source => source.replaceAll('manifest', 'project configuration'));
await transform('content/instructions/shared/providers/GITHUB.md', source => source
  .replace('Applies only when the selected role is `github`.', 'Applies when the independently selected repository or Issue role is `github`.')
  .replaceAll('launch-injected `GH_CONFIG_DIR`', 'existing `GH_CONFIG_DIR`'));
await transform('content/instructions/shared/providers/GITLAB.md', source => {
  source = source.replace('Applies only when the selected role is `gitlab`.', 'Applies only when `repository.provider` is `gitlab`. Issue-provider use is unsupported.');
  source = source.replaceAll('launch-injected `GLAB_CONFIG_DIR`', 'existing `GLAB_CONFIG_DIR`');
  const start = source.indexOf('## Issues and milestones');
  const end = source.indexOf('## Merge requests and CI');
  if (start === -1 || end === -1 || end <= start) throw new Error('GitLab issue section changed');
  return `${source.slice(0, start)}## Issue-provider boundary\n\nGitLab Issue operations are outside the MPX2 Issue-provider contract. Do not execute them or\nsubstitute GitLab for the independently selected GitHub or KanbanFlow Issue provider.\n\n${source.slice(end)}`;
});

await transform('content/instructions/shared/SENTRY.md', source => {
  source = source.replace('Sentry is an identity-owned approved tool route, not a standalone exposed skill.', 'Sentry uses only MCP tools already loaded by the native account, not a standalone exposed skill.');
  source = source.replace('Use only the Sentry capability bound to the immutable MPX launch identity. The adapter selects the\napproved account and authentication context. Never request, display, copy, exchange, or persist a\nSentry token. If the approved route is unavailable, stop with the structured handoff below.', 'Use only the Sentry capability already available in the native session. Native account settings own\nthe server and authentication. Never request, display, copy, exchange, route, or persist a Sentry\ntoken. If the native route is unavailable, stop with the structured handoff below.');
  source = source.replace('Select organization and project explicitly from the identity-authorized inventory.', 'Select organization and project explicitly from the native tool\'s authorized inventory.');
  source = source.replace('identity: <opaque launch identity or unavailable>\n', 'native route: <available or unavailable>\n');
  source = source.replace('When identity, organization/project selection, capability, or authorization is unavailable', 'When the native route, organization/project selection, capability, or authorization is unavailable');
  return source;
});

await transform('content/instructions/shared/SUBAGENT_PROTOCOL.md', source => {
  source = source.replace('A\nruntime resolver maps class to an available model and records the resolved model in execution\nevidence.', 'The content compiler maps each class through `content/runtime-profiles.json`; native execution\nevidence reports the model actually used.');
  source = source.replace('Fan out from the parent by default. Parent-owned workflows are a deliberate control-flow choice, not\na claim that nesting is unavailable: Pi\'s extension and Claude Code support bounded nested\ndelegation when an active workflow grants it. Sub-agents must not assume they can spawn children or\ninherit the parent\'s tools, repository instructions, git status, machine roots, or provider\nidentity.', 'Fan out from the parent. Nested orchestration is outside the version-one contract. Sub-agents must\nnot spawn children or assume they inherit the parent\'s tools, repository instructions, git status,\nmachine roots, or provider selection.');
  source = source.replace('Each projection records canonical source/version and adapter version. ', 'Generated projections are deterministic products of canonical content and runtime profiles. ');
  return source;
});

const rootInstruction = file => `Resolve \`MPX_ACTIVE_CONTENT_ROOT\` from the environment once to an absolute literal path. Read the
[${file.replace('.md', '').replaceAll('_', ' ').toLowerCase()}]({{MPX_SHARED_INSTRUCTIONS}}/${file}) at
\`<resolved-root>/dist/{{MPX_HARNESS}}/instructions/shared/${file}\`. If the variable is unset or the
contained file is unavailable, request a parent-resolved absolute root and stop; never search or guess.`;

await transform('content/agents/ci-analyzer.md', source => source.replace(
`Resolve the declared loaded content base, or \`MPX_ACTIVE_CONTENT_ROOT\` when set, once to an absolute
literal path. Read \`skills/shared/PROVIDER_ROUTING.md\` beneath that exact root, validate the nearest
\`mpxconfig.json\`, and load only the native guide selected by \`repository.provider\`. If the root,
configuration, provider guide, repository identity, or native interface is unavailable, return a
blocked handoff. Never infer a provider from remotes or switch providers.`,
`${rootInstruction('PROVIDER_ROUTING.md')} Validate the nearest \`mpxconfig.json\` and load only the native
guide selected by \`repository.provider\`. If configuration, provider guide, repository identity, or
native interface is unavailable, return a blocked handoff. Never infer or switch providers.`));
await transform('content/agents/executor.md', source => source.replace(
`Resolve the declared loaded content base, or \`MPX_ACTIVE_CONTENT_ROOT\` when set, once to an absolute
literal path. Read \`skills/shared/EXECUTOR_CONTRACT.md\` beneath that exact root. If neither root is
available, request a parent-resolved absolute content-root path and stop; never search fallback
roots or guess a checkout. Do not use an undefined shell variable in the read command.`, rootInstruction('EXECUTOR_CONTRACT.md')));
await transform('content/agents/git-committer.md', source => source.replace(
`Resolve \`skills/shared/GIT_COMMIT_WORKFLOW.md\` beneath the validated loaded content root or
\`MPX_ACTIVE_CONTENT_ROOT\` and read the literal absolute path. If neither root is available, request
the resolved path from the parent. Follow its **Commit Conventions** and **Safety** sections without
duplicating them here.`, `${rootInstruction('GIT_COMMIT_WORKFLOW.md')} Follow its **Commit Conventions** and **Safety** sections.`));
await transform('content/agents/issue-analyzer.md', source => {
  source = source.replace(
`When Issue data must be fetched, resolve the loaded content root and read
\`skills/shared/PROVIDER_ROUTING.md\`, then load \`mpxconfig.json\`, resolve \`issues.provider\`, and
explicitly select its native guide. Use only caller-supplied or configuration-validated
repository/project/board identifiers and the supplied positive Issue ID: GitHub and GitLab bind
every read to the validated repository/project, KanbanFlow uses the validated configured board, and
managed local Issues use the documented local interface. Never infer a target from the current
directory, switch providers, or use parent/sub-Issue APIs.`,
`When Issue data must be fetched, ${rootInstruction('PROVIDER_ROUTING.md')} Then load \`mpxconfig.json\`,
resolve \`issues.provider\`, and select only GitHub or KanbanFlow. Use caller-supplied or
configuration-validated repository/board identifiers and a positive Issue ID. A local, GitLab, or
unknown Issue provider is unsupported; never infer a target, switch providers, or use
parent/sub-Issue APIs.`);
  source = source.replace('immutable launch identity, ', 'native account context, ');
  return source;
});
await transform('content/agents/issue-finder.md', source => {
  source = source.replace(
`Read \`skills/shared/PROVIDER_ROUTING.md\` beneath the validated loaded content root or
\`MPX_ACTIVE_CONTENT_ROOT\`, using its literal absolute path. If neither root is available, request
the resolved path from the parent. Load the repository's \`mpxconfig.json\`, resolve
\`issues.provider\`, then read the matching guide under \`skills/shared/providers/\` in that same
content root.`, `${rootInstruction('PROVIDER_ROUTING.md')} Load the repository's \`mpxconfig.json\`, resolve
\`issues.provider\`, then read the matching projected guide under
\`<resolved-root>/dist/{{MPX_HARNESS}}/instructions/shared/providers/\`.`);
  source = source.replace(/- \*\*GitLab:\*\*[\s\S]*?- \*\*KanbanFlow:\*\*/, '- **KanbanFlow:**');
  source = source.replace('\n- **Local:** follow `LOCAL.md` and use only its documented application entrypoint.\n', '\n- **Local, GitLab, or unknown:** return an unsupported no-match result.\n');
  return source.replace('"github | gitlab | kanbanflow | local"', '"github | kanbanflow | unsupported"');
});
await transform('content/agents/review-manager.md', source => source.replace(
`Resolve the loaded content root and read Provider Routing, then load \`mpxconfig.json\`, resolve
\`repository.provider\` and \`repository.remote\`, and explicitly select
\`skills/shared/providers/GITHUB.md\`, \`GITLAB.md\`, or \`GERRIT.md\`. Validate the configured remote
with \`git remote get-url -- <repository.remote>\` and preserve the immutable launch identity and
authenticated environment.`, `${rootInstruction('PROVIDER_ROUTING.md')} Load \`mpxconfig.json\`, resolve
\`repository.provider\` and \`repository.remote\`, and select the projected GitHub, GitLab, or Gerrit
guide. Validate the configured remote with \`git remote get-url -- <repository.remote>\` and preserve
the native authenticated environment.`));
await transform('content/agents/tdd-executor.md', source => {
  source = source.replace(
`Resolve the declared loaded content base, or \`MPX_ACTIVE_CONTENT_ROOT\` when set, once to an absolute
literal path. Read \`skills/shared/EXECUTOR_CONTRACT.md\` beneath that exact root. If neither root is
available, request a parent-resolved absolute content-root path and stop; never search fallback
roots or guess a checkout. Do not use an undefined shell variable in the read command.`, rootInstruction('EXECUTOR_CONTRACT.md'));
  source = source.replace('- `skills/execute/tests.md` — good vs bad tests\n- `skills/execute/mocking.md` — when to mock\n- `skills/shared/deep-modules.md` — deep modules\n- `skills/shared/interface-design.md` — interfaces for testability', '- [executor tests]({{MPX_SHARED_INSTRUCTIONS}}/EXECUTOR_TESTS.md) — good vs bad tests\n- [executor mocking]({{MPX_SHARED_INSTRUCTIONS}}/EXECUTOR_MOCKING.md) — when to mock\n- [deep modules]({{MPX_SHARED_INSTRUCTIONS}}/deep-modules.md) — deep modules\n- [interface design]({{MPX_SHARED_INSTRUCTIONS}}/interface-design.md) — interfaces for testability');
  return source;
});
await transform('content/agents/unresolved-issue-tracker.md', source => {
  source = source.replace(
`Resolve the declared loaded content base, or \`MPX_ACTIVE_CONTENT_ROOT\` when set, once to an absolute
literal path. Read \`skills/shared/PROVIDER_ROUTING.md\` and the matching provider guide beneath that
exact root, then load \`mpxconfig.json\` and resolve \`issues.provider\`. If no loaded root is
available, request a parent-resolved absolute content-root path and stop; never search fallback
roots or guess a checkout.`, `${rootInstruction('PROVIDER_ROUTING.md')} Load \`mpxconfig.json\`, resolve
\`issues.provider\`, and read only the projected GitHub or KanbanFlow guide.`);
  source = source.replace(/- \*\*GitLab:\*\*[\s\S]*?- \*\*KanbanFlow:\*\*/, '- **KanbanFlow:**');
  source = source.replace('\n- **Local:** use only the application entrypoint documented by `LOCAL.md`.\n', '\nA local, GitLab, or unknown Issue provider is blocked; never substitute GitHub.\n');
  return source.replace('"github | gitlab | kanbanflow | local"', '"github | kanbanflow"');
});

await transform('content/agents/chrome-devtools-tester.md', source => {
  source = source.replace(
`Use an
existing parent-provided server by default; start, restart, or stop a local server only when the
parent explicitly supplies and authorizes the command, and report that server effect. Never edit
application source or configuration.`,
`Use only an existing parent-provided server URL. Project servers are started manually in Orca or a
project terminal. Do not start, restart, stop, or manage a server, and never edit application source
or configuration.`);
  source = source.replace('Use the runtime\'s MCP gateway to discover the session\'s `chrome-devtools` server and inspect each\ntool\'s current schema before calling it. Invoke the exact tool names and arguments returned by\ndiscovery; do not assume plugin-prefixed names or hard-code deferred body-tool schemas.', 'Use only the `chrome-devtools` MCP tools loaded by the native account. Inspect each current tool\nschema before calling it; do not assume prefixes or hard-code deferred tool schemas.');
  source = source.replace(/\nAn inline `mcpServers:` block was tried[\s\S]*?to take\.\n/, '\n');
  source = source.replace('[`../skills/shared/PLAYWRIGHT_TESTING.md`](../skills/shared/PLAYWRIGHT_TESTING.md)', '[Playwright Testing]({{MPX_SHARED_INSTRUCTIONS}}/PLAYWRIGHT_TESTING.md)');
  source = source.replace(
`Use parent-provided auth context when present. Otherwise read credentials from the first of these
that exists: \`.local/credentials.md\`, \`.local/CREDENTIALS.md\`, \`CREDENTIALS.md\`, \`.local/*.md\`,
\`.env.local\`, \`.env\`. Match keys case-insensitively — login keys \`login\`, \`username\`, \`user\`,
\`name\`, \`email\`; secret keys \`password\`, \`pass\`, \`secret\`, \`token\` — across \`key: value\`,
\`key=value\`, \`KEY="value"\`, table rows and bullets.

Use values **exactly as found**; copy them verbatim rather than reformatting or recombining parts of
a username or email.

Then \`fill_form\` (or \`fill\` per field) with the exact values, \`click\` submit, and \`wait_for\` the
navigation. Confirm with a fresh \`take_snapshot\`: a login form still on screen means the login
failed — mark affected tests \`BLOCKED\`. When the target page does not load after login,
\`navigate_page\` back to it; OAuth and SPA apps often need this after the token exchange.

Report credentials as \`[provided]\`, never as values.`,
`Use only parent-provided auth context. Never discover credentials, tokens, or environment secrets.
If required auth context is absent, mark affected tests \`BLOCKED\`. When context is supplied, use it
without reporting values, confirm the resulting page with a fresh \`take_snapshot\`, and mark a
remaining login form \`BLOCKED\`.`);
  return source;
});

// Native-first closure adaptations applied after the source-shaped transformations above.
const finalAdaptations = {
  'content/instructions/shared/AUTHORING.md': [
    ['Canonical content is runtime-neutral. Runtime adapters project identities, frontmatter, tool names,\nand invocation syntax; canonical files do not encode a particular harness.', 'Canonical content is runtime-neutral. The compiler projects identities, frontmatter, tool names, and\ninvocation syntax; canonical files do not encode a particular harness.'],
    ['- the exact canonical agent identity, such as `mpx-explorer`;', '- the exact projected agent identity, such as `mpx-explorer`;'],
  ],
  'content/instructions/shared/EXECUTOR_CONTRACT.md': [
    ['- scope summary, the selected typed or native provider interface when provider operations are\n  required, and an immutable MPX launch identity only when that interface/runtime supplies one;', '- scope summary, the selected native provider guide and explicit target when provider operations\n  are required;'],
  ],
  'content/instructions/shared/SUBAGENT_PROTOCOL.md': [
    ['Canonical rules for delegation, model classes, tools, evidence, and runtime drift. Runtime adapters\nresolve these policies to concrete harness fields and model IDs.', 'Canonical rules for delegation, model classes, tools, evidence, and runtime drift. The compiler and\nruntime profiles resolve these policies to concrete harness fields and model IDs.'],
    ['MCP-dependent work uses an identity-owned approved route. Check capability availability first.', 'MCP-dependent work uses tools loaded by native account settings. Check capability availability first.'],
    ['## Built-in overrides and discovery\n\nRuntime adapters may override built-ins to project canonical agents. Preserve any runtime-required\nidentity capitalization and routing description, keep the override body thin, and test reload and\nauto-delegation behavior on every adapter version change. These are projection concerns, not\ncanonical names.\n\n', ''],
  ],
  'content/instructions/shared/PLAYWRIGHT_TESTING.md': [
    ['Discover the project\'s runner, dev-server command and port, authentication route, and changed\nsurfaces from repository instructions, `package.json`, and referenced configuration. Follow the\nshared dev-server startup policy; use the actual server URL for browser checks. Credentials may be\nread from approved private local configuration but never hardcoded, echoed, copied into evidence, or\ncommitted.', 'Discover the project\'s runner, authentication route, and changed surfaces from repository\ninstructions, `package.json`, and referenced configuration. Use the actual server URL supplied by\nthe parent. Project servers are started manually in Orca or a project terminal unless a\nrepository-native test command owns its own server lifecycle. Use parent-provided test auth context\nor approved private project-local configuration; never hardcode, echo, publish, or commit credentials.'],
    ['Keep manual development-server auto-open behavior separate from automation. Start agent and E2E\nservers through the project\'s automation entry point with browser auto-open suppressed\n(`BROWSER=none` for Vite). Apply that environment only to the server child process, not the user\'s\nshell. Never use the OS-default browser as an automation fallback.', 'Keep manual development-server behavior separate from automation. A repository-native E2E command\nmay own a test server according to project configuration. Otherwise use the manually started server\nat the supplied URL; do not start, restart, stop, or manage it. Never use the OS-default browser as\nan automation fallback.'],
    ['   On mismatch, investigate stale content or a wrong-checkout server. Restart only a server owned by\n   this task; otherwise use a reliably configured alternative port or ask before stopping the\n   existing server. Repeat the freshness gate.', '   On mismatch, investigate stale content or a wrong-checkout server, then report `BLOCKED` with the\n   observed URL and freshness evidence. The user decides whether to restart or replace the server.\n   Repeat the freshness gate only after receiving a corrected URL.'],
    ["const base = process.env.BASE_URL ?? 'http://localhost:5173';", "const base = process.env.BASE_URL;\nif (!base) throw new Error('BASE_URL must be supplied by the parent');"],
  ],
  'content/agents/chrome-devtools-tester.md': [
    ['Persistent agent profiles require exclusive\nownership; report contention rather than forcing access. Suppress browser auto-open on authorized\nautomated server starts while preserving the user\'s manual development workflow.', 'Persistent agent profiles require exclusive\nownership; report contention rather than forcing access.'],
  ],
  'content/agents/context7-docs-fetcher.md': [
    ["Discover the session's `context7` MCP server through the runtime MCP gateway, inspect the current\nlibrary-resolution tool schema, and invoke the exact discovered tool name and arguments. Do not\nassume plugin-prefixed names or hard-coded body schemas.", 'Use the `context7` MCP tools loaded by the native account. Inspect the current library-resolution\ntool schema, and invoke its exact name and arguments. Do not assume plugin-prefixed names or\nhard-coded body schemas.'],
    ['Inspect the current documentation-query tool schema through the same MCP gateway and invoke the\nexact discovered tool name', 'Inspect the current native documentation-query tool schema and invoke its exact tool name'],
  ],
  'content/agents/issue-finder.md': [
    ['Provider-specific closing syntax belongs only in `statement` (`Closes #42` for GitHub/GitLab when\nsupported); links in PR bodies are allowed, but do not call native parent/sub-Issue APIs.', 'Provider-specific closing syntax belongs only in `statement` (`Closes #42` for GitHub when the\nrepository and Issue target are the same and the GitHub guide supports it). Cross-provider links in\nPR bodies use canonical URLs without a closing keyword. Do not call native parent/sub-Issue APIs.'],
  ],
  'content/agents/git-committer.md': [
    ['compound `mpx commit-push*` skills', 'compound `{{MPX_SKILL_COMMAND}}commit-push*` skills'],
  ],
};
for (const [relative, replacements] of Object.entries(finalAdaptations)) {
  await transform(relative, source => replacements.reduce(
    (text, [before, after]) => replaceOnce(text, before, after, `${relative} final adaptation`),
    source,
  ));
}

// Keep the original project-test authentication mechanism; this is not credential routing.
const browserSource = await fs.readFile(path.join(sourceRoot, 'agents/mpx-chrome-devtools-tester.md'), 'utf8');
const browserFile = path.join(root, 'content/agents/chrome-devtools-tester.md');
const authSection = browserSource.slice(browserSource.indexOf('### 2. Authenticate'), browserSource.indexOf('### 3. Execute the requirements'));
await fs.writeFile(browserFile, (await fs.readFile(browserFile, 'utf8')).replace(/### 2\. Authenticate[\s\S]*?(?=### 3\. Execute the requirements)/, authSection));

const copiedRules = planned.filter(item => item.destination.includes(`${path.sep}content${path.sep}rules${path.sep}`));
for (const item of copiedRules) {
  if (!(await fs.readFile(item.source)).equals(await fs.readFile(item.destination))) throw new Error(`Rule bytes changed: ${item.source}`);
}
console.log(JSON.stringify({ transferred: planned.length, agents: Object.keys(agents).length, rulesByteEqual: copiedRules.length }, null, 2));

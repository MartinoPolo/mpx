#!/usr/bin/env node
// One bounded transfer from the dirty canonical MPX skill source. The transfer copies every
// owned file before applying the reviewed native-first adaptations below. It never edits legacy
// sources or overwrites an existing MPX2 destination.
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
if (!process.env.MPX_PROJECTS || !path.isAbsolute(process.env.MPX_PROJECTS)) {
  throw new Error('An absolute MPX_PROJECTS is required; no source root is guessed.');
}
const sourceRoot = path.join(process.env.MPX_PROJECTS, 'mpx', 'content', 'skills');
const skillNames = [
  'agent-create', 'architecture-review', 'board-setup', 'clean-pc', 'code-clean',
  'components-audit', 'consolidate-context', 'fallow-fix', 'hitl', 'init-github-repo',
  'notebooklm', 'playwright-test', 'podcast', 'project-register', 'raycast-config',
  'script-discovery', 'setup-react-native', 'setup-sveltekit', 'skill-audit', 'skill-create',
  'suppression-audit', 'symlink', 'tutorial-create', 'video-to-image', 'vocabulary',
];

async function walk(directory, relative = '') {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path.join(directory, entry.name), child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`Unsupported source entry: ${path.join(directory, entry.name)}`);
  }
  return files;
}

const planned = [];
for (const skill of skillNames) {
  for (const relative of await walk(path.join(sourceRoot, skill))) {
    planned.push({
      source: path.join(sourceRoot, skill, relative),
      destination: path.join(root, 'content', 'skills', skill, relative),
      relative: path.posix.join('content', 'skills', skill, relative),
    });
  }
}
for (const item of planned) {
  if (await fs.access(item.destination).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error))) {
    throw new Error(`Refusing to overwrite existing destination: ${item.destination}`);
  }
}
// The first mutation is always the byte-exact copy of the complete bounded source closure.
for (const item of planned) {
  await fs.mkdir(path.dirname(item.destination), { recursive: true });
  await fs.copyFile(item.source, item.destination);
  if (!(await fs.readFile(item.source)).equals(await fs.readFile(item.destination))) {
    throw new Error(`Initial copy changed bytes: ${item.relative}`);
  }
}

function replaceOnce(text, before, after, label) {
  if (text.split(before).length !== 2) throw new Error(`${label}: expected one exact source block`);
  return text.replace(before, after);
}
async function transform(relative, change) {
  const file = path.join(root, relative);
  const before = await fs.readFile(file, 'utf8');
  const after = change(before);
  if (after === before) throw new Error(`Expected targeted adaptation did not change ${relative}`);
  await fs.writeFile(file, after);
}

// Normalize only compiler-owned skill metadata and projection-dependent references. Pack and
// exposure values come from each dirty source SKILL.md; no separate inventory guesses them.
for (const item of planned.filter(item => item.destination.toLowerCase().endsWith('.md'))) {
  const before = await fs.readFile(item.destination, 'utf8');
  let after = before;
  if (path.basename(item.destination).toLowerCase() === 'skill.md') {
    after = after.replace(/^    (?:contentVersion|capabilities):.*\r?\n/gm, '');
    after = after.replace(/^    defaultExposure: full$/gm, '    defaultExposure: normal');
    after = after.replace(/^    defaultExposure: summary$/gm, '    defaultExposure: name-only');
  }
  after = after.replace(/(?:\.\.\/)+shared\//g, '{{MPX_SHARED_INSTRUCTIONS}}/');
  after = after.replaceAll('/mpx:', '{{MPX_SKILL_COMMAND}}');
  after = after.replaceAll('../raycast-config/SKILL.md', '../{{MPX_SKILL_PREFIX}}raycast-config/SKILL.md');
  if (after !== before) await fs.writeFile(item.destination, after);
}

await transform('content/skills/agent-create/SKILL.md', source => source
  .replace('configured canonical agent root from\n   manifests and existing artifacts', 'configured canonical agent root from\n   repository configuration, compiler contracts, and existing artifacts'));

await transform('content/skills/architecture-review/SKILL.md', source => replaceOnce(source,
`Use only the selected provider guide's documented
Issue-create operation: a native operation for hosted providers or the Local guide's application
entrypoint. Preserve immutable launch identity and its account-bound environment for every provider
operation. If provider routing, identity, capability, or the required label is unavailable, return
an exact manual handoff instead of switching providers or identities.`,
`Use only the selected Issue provider guide's documented Issue-create operation. GitHub and
KanbanFlow are supported; local, GitLab, Gerrit, and unknown Issue providers receive an exact manual
handoff. Preserve the native authenticated environment and explicit target for every operation. If
provider routing, capability, authentication, or the required label is unavailable, return the
manual handoff instead of switching providers, accounts, or targets.`, 'architecture provider boundary'));

await transform('content/skills/board-setup/SKILL.md', source => source
  .replace('use `project.id` as the\n  canonical project identity.', 'use `projectId` as the\n  canonical project identity.')
  .replace('use its required `boardId` and\n  optional `boardName` as the board selection', 'read required `boardId` and optional `boardName` from\n  `issues.metadata` as the board selection')
  .replace(`Run the setup script with the resolved paths (PowerShell tool):

\`\`\`powershell
& "./scripts/link-board.ps1" -Repo "<repo>" -Vault "<vault>" -Project "<project>"
\`\`\``, `Resolve the bundled script directory, then run the setup script through public Git Bash:

\`\`\`bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<skill-dir>/scripts/link-board.ps1" -Repo "<repo>" -Vault "<vault>" -Project "<project>"
\`\`\``));

await transform('content/skills/clean-pc/SKILL.md', source => source
  .replace('Build an HTML dashboard with the `Artifact` tool, ranked by reclaimable GB: group, domain, size,\nage, destination, confidence, reason.', 'Build a self-contained HTML dashboard in the unique session scratch directory, ranked by\nreclaimable GB: group, domain, size, age, destination, confidence, reason. Present its absolute\n`file:///` URL so the user can open it in Orca or their browser.')
  .replace('use `AskUserQuestion` with', 'use the native structured question UI with'));
await transform('content/skills/clean-pc/WINDOWS.md', source => replaceOnce(source,
`**1. Run every deletion through the PowerShell tool.** The \`dangerous-command-guard.mjs\` hook is
registered \`PreToolUse\` with \`matcher: "Bash"\`, so it inspects Bash only. It blocks \`rmdir /s\`,
\`del /f /q /s\`, and \`rm -rf <single-component-name>\` outside its allowlist. The PowerShell tool is
not intercepted, and PowerShell is the right tool for this work anyway. Route deletions through
\`scripts/Invoke-Removal.ps1\`.`,
`**1. Run every deletion through the bundled removal helper.** Invoke PowerShell from public Git
Bash so the installed dangerous-command guard inspects the complete shell invocation. Route all
approved deletion groups through \`scripts/Invoke-Removal.ps1\`; never bypass the guard with another
tool path or issue an inline deletion as a substitute.`, 'clean-pc safeguard routing'));

await transform('content/skills/consolidate-context/SKILL.md', source => source
  .replace('`skills/shared/DOCUMENTATION_STRATEGY.md` beneath it', '`dist/{{MPX_HARNESS}}/instructions/shared/DOCUMENTATION_STRATEGY.md` beneath it'));

await transform('content/skills/components-audit/SKILL.md', source => source
  .replace('then run the project\'s typecheck (`npm run check`/`pnpm check`/`tsc`). Distinguish\n   pre-existing errors from new ones', 'then run the narrow repository-documented validation applicable to the touched files. Use an\n   existing project check script when documented; do not impose or guess a global typecheck command. Distinguish\n   pre-existing errors from new ones')
  .replace('Typecheck: [clean | N new errors | not run]', 'Validation: [clean | N new errors | unavailable/not run]'));

await transform('content/skills/fallow-fix/SKILL.md', source => {
  source = replaceOnce(source,
`Run the appropriate diagnostic command based on what failed:

- **Dead-code regression** (\`check:fallow\` failed): output already shows all issues with file:line
  and rule explanations
- **Audit failure** (fallow-gate hook blocked commit/push): \`pnpm fallow:audit\` for JSON details
- **Need more detail**: re-run \`pnpm check:fallow\` — \`--explain\` includes rule descriptions and docs
  URLs`,
`Confirm the repository is opted into Fallow through recognized repository configuration. Read its
\`package.json\` and use only the project-owned package-manager scripts or local dependency; never a
global executable, automatic download, or guessed script. Then select the appropriate diagnostic:

- **Dead-code regression**: the failed project script output already shows issues with file:line and
  rule explanations
- **Audit failure**: run the configured audit script through \`<pm> run <audit-script>\` for JSON
  details
- **Need more detail**: re-run the configured project check script with its documented explain flag`, 'fallow diagnostics');
  source = source.replace(`\`\`\`bash
pnpm fallow:baseline
\`\`\``, `\`\`\`bash
<pm> run <configured-baseline-script>
\`\`\``);
  source = source.replace(`After all fixes and any baseline update, run the original failing check once as final verification:

- \`pnpm check:fallow\` — must exit 0
- \`pnpm fallow:audit\` — verdict must be \`pass\` or \`warn\`

If both commands were part of the original failure path, run each once.`, `After all fixes and any baseline update, run the original project-owned failing command once as
final verification. A dead-code check must exit 0; an audit verdict must be \`pass\` or \`warn\`.
If both configured commands were part of the original failure path, run each once.`);
  return source;
});

await transform('content/skills/hitl/SKILL.md', source => source
  .replace('Preserve launch identity and privacy.', 'Preserve the native authenticated environment, explicit provider target, and privacy.'));
await transform('content/skills/init-github-repo/SKILL.md', source => source
  .replace('Preserve the active GitHub account and launch-bound environment.', 'Preserve the active native GitHub authentication and environment.')
  .replace('at\n`skills/init-github-repo/scripts/init-repo.mjs` beneath `MPX_ACTIVE_CONTENT_ROOT` using\n[Content Paths]({{MPX_SHARED_INSTRUCTIONS}}/CONTENT_PATHS.md). Store its validated literal absolute path as\n`<initializer>`, then run:', 'relative to this loaded skill. Store its validated literal absolute path as `<initializer>`, then run:'));

await transform('content/skills/notebooklm/SKILL.md', source => {
  source = source.replace('**Explicit:** User says "/notebooklm", "use notebooklm", or mentions the tool by name', '**Explicit:** User invokes `{{MPX_SKILL_COMMAND}}notebooklm`, says "use notebooklm", or mentions the tool by name');
  return replaceOnce(source,
`**Skill install methods:**

- \`notebooklm skill install\` installs this skill into the supported local agent directories managed
  by the CLI.
- \`npx skills add teng-lin/notebooklm-py\` installs this skill from the GitHub repository into
  compatible agent skill directories.
- If you are already reading this file inside an agent skill directory, the skill is already
  installed. You only need the Python package and authentication below.

**CLI-managed install:**

\`\`\`bash
notebooklm skill install
\`\`\`

`,
`**MPX packaging:** This loaded skill is already installed by the MPX2 content compiler. Do not run
the upstream skill installers or write another agent skill root. Only the Python package and native
NotebookLM authentication below are external prerequisites.

`, 'notebooklm packaging');
});

await transform('content/skills/playwright-test/SKILL.md', source => {
  source = source.replace('under the immutable launch identity', 'against the explicit repository target in the native authenticated environment');
  source = source.replace('the dev-server start command and **exact port**, the sign-in API + seed users, and where credentials\nlive (`.local/`, `.env.local`).', 'the parent-provided server URL, the sign-in API + seed users, and the approved project test-login\ncredential locations (`.local/`, `.env.local`). Preserve this project-owned credential reading and\nnever print or publish values.');
  source = source.replace('the surface list (with the route + what changed for each), the discovered runner/port/auth details,', 'the surface list (with the route + what changed for each), the discovered runner/server-URL/auth details,');
  return replaceOnce(source,
`The sanity-gate is load-bearing: if the running dev server does not reflect the code under test, the
sub-agent must kill the stale server, verify that its port is released, and start a replacement
bound to this checkout before verifying.`,
`The sanity-gate is load-bearing: if the supplied server does not reflect the code under test, the
sub-agent reports every affected surface \`BLOCKED\` with freshness evidence. Project servers are
started and managed manually in Orca or a project terminal; this skill never kills, starts,
restarts, or replaces one.`, 'playwright server ownership');
});

await transform('content/skills/podcast/SKILL.md', source => source
  .replace("Resolve machine roots with `env | grep '^MPX_'`. A root that comes back unset is unavailable —", 'Resolve only `MPX_PROJECTS`, `MPX_CLONED`, `MPX_WORK`, `MPX_OBSIDIAN_VAULT`, and\n`MPX_AI_GENERATED` from the environment. A root that is unset is unavailable —')
  .replace("an instruction to resolve it at runtime with\n`env | grep '^MPX_'`", 'the already resolved literal root')
  .replace('Full CLI surface:\n`{{MPX_SKILL_COMMAND}}notebooklm`.', 'Full CLI surface: `{{MPX_SKILL_COMMAND}}notebooklm`.'));
await transform('content/skills/project-register/SKILL.md', source => {
  source = source.replace('Skills referenced below (`board-setup`, `design-init`) are read-and-follow, per the global\n"Cross-skill references" rule in `instructions/AGENTS.md`.', 'Follow-up skills below use their native commands. They run only when selected and available in the\nactive pack.');
  source = replaceOnce(source,
`1. Gate on the Raycast export
2. Resolve the project
3. Choose the colour
4. Draw the icon
5. Add the Windows Terminal profile
6. Write the VS Code Peacock block
7. Register dev-server ports
8. Hand quicklinks to \`raycast-config\`
9. Optionally register the project in the Obsidian task overview
10. Offer the remaining setup skills`,
`1. Gate on the Raycast export
2. Resolve the project
3. Validate or create user-owned \`mpxconfig.json\` metadata
4. Choose the colour
5. Draw the icon
6. Add the Windows Terminal profile
7. Write the VS Code Peacock block
8. Report an Orca project handoff snippet
9. Hand quicklinks to \`raycast-config\`
10. Optionally register the project in the Obsidian task overview
11. Offer the remaining setup skills`, 'project-register process');
  source = source.replace("Resolve `MPX_PROJECTS` and `MPX_WORK` with `env | grep '^MPX_'`", 'Resolve only `MPX_PROJECTS` and `MPX_WORK` from the process environment');
  source = source.replace('Confirm the choice with `AskUserQuestion`, offering the suggestion plus two alternatives.', 'Confirm the choice with the native structured question UI, offering the suggestion plus two alternatives.');
  source = source.replace('the folder. Render to the session scratchpad first, **show it to the user with `Read`**, and copy it', 'the folder. Render to the unique session scratch directory first, **show it to the user with the\nnative image-reading capability**, and copy it');
  source = source.replace('explicitly. Use `AskUserQuestion` to ask which group the project belongs to (mpx tooling, work\nrepositories, or leave it in the catch-all), then `Edit` the settings file to insert', 'explicitly. Use the native structured question UI to ask which group the project belongs to (mpx\ntooling, work repositories, or leave it in the catch-all), then edit the settings file to insert');
  const step3 = `### Step 3: Validate or create user-owned MPX metadata

For a Git repository, manage \`<project>/mpxconfig.json\` as user-owned metadata. If it exists,
parse it and require exactly this native schema before changing another field: \`projectId\`;
\`repository: { provider, remote }\`; \`issues: { provider, metadata? }\`; and optional
\`packageManager\` and \`packs\`. Repository providers are independently one of GitHub, GitLab, or
Gerrit. Issue providers are independently GitHub or KanbanFlow; local Issues are unsupported.
Malformed or unknown fields block this branch and remain untouched.

When the file is missing, gather and confirm the complete values. Propose the folder name as
\`projectId\`; require an explicit repository provider and remote; require an independent Issue
provider and its target metadata (for KanbanFlow, \`boardId\` and optional \`boardName\`; for GitHub,
the explicit Issue repository when it differs); detect a package manager only from repository files;
and ask for selected packs only when the user wants to replace wrapper defaults. Show the complete
JSON before writing it. Write only after confirmation, preserve an explicit empty \`packs: []\`,
then parse the written file again and report its path and values. Never add credentials, account
routing, workspace/session state, ports, or Orca settings.

A folder without Git may still receive the desktop integrations below, but it cannot receive valid
repository metadata. Record MPX metadata as pending rather than inventing a provider or initializing
or publishing a repository.

`;
  source = source.replace('### Step 3: Choose the colour', `${step3}### Step 4: Choose the colour`)
    .replace('### Step 4: Draw the icon', '### Step 5: Draw the icon')
    .replace('### Step 5: Add the Windows Terminal profile', '### Step 6: Add the Windows Terminal profile')
    .replace('### Step 6: Write the VS Code Peacock colour', '### Step 7: Write the VS Code Peacock colour');
  source = replaceOnce(source,
`### Step 7: Optionally register dev-server ports

When the project serves on localhost, read ports from its own scripts, Vite configuration, or
compose files; do not assume framework defaults. First resolve whether the active runtime exposes a
**documented writable status-line project registry capability**. If present, use its runtime-owned
path; no repository-local generated-content path should be inferred or mutated. If no writable
capability is available, provide the project key and discovered ports as a manual handoff and report
the surface as unsupported; skip projects with no server and report why.

### Step 8: Hand quicklinks to \`raycast-config\``,
`### Step 8: Report the Orca handoff

Orca owns checkout opening, terminal orchestration, status, labels, and development-port visibility.
Do not edit or infer Orca configuration. Report this copyable field-value snippet for the user to
map into Orca's current native project UI or schema:

\`\`\`yaml
project:
  path: "<absolute project path>"
  label: "<projectId or folder name>"
  color: "#RRGGBB"
  icon: "<absolute accepted icon path>"
  terminalProfile: "<folder name>"
\`\`\`

When repository scripts expose development ports, list them as informational Orca labels beside the
snippet; do not reserve, assign, persist, or manage ports.

### Step 9: Hand quicklinks to \`raycast-config\``, 'project-register Orca ownership');
  source = source.replace('### Step 9: Register the project in the Obsidian task overview', '### Step 10: Register the project in the Obsidian task overview')
    .replace('### Step 10: Offer the remaining setup skills', '### Step 11: Offer the remaining setup skills')
    .replace('optional status-line capability,\nRaycast', '`mpxconfig.json`, Orca handoff, Raycast');
  source = source.replace('using the export (or skip) from step 1.', 'using the export (or skip) from step 1.');
  return source;
});

await transform('content/skills/raycast-config/SKILL.md', source => source
  .replace('with `AskUserQuestion` — never pick a file on their behalf.', 'with the native structured question UI — never pick a file on their behalf.')
  .replace('Use `AskUserQuestion` for choices that change the outcome:', 'Use the native structured question UI for choices that change the outcome:'));

await transform('content/skills/script-discovery/SKILL.md', source => source
  .replace('read `MPX_ACTIVE_CONTENT_ROOT`, require it to be an absolute\npath, and resolve `skills/script-discovery/scripts/detect-project-scripts.mjs` beneath it. Verify\nthat the literal result exists and remains contained by that root; otherwise stop and report the\nfailed condition. Do not search ordered roots or guess an installation checkout. Store the validated\nliteral absolute path as `SCRIPT_DETECTOR`;', 'follow [Content Paths]({{MPX_SHARED_INSTRUCTIONS}}/CONTENT_PATHS.md) to resolve this skill\nprojection and its `scripts/detect-project-scripts.mjs`. Verify the literal result exists and\nremains contained by that projection; otherwise stop and report the failed condition. Store the\nvalidated literal absolute path as `SCRIPT_DETECTOR`;'));

await transform('content/skills/setup-react-native/SKILL.md', source => source
  .replace('Preserve the immutable launch identity and account-bound CLI\nenvironment.', 'Preserve the selected native account authentication and CLI environment.'));
await transform('content/skills/setup-react-native/PLATFORM_REFERENCE.md', source => source
  .replace('The source is `rules-per-project/react.md` beneath an authorized MPX content/repository root.\nResolve it relative to known compiled content first, then through\n[CONTENT_PATHS]({{MPX_SHARED_INSTRUCTIONS}}/CONTENT_PATHS.md).', 'The source is the projected `rules/projects/react.md` beneath the active MPX2 content root. Resolve\nit through [CONTENT_PATHS]({{MPX_SHARED_INSTRUCTIONS}}/CONTENT_PATHS.md).'));
await transform('content/skills/setup-sveltekit/SKILL.md', source => source
  .replace('load its native\nprovider guide, and preserve the immutable launch identity.', 'load its native provider guide, and preserve the selected native account authentication.')
  .replace('npx -C <path> sv add mcp', 'cd <path> && pnpm dlx sv add mcp')
  .replace('Verify the portable user-level Svelte rule at the runtime\'s configured rules location. If the\n   runtime uses `~/.claude/rules`, run:', 'Verify the compiler-projected Svelte rule through the active native account location. For a\n   configured Claude account root, inspect its `rules/svelte.md` link:')
  .replace('ls -la ~/.claude/rules/svelte.md', 'ls -la "<configured-claude-account-root>/rules/svelte.md"'));

await transform('content/skills/skill-audit/SKILL.md', source => source
  .replace('repository manifests,\n   content/compiler manifests, runtime-profile configuration', 'repository configuration, compiler contracts,\n   runtime-profile configuration')
  .replace('or script, relevant manifests, and the runtime profiles', 'or script, relevant repository configuration and compiler contracts, and the runtime profiles')
  .replace('Require `name`, portable `description`, and `metadata.mpx` fields\n   accepted by the current canonical schema: `schemaVersion`, `skillPacks`, and `defaultExposure`;\n   validate optional `contentVersion`, `capabilities`, `argument-hint`, and `triggers` when present.', 'Require `name`, portable `description`, and only the `metadata.mpx` fields accepted by the\n   current compiler schema: `schemaVersion`, `skillPacks`, and optional `defaultExposure`. Validate\n   top-level `argument-hint` and `triggers` when present.'));

await transform('content/skills/skill-create/SKILL.md', source => {
  source = source.replace('Discover the configured canonical skill root from repository\n   manifests;', 'Discover the configured canonical skill root from repository configuration and compiler contracts;');
  source = replaceOnce(source,
`       schemaVersion: 1
       contentVersion: 1
       skillPacks: [<configured pack>]
       defaultExposure: <explicit-only|name-only|summary|full>
       capabilities: [<semantic capabilities actually used>]`,
`       schemaVersion: 1
       skillPacks: [<configured pack>]
       defaultExposure: <explicit-only|name-only|normal>`, 'skill-create current metadata');
  source = source.replace('The compiler translates `defaultExposure`, `argument-hint`, and\n   semantic capabilities into each supported runtime\'s native invocation policy, frontmatter, tools,\n   and packaging.', 'The compiler translates `defaultExposure`, names, and declared body placeholders into each\n   supported runtime\'s native invocation policy, frontmatter, commands, and packaging.');
  source = source.replace('grant every used capability and no\n   unused one, and ensure', 'keep runtime-only grants out of skill metadata, and ensure');
  return source;
});

await transform('content/skills/suppression-audit/SKILL.md', source => source
  .replace('Resolve the canonical\n`skills/check-fix/scripts/detect-check-scripts.mjs` beneath `MPX_ACTIVE_CONTENT_ROOT` as instructed\nthere, validate it, and store its literal absolute path as `<detector>`. Do not use a\ncaller-checkout `./scripts` path or search for a fallback.', 'Resolve the sibling compiled skill script at\n`../{{MPX_SKILL_PREFIX}}check-fix/scripts/detect-check-scripts.mjs`, validate it, and store its\nliteral absolute path as `<detector>`. If that supporting skill is unavailable in the active pack,\nreport the dependency and stop this workflow rather than searching or guessing another root.')
  .replace('Then use `{{MPX_SKILL_COMMAND}}commit-push-pr` to commit all changes and create a PR.', 'Then invoke `{{MPX_SKILL_COMMAND}}commit-push-pr` to commit all changes and create a PR.'));

await transform('content/skills/symlink/SKILL.md', source => source
  .replace('with the **PowerShell tool** (`New-Item`).', 'by invoking **PowerShell from public Git Bash** (`powershell.exe ... New-Item`).')
  .replace('from the Bash tool', 'through Git Bash')
  .replace('## Step 3: Create the link (PowerShell tool)', '## Step 3: Create the link through Git Bash')
  .replace('```powershell\nNew-Item -ItemType Junction -Path "C:\\link\\path\\name"', '```bash\npowershell.exe -NoProfile -NonInteractive -Command "New-Item -ItemType Junction -Path \'C:\\link\\path\\name\'')
  .replace('-Target "C:\\repo\\real\\dir"\n```', '-Target \'C:\\repo\\real\\dir\' | Out-Null"\n```')
  .replace('```powershell\nNew-Item -ItemType SymbolicLink -Path "C:\\link\\path\\file.md" -Target "C:\\repo\\real\\file.md"\n```', '```bash\npowershell.exe -NoProfile -NonInteractive -Command "New-Item -ItemType SymbolicLink -Path \'C:\\link\\path\\file.md\' -Target \'C:\\repo\\real\\file.md\' | Out-Null"\n```')
  .replace('via the PowerShell tool.', 'through the reviewed PowerShell command.'));

await transform('content/skills/tutorial-create/SKILL.md', source => source
  .replace("Resolve `MPX_AI_GENERATED` with `env | grep '^MPX_'` before writing", 'Resolve only `MPX_AI_GENERATED` from the process environment before writing')
  .replace(String.raw`cd <skill-dir> && node scripts/compile.js "$MPX_AI_GENERATED\_TUTORIALS\<category>\<slug>.source.md"`, 'node "<skill-dir>/scripts/compile.js" "$MPX_AI_GENERATED/_TUTORIALS/<category>/<slug>.source.md"')
  .replace('First run only: `pnpm install` in `<skill-dir>` (Shiki + yaml + @mermaid-js/mermaid-cli; offline\nafterwards). Mermaid blocks compile to inline SVG in light and dark variants; if mermaid-cli is\nmissing the build prints a "diagram skipped" warning and still succeeds.', 'Shiki and yaml come from the MPX2 package installation. Do not install dependencies or edit files\ninside committed skill projections. Mermaid additionally requires `@mermaid-js/mermaid-cli` and\nits browser dependency in the MPX2 installation; request explicit dependency setup when needed.\nMermaid blocks compile to inline SVG in light and dark variants. If the optional renderer is missing,\nthe build prints a "diagram skipped" warning and still succeeds; report that limitation, never claim\nthe missing diagrams were rendered.'));
await transform('content/skills/video-to-image/SKILL.md', source => source
  .replace("Resolve machine roots with `env | grep '^MPX_'` before Step 3", 'Resolve only `MPX_AI_GENERATED` from the process environment before Step 3'));

const tutorialTokens = [
  'META_COMMENT', 'TITLE', 'SUBTITLE', 'BRAND_SMALL', 'TYPE_LABEL', 'TYPE_LABEL_LOWER', 'DATE',
  'READ_MIN', 'SECTION_COUNT', 'SECTION_COUNT_WORD', 'SLUG', 'TOC_ITEMS', 'VIDEOS', 'SECTIONS',
  'REFERENCES', 'QUIZ', 'GLOSSARY_JSON', 'SLUGS_JSON',
];
for (const relative of [
  'content/skills/tutorial-create/TEMPLATE.html',
  'content/skills/tutorial-create/scripts/compile.js',
]) {
  await transform(relative, source => tutorialTokens.reduce(
    (text, token) => text.replaceAll(`{{${token}}}`, `{{tutorial_${token.toLowerCase()}}}`),
    source,
  ));
}

await transform('content/skills/tutorial-create/scripts/compile.js', source => source.replace(
  String.raw`const leftover = html.match(/\{\{[A-Z_]+\}\}/);`,
  String.raw`const leftover = html.match(/\{\{(?:tutorial_[a-z_]+|[A-Z_]+)\}\}/);`,
));

// Verify every support file not explicitly adapted above remains byte-identical. Markdown support
// may contain compiler placeholders or reviewed native-first adaptations; binary/script/template
// bytes are canonical source bytes.
const adaptedSupport = new Set([
  'content/skills/clean-pc/WINDOWS.md',
  'content/skills/podcast/reference/NOTEBOOKLM_FLOW.md',
  'content/skills/setup-react-native/PLATFORM_REFERENCE.md',
  'content/skills/tutorial-create/TEMPLATE.html',
  'content/skills/tutorial-create/scripts/compile.js',
]);
let exactSupportFiles = 0;
for (const item of planned.filter(item => path.basename(item.destination).toLowerCase() !== 'skill.md')) {
  if (adaptedSupport.has(item.relative)) continue;
  if (!(await fs.readFile(item.source)).equals(await fs.readFile(item.destination))) {
    throw new Error(`Undeclared support-file byte change: ${item.relative}`);
  }
  exactSupportFiles += 1;
}
console.log(JSON.stringify({ skills: skillNames.length, transferred: planned.length, exactSupportFiles }, null, 2));

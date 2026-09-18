import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { projectContent } from '../src/compiler.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const contentRoot = path.join(root, 'content', 'skills');
const skills = {
  'agent-create': ['development', 'explicit-only', 'Create a focused custom agent'],
  'board-setup': ['development', 'explicit-only', 'four-lane skeleton'],
  'clean-pc': ['personal', 'explicit-only', 'measured free-space delta'],
  'code-clean': ['development', 'name-only', 'Spawn Fix Subagents'],
  'components-audit': ['development', 'name-only', 'Hardcoded theme-color bypass'],
  'fallow-fix': ['development', 'name-only', 'Prefer removing dead code'],
  hitl: ['development', 'explicit-only', 'Recompute the graph after every update'],
  'init-github-repo': ['development', 'name-only', 'Protect main and dev'],
  notebooklm: ['development', 'name-only', 'Agent Setup Verification'],
  'playwright-test': ['development', 'explicit-only', 'per-surface table'],
  podcast: ['personal', 'explicit-only', 'Topic to Personalized Podcast'],
  'project-register': ['personal', 'explicit-only', 'user-owned MPX metadata'],
  'raycast-config': ['personal', 'explicit-only', 'Read and rewrite the Raycast quicklink set'],
  'script-discovery': ['development', 'name-only', 'Detector Contract'],
  'setup-react-native': ['development', 'explicit-only', 'Setup React Native Monorepo'],
  'setup-sveltekit': ['development', 'explicit-only', 'SvelteKit Project Setup'],
  'skill-audit': ['development', 'name-only', 'Semantic completion'],
  'skill-create': ['development', 'name-only', 'Draft canonical files'],
  'suppression-audit': ['development', 'name-only', 'Evaluate Each Suppression'],
  symlink: ['development', 'name-only', 'Windows Symlinks & Junctions'],
  'tutorial-create': ['personal', 'explicit-only', 'Outline Gate'],
  'video-to-image': ['personal', 'explicit-only', 'Gemini watches the video'],
} as const;

const exactSupportHashes: Record<string, string> = {
  'board-setup/scripts/link-board.ps1': 'b5f4e80e038ceb8d9c46a2737f35b12140fe9df34a8dcb4cdbdefaa32a5cc196',
  'clean-pc/DOMAINS.md': '049503a589dea49a003e9e8ef460e6ef9eed35b8b7ad09c1c6a7802dafc1a3a3',
  'clean-pc/LINUX.md': '85485a4c09053f13b38005036102ca847ad1b661270f24b1c228b84aa593fc7e',
  'clean-pc/MACOS.md': '430dfc632742d796798c2c3aa965cb76f19992a369487b4d8d2ca5052a137941',
  'clean-pc/scripts/Find-BuildArtifacts.ps1': '337f3d8101b73ad3dd4911d971965c139d66e59722333599d9dda0cff08cb0ff',
  'clean-pc/scripts/Find-Duplicates.ps1': '5ea181c720240a48f32be10210831522c302f1a7f8d03783e947f68d77f393f2',
  'clean-pc/scripts/Find-EmptyItems.ps1': '69195da477c9a770aaab38c7bb9a5571ec44b1fbe0d9dd0ce2320cab681a173a',
  'clean-pc/scripts/Find-Screenshots.ps1': '8603ac1aec7eeb2d3360fb9a560b0df638d9348e604c6ae6689adacf6656b76f',
  'clean-pc/scripts/Get-InstalledApps.ps1': '116943d0ab3d116fb39a8bb04a29eea3f66643972a3c407531e4a7214c5c1b89',
  'clean-pc/scripts/Invoke-Removal.ps1': 'acb77d4b9ca07db61b20916fa86a293b23e2203835c001e4727480f939c3bd1c',
  'clean-pc/scripts/New-VisualStaging.ps1': '78e71f21afb7bc396b9781a012dcc25d7bd4a9d0186eb01474167abf67697cc1',
  'clean-pc/scripts/Scan-FolderMap.ps1': '873d79f871aa614a67d8679182d36ddcf9c38e3d64dbc6c28971d23e6e33a71d',
  'clean-pc/scripts/_Common.ps1': '8fe60555ac3096cc5e2f0dcac94b32157e74bf0f1d9381b5e22512e4f23c0a29',
  'components-audit/CHECKLISTS.md': 'f5f57ba8eeef297eb527e941114c4ce4ef126b08c6a97c7c89a0af9508ec84e5',
  'components-audit/references/shadcn-svelte.md': '34b3bef421e136c189c5313275cfd925ac3cf96bc506b623f9226369f443e3d1',
  'init-github-repo/scripts/init-repo.mjs': 'f5b6d290255065527118c3123daf6f15e0f114c087542a05a52e9e37e2cdfd24',
  'init-github-repo/templates/gitignore.template': '1fe3a632e6a3018608d6c5532f6aa8ad530a36cab8834c58b6f0dadd4a7ab4ef',
  'notebooklm/ARTIFACTS.md': '0a7e76b0c093d75165a7298785a4af67b39f52d34617a8c8431d6b5a3cc9413f',
  'notebooklm/COMMANDS.md': 'ed73d039de385b8edf1f276fa2f58fe32d0f070c09b6d891106ffaff5fb2d328',
  'notebooklm/TROUBLESHOOTING.md': '9ac36a5e947a0b3ec381a450ee035085b0d41ff839793d06760974b4b084e155',
  'notebooklm/WORKFLOWS.md': 'fa072c14c94497a054dfe97d82f0cdc24681062fe8a1c81975d9cd702263e89f',
  'podcast/reference/BRIEF_FORMAT.md': '95cdd25db6ca969354615a7dd146cdef0ad08a34413fa9cf2d4b6a12ff26da61',
  'podcast/reference/GEMINI_TTS.md': '54c7a0737c95bea3c7e18a9d67ac44b8b9ab45ac3ffe17a874bcf2b69e22c1b8',
  'podcast/scripts/gemini-tts-podcast.py': '81d33781c123331044942ba68ac638ce0874667bfcfebe6e9cc5cc8b2b799709',
  'project-register/OBSIDIAN_REGISTRATION.md': 'c2145c0bdde58f60ca6293505a0b413a4c478b86db7e174d925db54d3b5b6fb0',
  'project-register/scripts/make-icon.py': 'e68ffd84eb7629a6e411f96fbd30a10732d438c5728b4d324ce44dd2e33811b9',
  'project-register/scripts/peacock.mjs': '464c68fa958020d5e548e06502e901cca527eb70e9e2a20906da2786c302645e',
  'project-register/scripts/wt-profile.mjs': '781ae2f546b7fbb0c12b146662ed5b371dd4e3231c3f4ee289bec0bb80c77aed',
  'raycast-config/REFERENCE.md': '32abfc1a2cfe8d70daeb141fcc9d52dfd19226cdb59bd03a5441da6a992fc59e',
  'raycast-config/scripts/audit.mjs': '6c870db74b4fe7e9dfa46c929425b55f33f56e99460da20bdf6acc3aad19cd71',
  'raycast-config/scripts/passphrase.ps1': '622310da698cec68a810f82097986bb4966be3d541926eb85ed6009303a3c4f5',
  'raycast-config/scripts/rayconfig.mjs': '8344041c2011df0e5da7da4b041426ee80f32d96cf0d36b1905f54fdd0478358',
  'script-discovery/scripts/detect-project-scripts.mjs': 'fbddf1c1a20bff966e4972e251f57e70f7ad28660cd41d5b52636f0406d37429',
  'tutorial-create/package.json': '099a0784268104fb74a6b370767ce599b8b7a7d235e88389aee00ef04d4f977d',
  'tutorial-create/reference/approved-mockup.html': '84ddcf29cd6c94a6536f858331acabab0c0a734e229898b4edfe8da499ffc92f',
  'tutorial-create/reference/CHANNELS.md': '6a917190bf314f317d9311689a5cef4bfbf6840674431f0f1a7047eb71f16ffb',
  'tutorial-create/reference/SOURCE_FORMAT.md': '296727d787ee82460e073bbbe8dbdd693578280e18f9f7ce4dcb08f961f8ee86',
  'video-to-image/reference/EXERCISE.md': 'da314dd555dfd2b7059bc7a2f96941de3b97b22b2da61db0a6966d95c1e3ef4c',
  'video-to-image/reference/FALLBACK.md': '247f65a95918f0f5f8135ee9d2c70bfc02467e4f4e18df298b0f5f229f175f52',
  'video-to-image/reference/PROMPT_STYLE.md': '627a28a4af587ae9361366ee306a408ff189bdc1ed5aea979ec2667f2b3542e9',
  'video-to-image/scripts/lib/compose.mjs': '011557d9c5653a70d8b8aa12d023346b407d95615407fefe803037f0e3c4ac5c',
  'video-to-image/scripts/video-to-sheet.mjs': '50c2fc5cb60e266d443811a3cb5956d8dca1dca53b361bc4f3028a2dff607984',
  'video-to-image/__tests__/compose.test.ts': '02442a1d2044ecf3a6aa27bdccc6c7525c64c5d9446d330ae596e9f984a1c149',
};

const adaptedSupport = [
  'clean-pc/WINDOWS.md',
  'podcast/reference/NOTEBOOKLM_FLOW.md',
  'setup-react-native/PLATFORM_REFERENCE.md',
  'tutorial-create/TEMPLATE.html',
  'tutorial-create/scripts/compile.js',
] as const;

function frontmatter(source: string): Record<string, any> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  assert.ok(match, 'expected YAML frontmatter');
  return parse(match[1]!) as Record<string, any>;
}

async function filesBelow(directory: string, relative = ''): Promise<string[]> {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = path.posix.join(relative.replaceAll('\\', '/'), entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(directory, child));
    else files.push(child);
  }
  return files.sort();
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

test('active workflows retain source metadata and semantic bodies', async () => {
  for (const [name, [pack, exposure, needle]] of Object.entries(skills)) {
    const source = await readFile(path.join(contentRoot, name, 'SKILL.md'), 'utf8');
    const data = frontmatter(source);
    assert.equal(data.name, name);
    assert.deepEqual(data.metadata?.mpx, {
      schemaVersion: 1,
      skillPacks: [pack],
      defaultExposure: exposure,
    });
    assert.match(source, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), name);
  }
});

test('all support files are closed over and undeclared support bytes match dirty-source hashes', async () => {
  const expectedSupport = new Set([...Object.keys(exactSupportHashes), ...adaptedSupport]);
  const actualSupport: string[] = [];
  for (const skill of Object.keys(skills)) {
    for (const relative of await filesBelow(path.join(contentRoot, skill))) {
      if (relative !== 'SKILL.md') actualSupport.push(`${skill}/${relative}`);
    }
  }
  assert.deepEqual(actualSupport.sort(), [...expectedSupport].sort());
  for (const [relative, digest] of Object.entries(exactSupportHashes)) {
    assert.equal(sha256(await readFile(path.join(contentRoot, relative))), digest, relative);
  }
});

test('compiler projects pack exposure, support closure, commands, and sibling prefixes', async () => {
  const projections = await projectContent(root);
  const byPath = new Map(projections.map(item => [item.path, item.content]));
  for (const [name, [pack, exposure]] of Object.entries(skills)) {
    for (const harness of ['pi', 'claude'] as const) {
      const base = harness === 'pi'
        ? `dist/packs/${pack}/pi/skills/mp-${name}`
        : `dist/packs/${pack}/claude/.claude/skills/mp-${name}`;
      const projected = byPath.get(`${base}/SKILL.md`);
      assert.ok(projected, `${harness}:${name}`);
      const data = frontmatter(projected.toString('utf8'));
      assert.equal(data.name, `mp-${name}`);
      assert.equal(data['disable-model-invocation'], exposure === 'explicit-only' ? true : undefined);
      if (exposure === 'name-only') assert.equal(data.description, `Loads the mp-${name} skill when explicitly referenced.`);
      for (const relative of await filesBelow(path.join(contentRoot, name))) {
        if (relative !== 'SKILL.md') assert.ok(byPath.has(`${base}/${relative}`), `${base}/${relative}`);
      }
    }
  }
  assert.match(byPath.get('dist/packs/personal/pi/skills/mp-project-register/SKILL.md')!.toString(), /\.\.\/mp-raycast-config\/SKILL\.md/);
  assert.match(byPath.get('dist/packs/personal/claude/.claude/skills/mp-podcast/SKILL.md')!.toString(), /\/mp-notebooklm/);
  assert.match(byPath.get('dist/packs/development/pi/skills/mp-board-setup/SKILL.md')!.toString(), /\/skill:mp-board-to-issues/);
});

test('native-first adaptations remove retired services while preserving approved project test-login reading', async () => {
  const selected = (await Promise.all(Object.keys(skills).map(name => readFile(path.join(contentRoot, name, 'SKILL.md'), 'utf8')))).join('\n');
  for (const retired of [
    '/mpx:', 'skills/shared/', 'immutable launch identity', 'launch-bound environment',
    'dev-server ports', 'status-line project registry capability', 'AskUserQuestion',
    "env | grep '^MPX_'", '~/.claude/rules', 'npx skills add',
  ]) assert.ok(!selected.includes(retired), retired);
  assert.doesNotMatch(selected, /(?:npm run check|pnpm check|\btsc\b).*global typecheck/i);

  const playwright = await readFile(path.join(contentRoot, 'playwright-test/SKILL.md'), 'utf8');
  assert.match(playwright, /approved project test-login[\s\S]*\.local\/[\s\S]*\.env\.local/);
  assert.match(playwright, /never print or publish values/);
  assert.match(playwright, /reports every affected surface `BLOCKED`/);
  assert.doesNotMatch(playwright, /kill the stale server|start a replacement/);

  const registration = await readFile(path.join(contentRoot, 'project-register/SKILL.md'), 'utf8');
  assert.match(registration, /projectId[\s\S]*GitHub, GitLab, or\nGerrit/);
  assert.match(registration, /GitHub or KanbanFlow; local Issues are unsupported/);
  assert.match(registration, /preserve an explicit empty `packs: \[\]`/);
  assert.match(registration, /Orca owns checkout opening, terminal orchestration, status, labels/);
  assert.match(registration, /terminalProfile:/);
});

test('adapted support remains self-contained and bundled JavaScript parses without neighboring repositories', async () => {
  const windows = await readFile(path.join(contentRoot, 'clean-pc/WINDOWS.md'), 'utf8');
  assert.match(windows, /Invoke PowerShell from public Git\nBash/);
  assert.doesNotMatch(windows, /PowerShell tool is\nnot intercepted/);

  const platform = await readFile(path.join(contentRoot, 'setup-react-native/PLATFORM_REFERENCE.md'), 'utf8');
  assert.match(platform, /dist\/\{\{MPX_HARNESS\}\}\/rules\/projects\/react\.md/);
  const notebookFlow = await readFile(path.join(contentRoot, 'podcast/reference/NOTEBOOKLM_FLOW.md'), 'utf8');
  assert.match(notebookFlow, /\{\{MPX_SKILL_COMMAND\}\}notebooklm/);
  assert.match(notebookFlow, /`mechanical` class through the active runtime profile/);
  assert.match(notebookFlow, /runtime's real `model`/);

  const template = await readFile(path.join(contentRoot, 'tutorial-create/TEMPLATE.html'), 'utf8');
  const compiler = await readFile(path.join(contentRoot, 'tutorial-create/scripts/compile.js'), 'utf8');
  assert.doesNotMatch(`${template}\n${compiler}`, /\{\{[A-Z][A-Z0-9_]*\}\}/);
  for (const token of ['tutorial_title', 'tutorial_sections', 'tutorial_glossary_json', 'tutorial_slug']) {
    assert.ok(template.includes(`{{${token}}}`), token);
    assert.ok(compiler.includes(`'{{${token}}}'`), token);
  }

  const scripts = (await Promise.all(Object.keys(skills).map(async skill =>
    (await filesBelow(path.join(contentRoot, skill)))
      .filter(file => /\.(?:mjs|js)$/.test(file))
      .map(file => path.join(contentRoot, skill, file))))).flat();
  for (const script of scripts) {
    const checked = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' });
    assert.equal(checked.status, 0, `${path.relative(root, script)}\n${checked.stderr}`);
  }
  const detector = spawnSync(process.execPath, [path.join(contentRoot, 'script-discovery/scripts/detect-project-scripts.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(detector.status, 0, detector.stderr);
  assert.match(detector.stdout, /Usage:/);
});

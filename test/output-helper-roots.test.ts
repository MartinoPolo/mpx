import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const profileHelper = resolve('content/skills/project-register/scripts/wt-profile.mjs');
const tutorialHelper = resolve('content/skills/tutorial-create/scripts/compile.js');

async function withFixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'mpx-output-roots-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function profileFixture(root: string) {
  const localAppData = join(root, 'local app data');
  const settingsPath = join(localAppData, 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json');
  await mkdir(dirname(settingsPath), { recursive: true });
  const original = '{\n  "profiles": {\n    "list": [\n      { "name": "Shell", "commandline": "pwsh.exe" }\n    ]\n  }\n}\n';
  await writeFile(settingsPath, original);
  const icon = join(root, 'icon.png');
  await writeFile(icon, 'fixture');
  const add = (name: string, dumpRoot: string) => exec(process.execPath, [
    profileHelper, 'add', '--name', name, '--dir', root, '--icon', icon, '--color', '#123456',
  ], { env: { ...process.env, LOCALAPPDATA: localAppData, MPX_AI_DUMP: dumpRoot }, timeout: 10_000 });
  return { settingsPath, original, add };
}

test('terminal backups use unique MPX_AI_DUMP folders and preserve original settings', async () => {
  await withFixture(async root => {
    const fixture = await profileFixture(root);
    const dumpRoot = join(root, 'inspection dump');
    const first = JSON.parse((await fixture.add('First', dumpRoot)).stdout);
    const afterFirst = await readFile(fixture.settingsPath, 'utf8');
    const second = JSON.parse((await fixture.add('Second', dumpRoot)).stdout);
    assert.equal(dirname(dirname(first.backup)), join(dumpRoot, '_PROJECT_REGISTER'));
    assert.equal(dirname(dirname(second.backup)), join(dumpRoot, '_PROJECT_REGISTER'));
    assert.notEqual(dirname(first.backup), dirname(second.backup));
    assert.equal(await readFile(first.backup, 'utf8'), fixture.original);
    assert.equal(await readFile(second.backup, 'utf8'), afterFirst);
    assert.equal(first.path, fixture.settingsPath);
    const updated = JSON.parse(await readFile(fixture.settingsPath, 'utf8'));
    assert.deepEqual(updated.profiles.list.map((profile: { name: string }) => profile.name), ['Shell', 'First', 'Second']);
    assert.deepEqual(await readdir(dirname(fixture.settingsPath)), ['settings.json']);
  });
});

test('terminal changes abort for missing or relative MPX_AI_DUMP and backup failures', async () => {
  await withFixture(async root => {
    const fixture = await profileFixture(root);
    for (const invalid of ['', 'relative-dump']) {
      await assert.rejects(fixture.add('Invalid', invalid), /MPX_AI_DUMP/);
      assert.equal(await readFile(fixture.settingsPath, 'utf8'), fixture.original);
    }
    const dumpRoot = join(root, 'blocked dump');
    await mkdir(dumpRoot);
    await writeFile(join(dumpRoot, '_PROJECT_REGISTER'), 'not a directory');
    await assert.rejects(fixture.add('Blocked', dumpRoot));
    assert.equal(await readFile(fixture.settingsPath, 'utf8'), fixture.original);
    assert.deepEqual(await readdir(dirname(fixture.settingsPath)), ['settings.json']);
  });
});

test('podcast requires an absolute MPX_TEMP for unique scratch children', async () => {
  const text = await readFile(resolve('content/skills/podcast/SKILL.md'), 'utf8');
  assert.match(text, /Require an absolute `MPX_TEMP`/);
  assert.match(text, /unique child scratch directory/);
});

test('video fallback Bash example creates unique scratch children and rejects invalid MPX_TEMP', async () => {
  await withFixture(async root => {
    const scratchRoot = join(root, 'shell scratch space');
    for (const document of ['content/skills/video-to-image/reference/FALLBACK.md']) {
      const text = await readFile(resolve(document), 'utf8');
      const example = /```bash\n(: "\$\{MPX_TEMP:[\s\S]*?)\n```/.exec(text)?.[1];
      assert.ok(example, `${document} has an executable scratch preflight`);
      const command = `${example}\nprintf '%s' "$scratch_dir"`;
      const options = { env: { ...process.env, MPX_TEMP: scratchRoot }, timeout: 10_000 };
      const first = (await exec('bash', ['-c', command], options)).stdout;
      const second = (await exec('bash', ['-c', command], options)).stdout;
      assert.equal(dirname(resolve(first)), scratchRoot);
      assert.notEqual(first, second);
      assert.deepEqual(await readdir(first), []);
      for (const invalid of ['', 'relative-scratch']) {
        await assert.rejects(exec('bash', ['-c', command], {
          ...options, env: { ...process.env, MPX_TEMP: invalid },
        }), /MPX_TEMP/);
      }
    }
  });
});

async function tutorialFixture(root: string) {
  const generatedRoot = join(root, 'durable library');
  const directory = join(generatedRoot, '_TUTORIALS', 'fixture');
  await mkdir(directory, { recursive: true });
  const sourcePath = join(directory, 'fixture.source.md');
  const source = '---\ntitle: Output root fixture\ntype: code-showcase\nformat: brief\ncategory: fixture\nslug: fixture\ndate: 2026-09-13\n---\n# start | Start here\n';
  await writeFile(sourcePath, source + '\n```mermaid\ngraph TD; A-->B;\n```\n\n```mermaid\ngraph TD; B-->C;\n```\n');
  const renderer = join(root, 'renderer.mjs');
  const renderLog = join(root, 'renderer-log.jsonl');
  await writeFile(renderer, `import { appendFileSync, writeFileSync } from 'node:fs';
export async function run(input, output) {
  appendFileSync(process.env.RENDER_LOG, JSON.stringify({ input, output }) + '\\n');
  if (process.env.RENDER_FAIL === 'true') throw new Error('fixture renderer failure');
  writeFileSync(output, '<svg>fixture diagram</svg>');
}
`);
  const loader = join(root, 'loader.mjs');
  await writeFile(loader, `export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@mermaid-js/mermaid-cli') {
    if (process.env.RENDER_MISSING === 'true') throw new Error('fixture missing renderer');
    return { url: ${JSON.stringify(pathToFileURL(renderer).href)}, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`);
  const registration = `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)});`;
  const compile = (scratchRoot: string, extraEnv: NodeJS.ProcessEnv = {}) => exec(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(registration)}`, tutorialHelper, sourcePath, '--no-index',
  ], { env: { ...process.env, MPX_AI_GENERATED: generatedRoot, MPX_TEMP: scratchRoot, RENDER_LOG: renderLog, ...extraEnv }, timeout: 20_000 });
  return { compile, sourcePath, source, renderLog, htmlPath: join(directory, 'fixture.html') };
}

test('Mermaid scratch uses unique owned MPX_TEMP children and cleans them after success or failure', async () => {
  await withFixture(async root => {
    const fixture = await tutorialFixture(root);
    const scratchRoot = join(root, 'scratch space');
    await mkdir(scratchRoot);
    const sentinel = join(scratchRoot, 'unrelated.txt');
    await writeFile(sentinel, 'keep');
    await fixture.compile(scratchRoot);
    const calls = (await readFile(fixture.renderLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.length, 4);
    const directories = new Set<string>(calls.map(call => dirname(call.input)));
    assert.equal(directories.size, 2);
    for (const directory of directories) assert.equal(dirname(directory), scratchRoot);
    assert.match(await readFile(fixture.htmlPath, 'utf8'), /<svg>fixture diagram<\/svg>/);
    assert.deepEqual(await readdir(scratchRoot), ['unrelated.txt']);
    const failed = await fixture.compile(scratchRoot, { RENDER_FAIL: 'true' });
    assert.match(failed.stderr, /fixture renderer failure/);
    assert.match(await readFile(fixture.htmlPath, 'utf8'), /mermaid diagram skipped: render failed/);
    assert.deepEqual(await readdir(scratchRoot), ['unrelated.txt']);
    assert.equal(await readFile(sentinel, 'utf8'), 'keep');
  });
});

test('MPX_TEMP is required and absolute only when a Mermaid renderer needs scratch', async () => {
  await withFixture(async root => {
    const fixture = await tutorialFixture(root);
    for (const invalid of ['', 'relative-scratch']) {
      await assert.rejects(fixture.compile(invalid), /MPX_TEMP/);
    }
    const missing = await fixture.compile('', { RENDER_MISSING: 'true' });
    assert.match(missing.stderr, /diagram skipped/);
    assert.match(await readFile(fixture.htmlPath, 'utf8'), /mermaid diagram skipped: @mermaid-js\/mermaid-cli not installed/);
    await writeFile(fixture.sourcePath, fixture.source + '\nPlain tutorial without diagrams.\n');
    const plain = await fixture.compile('');
    assert.doesNotMatch(plain.stderr, /MPX_TEMP/);
    assert.match(await readFile(fixture.htmlPath, 'utf8'), /Plain tutorial without diagrams/);
  });
});

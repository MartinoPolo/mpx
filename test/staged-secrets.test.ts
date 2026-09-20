import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scanStagedDiff, scanStagedSecrets } from '../src/safeguards/staged-secrets.js';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function repository(files: Readonly<Record<string, string | Buffer>>): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'mpx-staged-secrets-'));
  git(cwd, 'init', '--quiet');
  git(cwd, 'config', 'core.autocrlf', 'false');
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(cwd, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  git(cwd, 'add', '--all');
  return cwd;
}

async function inRepository(
  files: Readonly<Record<string, string | Buffer>>,
  run: (cwd: string) => Promise<void>,
): Promise<void> {
  const cwd = await repository(files);
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const githubToken = `ghp_${'A'.repeat(36)}`;
const slackToken = `xoxb-${'1'.repeat(12)}-${'a'.repeat(24)}`;

void test('blocks credible GitHub and Slack tokens from one real staged index without disclosure', async () => {
  await inRepository(
    {
      'src/github.ts': `export const token = '${githubToken}';\n`,
      'src/slack.ts': `export const token = '${slackToken}';\n`,
    },
    async (cwd) => {
      const result = await scanStagedSecrets(cwd);
      assert.equal(result.decision, 'block');
      assert.match(result.diagnostics.join('\n'), /GitHub token.*src[\\/]github\.ts/i);
      assert.match(result.diagnostics.join('\n'), /Slack token.*src[\\/]slack\.ts/i);
      assert.doesNotMatch(result.diagnostics.join('\n'), /ghp_|xoxb-|A{20}|a{20}/);
      assert.ok(result.diagnostics.every((diagnostic) => diagnostic.length <= 300));
    },
  );
});

void test('forces color-free stable prefixes despite repository diff presentation config', async () => {
  await inRepository(
    { 'configured-secret.txt': `${githubToken}\n` },
    async (cwd) => {
      git(cwd, 'config', '--local', 'color.ui', 'always');
      git(cwd, 'config', '--local', 'diff.mnemonicPrefix', 'true');
      git(cwd, 'config', '--local', 'diff.noprefix', 'true');
      const result = await scanStagedSecrets(cwd);
      assert.equal(result.decision, 'block');
      assert.match(result.diagnostics.join('\n'), /GitHub token.*configured-secret\.txt/i);
    },
  );
});

void test('forces repository-wide diff collection when called in a configured subdirectory', async () => {
  await inRepository(
    {
      'root-secret.txt': `${githubToken}\n`,
      'nested/safe.txt': 'safe\n',
    },
    async (cwd) => {
      git(cwd, 'config', '--local', 'diff.relative', 'true');
      const result = await scanStagedSecrets(path.join(cwd, 'nested'));
      assert.equal(result.decision, 'block');
      assert.match(result.diagnostics.join('\n'), /GitHub token.*root-secret\.txt/i);
    },
  );
});

void test('redacts credential-like filenames and scans added content beginning with +++', async () => {
  await inRepository(
    { [`leak-${githubToken}.txt`]: `++ ${githubToken}\n` },
    async (cwd) => {
      const result = await scanStagedSecrets(cwd);
      assert.equal(result.decision, 'block');
      assert.match(result.diagnostics.join('\n'), /GitHub token/i);
      assert.doesNotMatch(result.diagnostics.join('\n'), /ghp_|A{20}/);
    },
  );
});

void test('redacts generic credential assignments embedded in filenames', async () => {
  await inRepository({ 'config/password=supersecret123.txt': `${githubToken}\n` }, async (cwd) => {
    const result = await scanStagedSecrets(cwd);
    assert.equal(result.decision, 'block');
    assert.match(result.diagnostics.join('\n'), /GitHub token.*config/);
    assert.doesNotMatch(result.diagnostics.join('\n'), /supersecret123|ghp_/);
  });
});

void test('warns for AWS access-key IDs alone and generic assignments', async () => {
  await inRepository(
    {
      'config/app.txt': `access_id=AKIA${'1'.repeat(16)}\npassword = "ordinary-but-sensitive"\n`,
    },
    async (cwd) => {
      const result = await scanStagedSecrets(cwd);
      assert.equal(result.decision, 'warn');
      assert.match(result.diagnostics.join('\n'), /AWS access-key ID/i);
      assert.match(result.diagnostics.join('\n'), /generic secret assignment/i);
      assert.doesNotMatch(result.diagnostics.join('\n'), /AKIA|ordinary-but-sensitive/);
    },
  );
});

void test('preserves test, spec, environment template, and lockfile exclusions', async () => {
  const files = Object.fromEntries(
    [
      'auth.test.ts',
      'auth.spec.js',
      '.env.example',
      '.env.sample',
      '.env.template',
      'service.env.example',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lockb',
    ].map((name) => [name, `token=${githubToken}\n`]),
  );
  await inRepository(files, async (cwd) => {
    assert.deepEqual(await scanStagedSecrets(cwd), { decision: 'allow', diagnostics: [] });
  });
});

void test('excludes binary staged content', async () => {
  await inRepository(
    { 'asset.bin': Buffer.from(`\0${githubToken}\0`, 'utf8') },
    async (cwd) => {
      assert.deepEqual(await scanStagedSecrets(cwd), { decision: 'allow', diagnostics: [] });
    },
  );
});

void test('blocks complete multiline private keys but not isolated headers', async () => {
  const body = Buffer.from('credible private key material for a staged fixture').toString('base64');
  await inRepository(
    {
      'complete.pem': `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`,
      'header-only.txt': '-----BEGIN RSA PRIVATE KEY-----\n',
    },
    async (cwd) => {
      const result = await scanStagedSecrets(cwd);
      assert.equal(result.decision, 'block');
      assert.match(result.diagnostics.join('\n'), /private key.*complete\.pem/i);
      assert.doesNotMatch(result.diagnostics.join('\n'), /header-only/);
      assert.doesNotMatch(result.diagnostics.join('\n'), new RegExp(body.slice(0, 16)));
    },
  );

  await inRepository(
    { 'header-only.pem': '-----BEGIN OPENSSH PRIVATE KEY-----\n' },
    async (cwd) => {
      assert.deepEqual(await scanStagedSecrets(cwd), { decision: 'allow', diagnostics: [] });
    },
  );

  await inRepository(
    { 'partial.pem': `-----BEGIN PRIVATE KEY-----\n${body}\n` },
    async (cwd) => {
      const result = await scanStagedSecrets(cwd);
      assert.equal(result.decision, 'block');
      assert.match(result.diagnostics.join('\n'), /private key.*partial\.pem/i);
    },
  );
});

void test('isolated private-key headers do not combine with unrelated hunks or unscanned context', () => {
  for (const middle of ['@@ -99,0 +101 @@\n', ' context not belonging to a key\n']) {
    const separated = middle.startsWith('@@');
    const diff = `diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n@@ -1,${separated ? 0 : 1} +1,${separated ? 1 : 3} @@\n+-----BEGIN PRIVATE KEY-----\n${middle}+${'A'.repeat(48)}\n`;
    assert.equal(scanStagedDiff(diff).decision, 'allow');
  }
});

void test('an early blocking finding survives a later oversized aggregate diff', async () => {
  await inRepository(
    {
      'a-secret.txt': `${githubToken}\n`,
      'z-large.txt': `${'safe staged text\n'.repeat(20_000)}`,
    },
    async (cwd) => {
      const result = await scanStagedSecrets(cwd, { maxBytes: 2_048 });
      assert.equal(result.decision, 'block');
      assert.match(result.diagnostics.join('\n'), /GitHub token.*a-secret\.txt/i);
      assert.match(result.diagnostics.join('\n'), /incomplete.*size limit/i);
    },
  );
});

void test('timeout and oversized scans visibly warn and allow when no finding exists', async () => {
  await inRepository(
    { 'large.txt': `${'harmless staged content\n'.repeat(10_000)}` },
    async (cwd) => {
      const timedOut = await scanStagedSecrets(cwd, { timeoutMs: 0 });
      assert.equal(timedOut.decision, 'warn');
      assert.match(timedOut.diagnostics.join('\n'), /incomplete.*timed out/i);

      const oversized = await scanStagedSecrets(cwd, { maxBytes: 128 });
      assert.equal(oversized.decision, 'warn');
      assert.match(oversized.diagnostics.join('\n'), /incomplete.*size limit/i);
    },
  );
});

void test('a truncated hunk without a finding warns instead of reporting clean', () => {
  const result = scanStagedDiff(
    'diff --git a/safe.txt b/safe.txt\n--- /dev/null\n+++ b/safe.txt\n@@ -0,0 +1,2 @@\n+only one line\n',
  );
  assert.equal(result.decision, 'warn');
  assert.match(result.diagnostics.join('\n'), /incomplete.*malformed/i);
});

void test('diagnostics prioritize late blocks and infrastructure ahead of bounded warnings', () => {
  const warnings = Array.from(
    { length: 30 },
    (_, index) =>
      `diff --git a/warning-${index}.txt b/warning-${index}.txt\n--- /dev/null\n+++ b/warning-${index}.txt\n@@ -0,0 +1 @@\n+password=warning-value-${index}\n`,
  ).join('');
  const lateBlock =
    `diff --git a/z-secret.txt b/z-secret.txt\n--- /dev/null\n+++ b/z-secret.txt\n@@ -0,0 +1,2 @@\n+${githubToken}\n`;
  const result = scanStagedDiff(warnings + lateBlock);
  assert.equal(result.decision, 'block');
  assert.ok(result.diagnostics.length <= 24);
  const blockIndex = result.diagnostics.findIndex((item) => /Blocked.*GitHub token/u.test(item));
  const infrastructureIndex = result.diagnostics.findIndex((item) => /incomplete.*malformed/iu.test(item));
  const warningIndex = result.diagnostics.findIndex((item) => /Warning:.*generic/iu.test(item));
  assert.ok(blockIndex >= 0);
  assert.ok(infrastructureIndex > blockIndex);
  assert.ok(warningIndex > infrastructureIndex);
  assert.match(result.diagnostics.join('\n'), /additional diagnostics? omitted/i);
  assert.doesNotMatch(result.diagnostics.join('\n'), /ghp_/);
});

void test('positive parsing findings survive later malformed input and remain redacted', () => {
  const result = scanStagedDiff(
    `diff --git a/a.txt b/a.txt\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+${githubToken}\n+orphaned malformed line\n`,
  );
  assert.equal(result.decision, 'block');
  assert.match(result.diagnostics.join('\n'), /GitHub token.*a\.txt/i);
  assert.match(result.diagnostics.join('\n'), /incomplete.*malformed/i);
  assert.doesNotMatch(result.diagnostics.join('\n'), /ghp_/);
});

void test('a finding emitted before a real Git object failure still blocks', async () => {
  const cwd = await repository({
    'a-secret.txt': `${githubToken}\n`,
    'z-unreadable.txt': 'content whose staged object will be removed\n',
  });
  try {
    const object = git(cwd, 'hash-object', 'z-unreadable.txt');
    await unlink(path.join(cwd, '.git', 'objects', object.slice(0, 2), object.slice(2)));
    const result = await scanStagedSecrets(cwd);
    assert.equal(result.decision, 'block');
    assert.match(result.diagnostics.join('\n'), /GitHub token.*a-secret\.txt/i);
    assert.match(result.diagnostics.join('\n'), /incomplete.*Git process failed/i);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test('Windows Git lookup cannot execute a repository-local impostor', { skip: process.platform !== 'win32' }, async () => {
  await inRepository({ 'safe.txt': 'safe\n' }, async (cwd) => {
    // A trusted Node binary safely simulates an executable supplied by an untrusted repository.
    await copyFile(process.execPath, path.join(cwd, 'git.exe'));
    const marker = path.join(cwd, 'impostor-executed');
    await writeFile(path.join(cwd, 'diff'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`);
    const result = await scanStagedSecrets(cwd);
    assert.equal(result.decision, 'allow');
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  });
});

void test('runs no repository project command', async () => {
  await inRepository(
    {
      'safe.txt': 'normal content\n',
      'package.json': JSON.stringify({
        scripts: { typecheck: 'node -e "require(\\\'fs\\\').writeFileSync(\\\'project-command-ran\\\', \\\'yes\\\')"' },
      }),
    },
    async (cwd) => {
      assert.equal((await scanStagedSecrets(cwd)).decision, 'allow');
      await assert.rejects(readFile(path.join(cwd, 'project-command-ran')), /ENOENT/);
    },
  );
});

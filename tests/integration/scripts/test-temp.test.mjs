import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

import setup from '../../../scripts/test-temp.mjs';

const require = createRequire(import.meta.url);
const vitestPackage = require.resolve('vitest/package.json');
const vitestCli = join(dirname(vitestPackage), 'vitest.mjs');
const setupPath = fileURLToPath(new URL('../../../scripts/test-temp.mjs', import.meta.url));
const fixtureRoots = new Set();

afterEach(async () => {
  await Promise.all(
    [...fixtureRoots].map(async (root) => {
      fixtureRoots.delete(root);
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }),
  );
});

describe('test temp global setup', () => {
  test('assigns isolated roots and removes only each owned root', async () => {
    const sibling = await mkdtemp(join(tmpdir(), 'mpx-test-sibling-'));
    fixtureRoots.add(sibling);
    const firstProject = { config: { env: { PRESERVED: 'yes', TMP: 'old' } } };
    const secondProject = { config: { env: {} } };

    const [teardownFirst, teardownSecond] = await Promise.all([
      setup(firstProject),
      setup(secondProject),
    ]);
    const firstRoot = firstProject.config.env.TMP;
    const secondRoot = secondProject.config.env.TMP;
    fixtureRoots.add(firstRoot);
    fixtureRoots.add(secondRoot);
    const sentinel = join(sibling, 'sentinel.txt');
    await writeFile(sentinel, 'keep');
    await symlink(sibling, join(firstRoot, 'sibling-junction'), 'junction');

    expect(firstRoot).not.toBe(secondRoot);
    expect(firstProject.config.env).toMatchObject({
      PRESERVED: 'yes',
      TMP: firstRoot,
      TEMP: firstRoot,
      TMPDIR: firstRoot,
    });
    expect(secondProject.config.env).toMatchObject({
      TMP: secondRoot,
      TEMP: secondRoot,
      TMPDIR: secondRoot,
    });

    await Promise.all([teardownFirst(), teardownSecond()]);
    expect(existsSync(firstRoot)).toBe(false);
    expect(existsSync(secondRoot)).toBe(false);
    expect(existsSync(sibling)).toBe(true);
    expect(await readFile(sentinel, 'utf8')).toBe('keep');
  });

  test.each([
    ['success', false],
    ['assertion failure', true],
  ])('contains subprocess temp usage and tears down after %s', async (_label, shouldFail) => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'mpx-temp-test-fixture-'));
    fixtureRoots.add(fixtureRoot);
    const marker = join(fixtureRoot, 'marker.json');
    const testFile = join(fixtureRoot, 'tiny.test.mjs');
    const configFile = join(fixtureRoot, 'vitest.config.mjs');

    await writeFile(
      testFile,
      `import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
const top = mkdtempSync(join(tmpdir(), 'top-'));
test('temp ownership', () => {
  const child = execFileSync(process.execPath, ['-e', "const {mkdtempSync}=require('node:fs');const {join}=require('node:path');const {tmpdir}=require('node:os');process.stdout.write(mkdtempSync(join(tmpdir(),'child-')))"]).toString();
  writeFileSync(process.env.MARKER, JSON.stringify({ root: process.env.TMP, temp: process.env.TEMP, tmpdir: process.env.TMPDIR, top, child }));
  expect(process.env.EXPECT_FAILURE).not.toBe('yes');
});
`,
    );
    await writeFile(
      configFile,
      `export default { test: { include: ['tiny.test.mjs'], globalSetup: ${JSON.stringify(setupPath)} } };\n`,
    );

    const result = spawnSync(process.execPath, [vitestCli, 'run', '--config', configFile], {
      cwd: fixtureRoot,
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        MARKER: marker,
        EXPECT_FAILURE: shouldFail ? 'yes' : 'no',
      },
    });
    expect(result.error, `${result.stdout}\n${result.stderr}`).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(shouldFail ? 1 : 0);
    const observed = JSON.parse(await readFile(marker, 'utf8'));

    expect(observed.temp).toBe(observed.root);
    expect(observed.tmpdir).toBe(observed.root);
    expect(observed.top.startsWith(observed.root)).toBe(true);
    expect(observed.child.startsWith(observed.root)).toBe(true);
    expect(existsSync(observed.top)).toBe(false);
    expect(existsSync(observed.child)).toBe(false);
    expect(existsSync(observed.root)).toBe(false);
  });
});

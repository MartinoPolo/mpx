import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { evaluatePackageManager } from '../src/safeguards/package-manager.js';

async function fixture(
  files: Readonly<Record<string, string>>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-package-manager-'));
  try {
    await mkdir(path.join(root, '.git'), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(root, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void test('detects packageManager and every supported lockfile mapping', async () => {
  const cases = [
    ['packageManager', 'package.json', JSON.stringify({ packageManager: 'pnpm@10.0.0' }), 'pnpm', 'npm'],
    ['npm lock', 'package-lock.json', '{}', 'npm', 'yarn'],
    ['npm shrinkwrap', 'npm-shrinkwrap.json', '{}', 'npm', 'bun'],
    ['yarn lock', 'yarn.lock', '', 'yarn', 'pnpm'],
    ['bun lock', 'bun.lock', '', 'bun', 'npm'],
  ] as const;
  for (const [label, filename, content, expected, wrong] of cases) {
    await fixture({ [filename]: content }, async (root) => {
      assert.equal((await evaluatePackageManager(`${expected} install`, root)).decision, 'allow', label);
      const mismatch = await evaluatePackageManager(`${wrong} install`, root);
      assert.equal(mismatch.decision, 'block', label);
      assert.match(mismatch.diagnostics.join('\n'), new RegExp(`uses ${expected}`, 'i'));
    });
  }
});

void test('conflicting credible evidence warns and does not guess', async () => {
  await fixture(
    {
      'package.json': JSON.stringify({ packageManager: 'pnpm@10.0.0' }),
      'package-lock.json': '{}',
    },
    async (root) => {
      const result = await evaluatePackageManager('npm install', root);
      assert.equal(result.decision, 'warn');
      assert.match(result.diagnostics.join('\n'), /conflicting credible evidence.*packageManager=pnpm.*package-lock\.json=npm/i);
    },
  );
});

void test('mpxconfig is never package-manager authority and Git boundaries prevent leakage', async () => {
  await fixture(
    {
      'package.json': JSON.stringify({ packageManager: 'pnpm@10' }),
      'nested/.git/keep': '',
      'nested/mpxconfig.json': JSON.stringify({ packageManager: 'pnpm' }),
    },
    async (root) => {
      assert.deepEqual(await evaluatePackageManager('npm install', path.join(root, 'nested')), {
        decision: 'allow',
        diagnostics: [],
      });
    },
  );

  await fixture(
    { 'mpxconfig.json': JSON.stringify({ packageManager: 'pnpm' }) },
    async (root) => {
      assert.equal((await evaluatePackageManager('npm install', root)).decision, 'allow');
    },
  );
});

void test('inherits workspace evidence while nearest independent subpackage evidence wins', async () => {
  await fixture(
    {
      'package.json': JSON.stringify({ packageManager: 'pnpm@10' }),
      'pnpm-lock.yaml': '',
      'pnpm-workspace.yaml': "packages:\n  - '!packages/private'\n  - 'packages/{app,private}'\n",
      'packages/app/package.json': JSON.stringify({ name: 'app' }),
      'packages/private/package.json': JSON.stringify({ name: 'private' }),
      'vendor/tool/package.json': JSON.stringify({ name: 'tool' }),
      'vendor/tool/package-lock.json': '{}',
      'not-a-workspace/package.json': JSON.stringify({ name: 'separate' }),
    },
    async (root) => {
      const workspace = await evaluatePackageManager('npm install', path.join(root, 'packages/app'));
      assert.equal(workspace.decision, 'block');
      assert.match(workspace.diagnostics.join('\n'), /uses pnpm/i);

      assert.equal(
        (await evaluatePackageManager('npm install', path.join(root, 'packages/private'))).decision,
        'allow',
      );
      assert.equal(
        (await evaluatePackageManager('npm install', path.join(root, 'vendor/tool'))).decision,
        'allow',
      );
      assert.equal(
        (await evaluatePackageManager('pnpm install', path.join(root, 'vendor/tool'))).decision,
        'block',
      );
      assert.equal(
        (await evaluatePackageManager('npm install', path.join(root, 'not-a-workspace'))).decision,
        'allow',
      );
    },
  );
});

void test('tracks cwd only within success-guaranteed cd chains', async () => {
  await fixture(
    {
      'package.json': JSON.stringify({ packageManager: 'pnpm@10' }),
      'pnpm-lock.yaml': '',
      'packages/npm/package.json': JSON.stringify({ packageManager: 'npm@11' }),
      'packages/npm/package-lock.json': '{}',
    },
    async (root) => {
      const literal = await evaluatePackageManager(
        "cd 'packages/npm' && npm install; cd ../.. && pnpm install",
        root,
      );
      assert.equal(literal.decision, 'warn');
      assert.match(literal.diagnostics.join('\n'), /effective directory is dynamic or unresolved/i);

      const quotedAbsolute = await evaluatePackageManager(
        `cd "${path.join(root, 'packages/npm').replaceAll('\\', '/')}" && npm add "$PACKAGE"`,
        root,
      );
      assert.deepEqual(quotedAbsolute, { decision: 'allow', diagnostics: [] });

      const dynamic = await evaluatePackageManager(
        `cd "$TARGET" && npm install; cd packages/npm && npm test; cd '${root.replaceAll('\\', '/')}' && npm install`,
        root,
      );
      assert.equal(dynamic.decision, 'block');
      assert.match(dynamic.diagnostics.join('\n'), /effective directory is dynamic or unresolved/i);
      assert.match(dynamic.diagnostics.join('\n'), /uses pnpm/i);
    },
  );
});

void test('manager directory flags select each invocation effective directory', async () => {
  await fixture(
    {
      'package.json': JSON.stringify({ packageManager: 'pnpm@10' }),
      'pnpm-lock.yaml': '',
      'other/package.json': JSON.stringify({ packageManager: 'yarn@4' }),
      'other/yarn.lock': '',
      'npm/package.json': JSON.stringify({ packageManager: 'npm@11' }),
      'npm/package-lock.json': '{}',
      'bun/package.json': JSON.stringify({ packageManager: 'bun@1' }),
      'bun/bun.lock': '',
    },
    async (root) => {
      assert.equal((await evaluatePackageManager('pnpm -C other install', root)).decision, 'block');
      assert.equal((await evaluatePackageManager('pnpm --cwd=other install', root)).decision, 'block');
      assert.equal((await evaluatePackageManager('yarn --cwd other install', root)).decision, 'allow');
      assert.equal((await evaluatePackageManager('npm --prefix npm install', root)).decision, 'allow');
      assert.equal((await evaluatePackageManager('bun --cwd bun install', root)).decision, 'allow');
      const unresolved = await evaluatePackageManager('npm --prefix "$TARGET" install', root);
      assert.equal(unresolved.decision, 'warn');
      assert.match(unresolved.diagnostics.join('\n'), /dynamic or unresolved/i);
    },
  );
});

void test('blocks direct npx tsc variants without requiring manager evidence', async () => {
  await fixture({}, async (root) => {
    for (const command of [
      'npx tsc',
      'npx --yes tsc --noEmit',
      'npx -y --package typescript tsc',
      'npx --package=typescript@latest -- tsc -p tsconfig.json',
    ]) {
      const result = await evaluatePackageManager(command, root);
      assert.equal(result.decision, 'block', command);
      assert.match(result.diagnostics.join('\n'), /repository-defined check script/i);
      assert.doesNotMatch(result.diagnostics.join('\n'), /run typecheck|global/i);
    }
  });
});

void test('ignores quoted examples, inspects literal bash wrappers, and warns on unsupported wrappers', async () => {
  await fixture(
    { 'package.json': JSON.stringify({ packageManager: 'pnpm@10' }) },
    async (root) => {
      assert.equal(
        (await evaluatePackageManager(`echo "npm install"; printf '%s' 'npx tsc'`, root)).decision,
        'allow',
      );
      assert.equal((await evaluatePackageManager(`bash -lc 'npm install'`, root)).decision, 'block');
      const unsupported = await evaluatePackageManager(`powershell -Command "npm install"`, root);
      assert.equal(unsupported.decision, 'warn');
      assert.match(unsupported.diagnostics.join('\n'), /unsupported powershell shell wrapper/i);
      const controlFlow = await evaluatePackageManager('if true; then npm install; fi', root);
      assert.equal(controlFlow.decision, 'warn');
      assert.match(controlFlow.diagnostics.join('\n'), /unsupported shell control-flow grammar/i);
    },
  );
});

void test('keeps unquoted parameter expansions as dynamic argument values', async () => {
  await fixture(
    { 'package.json': JSON.stringify({ packageManager: 'pnpm@10' }) },
    async (root) => {
      const result = await evaluatePackageManager('npm install --registry ${REGISTRY}', root);
      assert.equal(result.decision, 'block');
      assert.match(result.diagnostics.join('\n'), /uses pnpm/i);
      assert.doesNotMatch(result.diagnostics.join('\n'), /unsupported shell grouping/i);
    },
  );
});

void test('current-shell wrappers and dynamic executables make following cwd unknown', async () => {
  await fixture(
    { 'package.json': JSON.stringify({ packageManager: 'pnpm@10' }) },
    async (root) => {
      for (const command of [
        'source setup.sh; npm install',
        '. setup.sh; npm install',
        'eval "cd somewhere"; npm install',
        '${RUNNER} setup.sh; npm install',
      ]) {
        const result = await evaluatePackageManager(command, root);
        assert.equal(result.decision, 'warn', command);
        assert.match(result.diagnostics.join('\n'), /dynamic or unresolved/i, command);
        assert.doesNotMatch(result.diagnostics.join('\n'), /uses pnpm/i, command);
      }

      const restored = await evaluatePackageManager(
        `source setup.sh; cd '${root.replaceAll('\\', '/')}' && npm install`,
        root,
      );
      assert.equal(restored.decision, 'block');
      assert.match(restored.diagnostics.join('\n'), /uses pnpm/i);
    },
  );
});

void test('blocks direct npx tsc even after cwd becomes unresolved', async () => {
  await fixture({}, async (root) => {
    for (const command of ['cd "$TARGET"; npx tsc', 'source setup.sh; npx --yes tsc --noEmit']) {
      const result = await evaluatePackageManager(command, root);
      assert.equal(result.decision, 'block', command);
      assert.match(result.diagnostics.join('\n'), /Blocked direct 'npx tsc'/i);
    }
  });
});

void test('does not guess cwd after conditional directory changes', async () => {
  await fixture(
    {
      'package.json': JSON.stringify({ packageManager: 'pnpm@10' }),
      'npm/package.json': JSON.stringify({ packageManager: 'npm@11' }),
    },
    async (root) => {
      const uncertain = await evaluatePackageManager('false && cd npm; npm install', root);
      assert.equal(uncertain.decision, 'warn');
      assert.match(uncertain.diagnostics.join('\n'), /dynamic or unresolved/i);
      assert.doesNotMatch(uncertain.diagnostics.join('\n'), /uses pnpm/i);

      assert.equal((await evaluatePackageManager('cd npm && npm install', root)).decision, 'allow');
      assert.equal((await evaluatePackageManager('pwd && cd npm && npm install', root)).decision, 'allow');

      const uncheckedCd = await evaluatePackageManager('cd npm; npm install', root);
      assert.equal(uncheckedCd.decision, 'warn');
      assert.match(uncheckedCd.diagnostics.join('\n'), /dynamic or unresolved/i);

      assert.equal((await evaluatePackageManager('false && printf nope; npm install', root)).decision, 'block');
    },
  );
});

void test('pipelines and background commands do not supply a parent cwd', async () => {
  await fixture(
    {
      'package.json': JSON.stringify({ packageManager: 'pnpm@10' }),
      'npm/package.json': JSON.stringify({ packageManager: 'npm@11' }),
    },
    async (root) => {
      const pipelineCd = await evaluatePackageManager('echo x | cd npm; npm install', root);
      assert.equal(pipelineCd.decision, 'warn');
      assert.match(pipelineCd.diagnostics.join('\n'), /dynamic or unresolved/i);
      assert.doesNotMatch(pipelineCd.diagnostics.join('\n'), /unsupported pipeline or background/i);

      const backgroundCd = await evaluatePackageManager('cd npm & npm install', root);
      assert.equal(backgroundCd.decision, 'block');
      assert.match(backgroundCd.diagnostics.join('\n'), /uses pnpm/i);

      const directTsc = await evaluatePackageManager('echo x | npx tsc', root);
      assert.equal(directTsc.decision, 'block');
      assert.match(directTsc.diagnostics.join('\n'), /Blocked direct 'npx tsc'/i);

      const envCd = await evaluatePackageManager('env cd npm; npm install', root);
      assert.equal(envCd.decision, 'block');
      assert.match(envCd.diagnostics.join('\n'), /uses pnpm/i);
    },
  );
});

void test('resolves env chdir and consumes env options with operands', async () => {
  await fixture(
    {
      'package.json': JSON.stringify({ packageManager: 'pnpm@10' }),
      'npm/package.json': JSON.stringify({ packageManager: 'npm@11' }),
    },
    async (root) => {
      assert.equal((await evaluatePackageManager('env -C npm npm install', root)).decision, 'allow');
      assert.equal((await evaluatePackageManager('env --chdir=npm npm install', root)).decision, 'allow');
      assert.equal((await evaluatePackageManager('env -u TOKEN npm install', root)).decision, 'block');
      assert.equal((await evaluatePackageManager('env --unset TOKEN npm install', root)).decision, 'block');
      const unsupported = await evaluatePackageManager('env --unknown-option npm install', root);
      assert.equal(unsupported.decision, 'warn');
      assert.match(unsupported.diagnostics.join('\n'), /unsupported env option/i);
    },
  );
});

void test('rejects nonexistent, non-directory, and oversized inspection inputs', async () => {
  await fixture(
    {
      'package.json': JSON.stringify({ packageManager: 'pnpm@10' }),
      'not-a-directory': 'file',
      'large/package.json': ' '.repeat(1024 * 1024 + 1),
      'malformed/package.json': '{"token":"DO_NOT_ECHO_THIS_SECRET",oops}',
      'malformed-yaml/package.json': '{}',
      'malformed-yaml/pnpm-workspace.yaml': "packages:\n  - [DO_NOT_ECHO_YAML_SECRET\n",
    },
    async (root) => {
      await mkdir(path.join(root, 'nonregular', 'package.json'), { recursive: true });

      const missing = await evaluatePackageManager('npm --prefix missing install', root);
      assert.equal(missing.decision, 'warn');
      assert.match(missing.diagnostics.join('\n'), /does not exist/i);
      assert.doesNotMatch(missing.diagnostics.join('\n'), /uses pnpm/i);

      const file = await evaluatePackageManager('npm --prefix not-a-directory install', root);
      assert.equal(file.decision, 'warn');
      assert.match(file.diagnostics.join('\n'), /not a directory/i);
      assert.doesNotMatch(file.diagnostics.join('\n'), /uses pnpm/i);

      const oversizedConfig = await evaluatePackageManager('npm install', path.join(root, 'large'));
      assert.equal(oversizedConfig.decision, 'warn');
      assert.match(oversizedConfig.diagnostics.join('\n'), /inspection limit/i);

      const nonregularConfig = await evaluatePackageManager('npm install', path.join(root, 'nonregular'));
      assert.equal(nonregularConfig.decision, 'warn');
      assert.match(nonregularConfig.diagnostics.join('\n'), /not a regular file|read error/i);

      const malformedConfig = await evaluatePackageManager('npm install', path.join(root, 'malformed'));
      assert.equal(malformedConfig.decision, 'warn');
      assert.match(malformedConfig.diagnostics.join('\n'), /malformed package\.json/i);
      assert.doesNotMatch(malformedConfig.diagnostics.join('\n'), /DO_NOT_ECHO_THIS_SECRET/i);

      const malformedYaml = await evaluatePackageManager('npm install', path.join(root, 'malformed-yaml'));
      assert.equal(malformedYaml.decision, 'warn');
      assert.match(malformedYaml.diagnostics.join('\n'), /malformed pnpm-workspace\.yaml/i);
      assert.doesNotMatch(malformedYaml.diagnostics.join('\n'), /DO_NOT_ECHO_YAML_SECRET/i);

      const oversizedCommand = await evaluatePackageManager(`npm install ${'x'.repeat(64 * 1024)}`, root);
      assert.equal(oversizedCommand.decision, 'warn');
      assert.match(oversizedCommand.diagnostics.join('\n'), /size limit/i);
    },
  );
});

void test('repeated commands share only the current inspection, never stale cross-call evidence', async () => {
  await fixture({ 'package.json': JSON.stringify({ packageManager: 'pnpm@11' }) }, async (root) => {
    const batch = await evaluatePackageManager('npm install; yarn install; npm install', root);
    assert.equal(batch.decision, 'block');
    assert.equal(batch.diagnostics.filter(message => /uses pnpm/.test(message)).length, 2);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'npm@11' }));
    assert.equal((await evaluatePackageManager('npm install; npm test', root)).decision, 'allow');
  });
});

void test('allows resolved managers in ordinary pipelines and ignores unrelated shell diagnostics', async () => {
  await fixture({ 'package.json': JSON.stringify({ packageManager: 'pnpm@10' }) }, async (root) => {
    for (const command of [
      'pnpm test | tail', 'pnpm dev &', 'rg x | head', 'git status | head',
      `printf '%s' 'pnpm install'`, `node -e "console.log('npm install')"`,
      'powershell -Command Get-Process', 'cmd /c dir',
      "node <<'NODE'\nconsole.log('hello');\nNODE",
      'pnpm test >|output.log',
      "for npm in files; do printf '%s' 'npm install'; done",
      `(printf '%s' 'pnpm install')`, `for x in pnpm; do printf '%s' "$x"; done`,
    ]) assert.deepEqual(await evaluatePackageManager(command, root), { decision: 'allow', diagnostics: [] }, command);

    for (const command of ['(pnpm install)', 'powershell -Command pnpm install', 'eval "pnpm install"', 'bash -c "$TASK"', 'sudo npm install', 'sudo npx tsc', 'if command npm install; then echo ok; fi', 'pnpm test <<EOF\ntext\nEOF']) {
      const result = await evaluatePackageManager(command, root);
      assert.equal(result.decision, 'warn', command);
      assert.match(result.diagnostics.join('\n'), /inspection|unsupported/i);
    }
  });
});

void test('redirections do not hide manager calls and unsafe pipeline cd stays unresolved', async () => {
  await fixture({
    'package.json': JSON.stringify({ packageManager: 'pnpm@10' }),
    'npm/package.json': JSON.stringify({ packageManager: 'npm@11' }),
  }, async (root) => {
    assert.equal((await evaluatePackageManager('pnpm run check:all > log 2>&1; status=$?; exit $status', root)).decision, 'allow');
    assert.equal((await evaluatePackageManager('git status; pnpm exec playwright test --list > log 2>&1; tail log', root)).decision, 'allow');
    assert.equal((await evaluatePackageManager('cd npm && npm test | tail', root)).decision, 'allow');
    const mismatch = await evaluatePackageManager('cd npm && pnpm test | tail', root);
    assert.equal(mismatch.decision, 'block');
    assert.match(mismatch.diagnostics.join('\n'), /uses npm/i);
    assert.equal((await evaluatePackageManager('cd npm && npm dev & pnpm test', root)).decision, 'allow');
    assert.equal((await evaluatePackageManager('cd npm && echo x | cat && npm test', root)).decision, 'allow');
    for (const command of ['cd npm | pnpm test']) {
      const result = await evaluatePackageManager(command, root);
      assert.equal(result.decision, 'warn', command);
      assert.match(result.diagnostics.join('\n'), /dynamic or unresolved/i, command);
    }
  });
});

void test('never executes any text from the inspected command', async () => {
  await fixture(
    { 'package.json': JSON.stringify({ packageManager: 'pnpm@10' }) },
    async (root) => {
      const marker = path.join(root, 'inspected-command-ran');
      const result = await evaluatePackageManager(
        `pnpm install; node -e "require('node:fs').writeFileSync('${marker.replaceAll('\\', '/')}', 'ran')"`,
        root,
      );
      assert.equal(result.decision, 'allow');
      await assert.rejects(readFile(marker), /ENOENT/);
    },
  );
});

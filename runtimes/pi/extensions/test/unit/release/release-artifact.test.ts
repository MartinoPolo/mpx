import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { version as esbuildVersion } from 'esbuild';
import { test } from 'vitest';

import {
  CONFIG_ASSETS,
  GUARD_ASSETS,
  HOST_EXTERNALS,
  PACKAGE_ASSETS,
  THEME_ASSETS,
  VENDORED_LICENSE_ASSETS,
  assertAllowedImportSpecifiers,
  publishArtifact,
  verifyRelease,
  walkRegularFiles,
} from '../../../scripts/release.mjs';

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
const distRoot = path.join(packageRoot, 'dist');
const artifactRoot = path.join(distRoot, 'package');
const dependencyLicenseFiles = ['licenses/croner.LICENSE', 'licenses/nanoid.LICENSE'];
const payloadFiles = [
  'index.mjs',
  'package.json',
  ...PACKAGE_ASSETS,
  ...dependencyLicenseFiles,
].sort();
const completeArtifactFiles = [...payloadFiles, 'build-metadata.json'].sort();
const productionSourceInputs = [
  'agent-resurrect.ts',
  'auto-title.ts',
  'compact-instructions.ts',
  'config/COMPACT.md',
  'config/keybindings.json',
  'config/settings.json',
  'config/subagents.json',
  'dev-server/contract.ts',
  'dev-server/footer-format.ts',
  'dev-server/index.ts',
  'dev-server/log-buffer.ts',
  'dev-server/manager.ts',
  'dev-server/system-runtime.ts',
  'footer.ts',
  'fullscreen-scroll-speed.ts',
  'guard-hooks.ts',
  'guards/dangerous-command-guard.mjs',
  'guards/enforce-pkg-mgr.mjs',
  'guards/fallow-gate.mjs',
  'guards/format-lint-file.mjs',
  'guards/machine-paths.mjs',
  'guards/notify-flash-beep.ps1',
  'guards/post-bash-context.mjs',
  'guards/pre-commit-gate.mjs',
  'guards/shared.mjs',
  'index.ts',
  'lib/agent-directory.ts',
  'lib/compaction.ts',
  'lib/status-line.ts',
  'lib/statusline-ansi.ts',
  'lib/subagent-history.ts',
  'package.json',
  'scripts/release.mjs',
  'subagents/LICENSE',
  'subagents/abortable.ts',
  'subagents/agent-file-policy.ts',
  'subagents/agent-manager.ts',
  'subagents/agent-runner.ts',
  'subagents/agent-types.ts',
  'subagents/child-context.ts',
  'subagents/context.ts',
  'subagents/cross-extension-rpc.ts',
  'subagents/custom-agents.ts',
  'subagents/default-agents.ts',
  'subagents/enabled-models.ts',
  'subagents/env.ts',
  'subagents/group-join.ts',
  'subagents/index.ts',
  'subagents/invocation-config.ts',
  'subagents/memory.ts',
  'subagents/model-resolver.ts',
  'subagents/model-scope.ts',
  'subagents/nested-tools.ts',
  'subagents/notification-gate.ts',
  'subagents/output-file.ts',
  'subagents/prompts.ts',
  'subagents/safe-directory.ts',
  'subagents/schedule-store.ts',
  'subagents/schedule.ts',
  'subagents/settings.ts',
  'subagents/skill-loader.ts',
  'subagents/status-note.ts',
  'subagents/types.ts',
  'subagents/ui/agent-widget.ts',
  'subagents/ui/conversation-viewer.ts',
  'subagents/ui/fleet-list.ts',
  'subagents/ui/schedule-menu.ts',
  'subagents/ui/viewer-keys.ts',
  'subagents/usage.ts',
  'subagents/worktree.ts',
  'terminal-progress/index.ts',
  'terminal-progress/state.ts',
  'themes/amber.json',
  'themes/green.json',
] as const;

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function recomputeSourceTreeDigest(
  readInput: (relativePath: string) => Buffer = (relativePath) =>
    readFileSync(path.join(packageRoot, relativePath)),
): string {
  const hash = createHash('sha256');
  for (const relativePath of productionSourceInputs) {
    hash.update(relativePath);
    hash.update('\0');
    hash.update(readInput(relativePath));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function recomputeBundlerConfigDigest(target = 'node22'): string {
  const exactBundleConfig = {
    entryPoint: 'index.ts',
    outputFile: 'index.mjs',
    esbuildVersion,
    options: {
      bundle: true,
      external: HOST_EXTERNALS,
      format: 'esm',
      legalComments: 'none',
      minifyWhitespace: true,
      platform: 'node',
      sourcemap: false,
      target,
    },
  };
  return createHash('sha256').update(canonicalJson(exactBundleConfig)).digest('hex');
}

function runRelease(action: 'build' | 'verify'): void {
  execFileSync(process.execPath, [path.join(packageRoot, 'scripts', 'release.mjs'), action], {
    cwd: packageRoot,
    stdio: 'pipe',
  });
}

function snapshot(directory: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const absolute = path.join(current, entry);
      const entryStat = statSync(absolute);
      if (entryStat.isDirectory()) {
        visit(absolute);
      } else {
        const relative = path.relative(directory, absolute).replaceAll('\\', '/');
        result[relative] = createHash('sha256').update(readFileSync(absolute)).digest('hex');
      }
    }
  };
  visit(directory);
  return result;
}

function differentSha256(digest: string): string {
  assert.match(digest, /^[a-f0-9]{64}$/);
  const replacement = `${digest.startsWith('0') ? '1' : '0'}${digest.slice(1)}`;
  assert.match(replacement, /^[a-f0-9]{64}$/);
  assert.notEqual(replacement, digest);
  return replacement;
}

async function assertVerificationRejects(
  mutate: () => Promise<void>,
  expectedMessage?: RegExp,
): Promise<void> {
  runRelease('build');
  await mutate();
  if (expectedMessage) {
    assert.throws(() => runRelease('verify'), expectedMessage);
  } else {
    assert.throws(() => runRelease('verify'));
  }
}

async function mutateBundleAndRefreshInventory(addition: string): Promise<void> {
  const bundlePath = path.join(artifactRoot, 'index.mjs');
  const metadataPath = path.join(artifactRoot, 'build-metadata.json');
  const mutatedBundle = `${await readFile(bundlePath, 'utf8')}\n${addition}\n`;
  await writeFile(bundlePath, mutatedBundle);

  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
    files: Record<string, string>;
  };
  metadata.files['index.mjs'] = createHash('sha256').update(mutatedBundle).digest('hex');
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

async function assertImportPolicyVerificationRejects(
  addition: string,
  expectedMessage: string,
): Promise<void> {
  runRelease('build');
  await mutateBundleAndRefreshInventory(addition);
  await assert.rejects(verifyRelease(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, expectedMessage);
    assert.ok(error.message.length <= expectedMessage.length);
    return true;
  });
}

test('release builds are byte-identical', () => {
  runRelease('build');
  const first = snapshot(artifactRoot);
  runRelease('build');
  assert.deepEqual(snapshot(artifactRoot), first);
}, 20_000);

test('release manifest is the exact native Pi package manifest', () => {
  runRelease('build');
  assert.deepEqual(JSON.parse(readFileSync(path.join(artifactRoot, 'package.json'), 'utf8')), {
    name: '@mpx/pi-extensions',
    private: true,
    type: 'module',
    pi: {
      extensions: ['./index.mjs'],
      themes: ['./themes/amber.json', './themes/green.json'],
    },
  });
});

test('release uses the immutable asset inventory and includes every license', () => {
  runRelease('build');
  assert.deepEqual(HOST_EXTERNALS, [
    '@earendil-works/pi-ai',
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-tui',
    '@sinclair/typebox',
  ]);
  assert.deepEqual(CONFIG_ASSETS, [
    'config/COMPACT.md',
    'config/keybindings.json',
    'config/settings.json',
    'config/subagents.json',
  ]);
  assert.deepEqual(THEME_ASSETS, ['themes/amber.json', 'themes/green.json']);
  assert.deepEqual(GUARD_ASSETS, [
    'guards/dangerous-command-guard.mjs',
    'guards/enforce-pkg-mgr.mjs',
    'guards/fallow-gate.mjs',
    'guards/format-lint-file.mjs',
    'guards/machine-paths.mjs',
    'guards/notify-flash-beep.ps1',
    'guards/post-bash-context.mjs',
    'guards/pre-commit-gate.mjs',
    'guards/shared.mjs',
  ]);
  assert.deepEqual(VENDORED_LICENSE_ASSETS, ['subagents/LICENSE']);
  assert.deepEqual(Object.keys(snapshot(artifactRoot)).sort(), completeArtifactFiles);
});

test('bundle retains only host externals and node builtins', () => {
  runRelease('build');
  const bundle = readFileSync(path.join(artifactRoot, 'index.mjs'), 'utf8');
  const { staticSpecifiers, dynamicSpecifiers } = assertAllowedImportSpecifiers(bundle);
  const bareSpecifiers = [...staticSpecifiers, ...dynamicSpecifiers].filter(
    (specifier) =>
      !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('file:'),
  );

  assert.ok(staticSpecifiers.length > 0);
  for (const host of HOST_EXTERNALS) {
    assert.ok(bareSpecifiers.includes(host), host);
  }
  assert.equal(
    bareSpecifiers.some((specifier) => /^(?:croner|nanoid)(?:\/|$)/.test(specifier)),
    false,
  );
});

test('import policy accepts every exact host external in static and literal dynamic imports', () => {
  for (const host of HOST_EXTERNALS) {
    assert.deepEqual(assertAllowedImportSpecifiers(`import ${JSON.stringify(host)};`), {
      staticSpecifiers: [host],
      dynamicSpecifiers: [],
    });
    assert.deepEqual(assertAllowedImportSpecifiers(`void import(${JSON.stringify(host)});`), {
      staticSpecifiers: [],
      dynamicSpecifiers: [host],
    });
  }

  assert.deepEqual(assertAllowedImportSpecifiers("import 'node:fs/promises';"), {
    staticSpecifiers: ['node:fs/promises'],
    dynamicSpecifiers: [],
  });
});

test('import policy rejects host subpaths, unknown packages, and fake node builtins', () => {
  for (const specifier of [
    ...HOST_EXTERNALS.map((host) => `${host}/subpath`),
    'unapproved-package',
    'node:not-a-builtin',
  ]) {
    assert.throws(() => assertAllowedImportSpecifiers(`import ${JSON.stringify(specifier)};`), {
      message: 'Unapproved import specifier is forbidden',
    });
    assert.throws(
      () => assertAllowedImportSpecifiers(`void import(${JSON.stringify(specifier)});`),
      { message: 'Unapproved import specifier is forbidden' },
    );
  }
});

test('import policy rejects local, rooted, file URL, UNC, and drive imports', () => {
  const forbiddenSpecifiers = [
    '.',
    './local.mjs',
    '..',
    '../parent.mjs',
    '/rooted/local.mjs',
    'file:///rooted/local.mjs',
    String.raw`\\server\share\local.mjs`,
    String.raw`C:\rooted\local.mjs`,
    'C:/rooted/local.mjs',
  ];

  for (const specifier of forbiddenSpecifiers) {
    assert.throws(() => assertAllowedImportSpecifiers(`import ${JSON.stringify(specifier)};`), {
      message: 'Unapproved import specifier is forbidden',
    });
    assert.throws(
      () => assertAllowedImportSpecifiers(`void import(${JSON.stringify(specifier)});`),
      { message: 'Unapproved import specifier is forbidden' },
    );
  }
});

test('import policy rejects nonliteral dynamic imports', () => {
  assert.throws(
    () => assertAllowedImportSpecifiers("const target = 'node:fs'; void import(target);"),
    { message: 'Non-literal dynamic import is forbidden' },
  );
});

test('metadata recomputes the SHA-256 of every payload file', () => {
  runRelease('build');
  const metadata = JSON.parse(
    readFileSync(path.join(artifactRoot, 'build-metadata.json'), 'utf8'),
  ) as {
    schemaVersion: number;
    sourceTreeDigest: string;
    bundlerConfigDigest: string;
    files: Record<string, string>;
  };

  assert.deepEqual(Object.keys(metadata), [
    'schemaVersion',
    'sourceTreeDigest',
    'bundlerConfigDigest',
    'files',
  ]);
  assert.equal(metadata.schemaVersion, 1);
  const sourceTreeDigest = recomputeSourceTreeDigest();
  const bundlerConfigDigest = recomputeBundlerConfigDigest();
  assert.equal(metadata.sourceTreeDigest, sourceTreeDigest);
  assert.equal(metadata.bundlerConfigDigest, bundlerConfigDigest);
  assert.notEqual(
    sourceTreeDigest,
    recomputeSourceTreeDigest((relativePath) => {
      const bytes = readFileSync(path.join(packageRoot, relativePath));
      return relativePath === 'index.ts' ? Buffer.concat([bytes, Buffer.from('changed')]) : bytes;
    }),
  );
  assert.notEqual(bundlerConfigDigest, recomputeBundlerConfigDigest('node23'));
  assert.deepEqual(Object.keys(metadata.files), payloadFiles);
  for (const file of payloadFiles) {
    const digest = createHash('sha256')
      .update(readFileSync(path.join(artifactRoot, file)))
      .digest('hex');
    assert.equal(metadata.files[file], digest, file);
  }
  assert.doesNotMatch(JSON.stringify(metadata), /(?:[a-z]:[\\/]|timestamp|createdAt)/i);
});

test('verification rejects missing and tampered bundle, asset, and metadata files', async () => {
  await assertVerificationRejects(async () => {
    await rm(path.join(artifactRoot, 'config', 'COMPACT.md'));
  });
  await assertVerificationRejects(async () => {
    await writeFile(path.join(artifactRoot, 'index.mjs'), 'tampered');
  });
  await assertVerificationRejects(async () => {
    await writeFile(path.join(artifactRoot, 'guards', 'shared.mjs'), 'tampered');
  });
  await assertVerificationRejects(async () => {
    const metadataPath = path.join(artifactRoot, 'build-metadata.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      files: Record<string, string>;
    };
    metadata.files['index.mjs'] = '0'.repeat(64);
    await writeFile(metadataPath, JSON.stringify(metadata));
  });
}, 40_000);

test('verification reports import policy for an unapproved literal dynamic import', async () => {
  await assertImportPolicyVerificationRejects(
    "void import('unapproved-package');",
    'Unapproved import specifier is forbidden',
  );
});

test('verification reports import policy for a nonliteral dynamic import', async () => {
  await assertImportPolicyVerificationRejects(
    "const injectedImportTarget = 'node:fs'; void import(injectedImportTarget);",
    'Non-literal dynamic import is forbidden',
  );
});

test('verification recomputes source and bundler digests from checked inputs', async () => {
  for (const [field, expectedMessage] of [
    ['sourceTreeDigest', /source tree digest mismatch/],
    ['bundlerConfigDigest', /bundler config digest mismatch/],
  ] as const) {
    await assertVerificationRejects(async () => {
      const metadataPath = path.join(artifactRoot, 'build-metadata.json');
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<
        typeof field,
        string
      >;
      metadata[field] = differentSha256(metadata[field]);
      await writeFile(metadataPath, JSON.stringify(metadata));
    }, expectedMessage);
  }
}, 20_000);

test('verification rejects extra files, node_modules, nested lockfiles, and maps', async () => {
  await assertVerificationRejects(async () => {
    await writeFile(path.join(artifactRoot, 'unexpected.txt'), 'unexpected');
  });
  await assertVerificationRejects(async () => {
    const directory = path.join(artifactRoot, 'node_modules');
    await mkdir(directory);
    await writeFile(path.join(directory, 'dependency.js'), 'unexpected');
  }, /Forbidden release path/);
  await assertVerificationRejects(async () => {
    const directory = path.join(artifactRoot, 'nested');
    await mkdir(directory);
    await writeFile(path.join(directory, 'pnpm-lock.yaml'), 'unexpected');
  }, /Forbidden release path/);
  await assertVerificationRejects(async () => {
    await writeFile(path.join(artifactRoot, 'index.mjs.map'), 'unexpected');
  }, /Forbidden release path/);
}, 40_000);

test('walkers reject mocked symbolic links and unknown reparse entries', async () => {
  const symbolicLinkStat = {
    isSymbolicLink: () => true,
    isDirectory: () => false,
    isFile: () => false,
  };
  const unknownReparseStat = {
    isSymbolicLink: () => false,
    isDirectory: () => false,
    isFile: () => false,
  };

  await assert.rejects(
    walkRegularFiles('mock-root', {
      operations: {
        readdir: async () => ['link'],
        lstat: async () => symbolicLinkStat,
      },
    }),
    /Symbolic link, junction, or reparse point is forbidden/,
  );
  await assert.rejects(
    walkRegularFiles('mock-root', {
      operations: {
        readdir: async () => ['reparse'],
        lstat: async () => unknownReparseStat,
      },
    }),
    /Unsupported filesystem entry is forbidden/,
  );
});

test('verification rejects a real directory symlink or junction', async () => {
  runRelease('build');
  const target = await mkdtemp(path.join(tmpdir(), 'pi-release-junction-'));
  const themes = path.join(artifactRoot, 'themes');
  try {
    await writeFile(path.join(target, 'amber.json'), '{}');
    await rm(themes, { recursive: true });
    await symlink(target, themes, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(
      () => runRelease('verify'),
      /Symbolic link, junction, or reparse point is forbidden/,
    );
  } finally {
    await rm(themes, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test('complete relocated package resolves COMPACT and guard paths inside itself', async () => {
  runRelease('build');
  const relocatedRoot = path.join(distRoot, '.relocated-package');
  try {
    await rm(relocatedRoot, { recursive: true, force: true });
    await cp(artifactRoot, relocatedRoot, { recursive: true });
    const relocatedModule = (await import(
      `${pathToFileURL(path.join(relocatedRoot, 'index.mjs')).href}?relocated=1`
    )) as {
      resolveCompactInstructionsFile: (configured?: string) => string;
      resolveGuardsDirectory: () => string;
    };
    const compactPath = relocatedModule.resolveCompactInstructionsFile('');
    const guardsPath = relocatedModule.resolveGuardsDirectory();
    assert.equal(compactPath, path.join(relocatedRoot, 'config', 'COMPACT.md'));
    assert.equal(guardsPath, path.join(relocatedRoot, 'guards') + path.sep);
    assert.ok(statSync(compactPath).isFile());
    assert.ok(statSync(guardsPath).isDirectory());
  } finally {
    await rm(relocatedRoot, { recursive: true, force: true });
  }
}, 20_000);

test('failed atomic publish restores the previous valid artifact and cleans staging', async () => {
  runRelease('build');
  const previous = snapshot(artifactRoot);
  const staging = path.join(distRoot, '.injected-staging');
  const backup = path.join(distRoot, '.injected-backup');
  await rm(staging, { recursive: true, force: true });
  await rm(backup, { recursive: true, force: true });
  await cp(artifactRoot, staging, { recursive: true });
  await writeFile(path.join(staging, 'index.mjs'), 'replacement');
  let renameCount = 0;

  await assert.rejects(
    publishArtifact(staging, artifactRoot, backup, {
      renamePath: async (source, destination) => {
        renameCount += 1;
        if (renameCount === 2) {
          throw new Error('injected publish rename failure');
        }
        await rename(source, destination);
      },
    }),
    /injected publish rename failure/,
  );

  assert.deepEqual(snapshot(artifactRoot), previous);
  await assert.rejects(lstat(staging), { code: 'ENOENT' });
  await assert.rejects(lstat(backup), { code: 'ENOENT' });
  runRelease('verify');
}, 20_000);

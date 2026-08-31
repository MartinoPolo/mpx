import type { PreparationPlan } from '@mpx/config';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  PreparationEngine,
  createPreparationApproval,
  preparationApprovalPhrases,
  type PreparationAdapters,
  type PreparationState,
} from '../../src/preparation-engine.js';
import {
  productionTrustedExecutablePolicy,
  resolveTrustedExecutable,
  revalidateTrustedExecutable,
} from '../../src/trusted-executable.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function executableEnvironment(directory: string): {
  command: string;
  file: string;
  environment: Record<string, string>;
} {
  const command = 'mpx-trusted-test';
  const file = process.platform === 'win32' ? `${command}.exe` : command;
  return { command, file, environment: { PATH: directory, PATHEXT: '.COM;.EXE;.BAT;.CMD' } };
}

it.runIf(process.platform === 'win32' && Boolean(process.env.FNM_DIR))(
  'trusts the persistent canonical FNM Node installation instead of only its transient shell path',
  async () => {
    const policy = productionTrustedExecutablePolicy();
    const transientRoot = path
      .resolve(process.env.FNM_MULTISHELL_PATH ?? path.dirname(process.execPath))
      .toLowerCase();
    const persistent = policy.allowlist
      .filter((entry) => entry.command === 'node')
      .find(
        (entry) =>
          !path.resolve(entry.path).toLowerCase().startsWith(`${transientRoot}${path.sep}`),
      );
    expect(persistent?.path).toMatch(/node-versions.+node\.exe$/iu);
    await expect(resolveTrustedExecutable('node', tmpdir(), policy)).resolves.toMatchObject({
      path: persistent?.path,
    });
  },
);

it('rejects a malicious inherited PATH and resolves only the injected trusted allowlist', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx trusted executable '));
  roots.push(root);
  const malicious = path.join(root, 'repository', 'bin');
  const trusted = path.join(root, 'protected', 'bin');
  await mkdir(malicious, { recursive: true });
  await mkdir(trusted, { recursive: true });
  const { command, file, environment } = executableEnvironment(malicious);
  await writeFile(path.join(malicious, file), 'malicious bytes', { mode: 0o755 });
  const expected = path.join(trusted, file);
  await writeFile(expected, 'trusted bytes', { mode: 0o755 });

  const resolved = await resolveTrustedExecutable(command, path.join(root, 'repository'), {
    allowlist: [{ command, path: expected }],
    forbiddenRoots: [path.join(root, 'repository')],
    environment,
  });
  expect(resolved.path).toBe(await realpath(expected));
  expect(resolved.path).not.toContain('repository');
});

it('rejects an allowlisted executable candidate reached through a symlink', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx executable symlink '));
  roots.push(root);
  const worktree = path.join(root, 'repository');
  const protectedRoot = path.join(root, 'protected');
  await mkdir(worktree);
  await mkdir(protectedRoot);
  const target = path.join(protectedRoot, process.platform === 'win32' ? 'real.exe' : 'real');
  const linked = path.join(protectedRoot, process.platform === 'win32' ? 'linked.exe' : 'linked');
  await writeFile(target, 'trusted', { mode: 0o755 });
  if (process.platform === 'win32') {
    await execFileAsync('cmd', ['/c', 'mklink', linked, target]);
  } else {
    await symlink(target, linked);
  }
  await expect(
    resolveTrustedExecutable('tool', worktree, { allowlist: [{ command: 'tool', path: linked }] }),
  ).rejects.toMatchObject({ code: 'PREPARATION_EXECUTABLE_UNRESOLVED' });
});

it('rejects a pathname swap when executable evidence is revalidated immediately before spawn', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx executable swap '));
  roots.push(root);
  const worktree = path.join(root, 'repository');
  const protectedRoot = path.join(root, 'protected');
  await mkdir(worktree);
  await mkdir(protectedRoot);
  const executable = path.join(protectedRoot, process.platform === 'win32' ? 'tool.exe' : 'tool');
  await writeFile(executable, 'approved', { mode: 0o755 });
  const policy = { allowlist: [{ command: 'tool', path: executable }], forbiddenRoots: [worktree] };
  const approved = await resolveTrustedExecutable('tool', worktree, policy);
  await writeFile(executable, 'attacker replacement', { mode: 0o755 });
  await expect(revalidateTrustedExecutable(approved, policy)).rejects.toMatchObject({
    code: 'PREPARATION_EXECUTABLE_CHANGED',
  });
});

it('revalidates immutable launcher support files before spawn', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx launcher support '));
  roots.push(root);
  const protectedRoot = path.join(root, 'protected');
  await mkdir(protectedRoot);
  const launcher = path.join(protectedRoot, process.platform === 'win32' ? 'node.exe' : 'node');
  const support = path.join(protectedRoot, 'launcher.js');
  await writeFile(launcher, 'trusted launcher', { mode: 0o755 });
  await writeFile(support, "console.log('trusted')", { mode: 0o644 });
  const policy = {
    allowlist: [
      {
        command: 'launcher',
        path: launcher,
        trustedPrefixArguments: [support],
        supportFiles: [support],
      },
    ],
  };
  const approved = await resolveTrustedExecutable('launcher', path.join(root, 'worktree'), policy);
  expect(approved.trustedPrefixArguments).toEqual([await realpath(support)]);
  expect(approved.supportFiles).toEqual([
    expect.objectContaining({ path: await realpath(support) }),
  ]);
  await writeFile(support, "console.log('mutated')");
  await expect(revalidateTrustedExecutable(approved, policy)).rejects.toMatchObject({
    code: 'PREPARATION_EXECUTABLE_CHANGED',
  });
});

it.runIf(process.platform === 'win32')(
  'resolves Windows npm, pnpm, and yarn through node and never returns a cmd shim',
  async () => {
    const policy = productionTrustedExecutablePolicy();
    for (const command of ['npm', 'pnpm', 'yarn'] as const) {
      expect(
        policy.allowlist
          .filter((entry) => entry.command === command)
          .every((entry) => !entry.path.toLowerCase().endsWith('.cmd')),
      ).toBe(true);
      const resolved = await resolveTrustedExecutable(command, tmpdir(), policy);
      expect(resolved.path.toLowerCase()).toBe((await realpath(process.execPath)).toLowerCase());
      expect(resolved.trustedPrefixArguments[0]?.toLowerCase()).toContain(
        `${path.sep}node_modules${path.sep}`.toLowerCase(),
      );
      expect(resolved.path.toLowerCase()).not.toMatch(/\.cmd$/u);
    }
  },
);

it('makes an existing preparation approval stale when the approved executable bytes change', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx trusted approval '));
  roots.push(root);
  const worktree = path.join(root, 'worktree');
  const trusted = path.join(root, 'protected');
  await mkdir(worktree);
  await mkdir(trusted);
  const { command, file, environment } = executableEnvironment(trusted);
  const executable = path.join(trusted, file);
  await writeFile(executable, 'first bytes', { mode: 0o755 });
  const preparationPlan: PreparationPlan = {
    execution: 'foreground',
    steps: [{ id: 'run', uses: 'executable', argv: [command], required: true }],
    order: ['run'],
    logging: { maxOutputBytes: 65536, redactEnvironmentValues: true },
  };
  const states = new Map<string, PreparationState>();
  const adapters: PreparationAdapters = {
    evidence: {
      capture: async () => ({
        repositoryIdentity: 'fixture',
        head: 'head',
        configHash: 'config',
        packageManifestHash: 'package',
        lockfileHashes: [],
      }),
    },
    execution: {
      resolveExecutable: (value, cwd) =>
        resolveTrustedExecutable(value, cwd, {
          allowlist: [{ command, path: executable }],
          environment,
        }),
      spawn: async () => ({ exitCode: 0, output: '' }),
      startBackground: async () => ({ pid: 1, startFingerprint: 'unused' }),
    },
    store: {
      load: async (key) => states.get(key),
      compareAndSwap: async (key, expectedRevision, state) => {
        const current = states.get(key);
        if (
          current?.revision !== expectedRevision ||
          (current === undefined) !== (expectedRevision === undefined)
        ) {
          return false;
        }
        states.set(key, structuredClone(state));
        return true;
      },
      writeLogAtomic: async () => undefined,
    },
    clock: { now: () => 1, sleep: async () => undefined },
    process: { inspect: async () => undefined, terminateTree: async () => undefined },
    paths: { canonicalize: async (value) => value },
  };
  const approval = await createPreparationApproval(
    { plan: preparationPlan, worktreeRoot: worktree, packageManager: 'pnpm', environment: {} },
    adapters,
  );
  const policy = { allowlist: [{ command, path: executable }], environment };
  const firstHash = (await resolveTrustedExecutable(command, worktree, policy)).sha256;
  await writeFile(executable, 'changed bytes');
  const secondHash = (await resolveTrustedExecutable(command, worktree, policy)).sha256;
  expect(secondHash).not.toBe(firstHash);
  await expect(
    new PreparationEngine(adapters).prepare({
      key: 'trusted',
      approval,
      ...preparationApprovalPhrases(approval),
      plan: preparationPlan,
      worktreeRoot: worktree,
      packageManager: 'pnpm',
      environment: {},
      logDirectory: path.join(root, 'logs'),
    }),
  ).rejects.toMatchObject({ code: 'PREPARATION_APPROVAL_STALE' });
});

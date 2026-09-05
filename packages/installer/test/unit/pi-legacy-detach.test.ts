import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { PiLegacyDetachService, type PiLegacyDetachConfig } from '../../src/index.js';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const secret = 'SECRET-settings-marker';
const entries = [
  ['mpx-pi', 'agents', 'agents', 'empty'],
  ['mpx-pi', 'extensions', 'extensions', 'empty'],
  ['mpx-pi', 'prompts', 'prompts', 'empty'],
  ['mpx-pi', 'themes', 'themes', 'empty'],
  ['mpx-pi', 'APPEND_SYSTEM.md', 'APPEND_SYSTEM.md', 'file'],
  ['mpx-pi', 'keybindings.json', 'keybindings.json', 'file'],
  ['mpx-pi', 'settings.json', 'settings.json', 'file'],
  ['mpx-pi', 'subagents.json', 'subagents.json', 'file'],
  ['mpx-pi', 'skills/mp-symlink', 'skills/mp-symlink', 'tree'],
  ['mpx-pi', 'skills/mp-sync-base', 'skills/mp-sync-base', 'tree'],
  ['mpx-claude-code', 'instructions/AGENTS.md', 'AGENTS.md', 'file'],
  ['mpx-claude-code', 'skills/mp-fallow-fix', 'skills/mp-fallow-fix', 'tree'],
  ['mpx-claude-code', 'skills/mp-vocabulary', 'skills/mp-vocabulary', 'tree'],
] as const;

const materializationSource = (projectsRoot: string, repo: string, sourceName: string): string =>
  path.join(
    projectsRoot,
    repo,
    repo === 'mpx-claude-code' &&
      ['skills/mp-fallow-fix', 'skills/mp-vocabulary'].includes(sourceName)
      ? `plugins/mp/${sourceName}`
      : sourceName,
  );

async function makeLink(target: string, link: string, directory: boolean) {
  await mkdir(path.dirname(link), { recursive: true });
  if (process.platform === 'win32') {
    await execFileAsync(
      'cmd.exe',
      ['/d', '/s', '/c', 'mklink', ...(directory ? ['/D'] : []), link, target],
      {
        windowsVerbatimArguments: true,
      },
    );
  } else {
    await symlink(target, link, directory ? 'dir' : 'file');
  }
}

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string, prefix = ''): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const target = path.join(directory, name);
      const relative = path.posix.join(prefix, name);
      const info = await lstat(target);
      if (info.isSymbolicLink()) {
        snapshot[relative] = `link:${await readlink(target)}`;
      } else if (info.isDirectory()) {
        snapshot[`${relative}/`] = 'directory';
        await visit(target, relative);
      } else {
        snapshot[relative] = (await readFile(target)).toString('base64');
      }
    }
  };
  await visit(root);
  return snapshot;
}

async function assertSourcesAndSentinelsUnchanged(
  value: Awaited<ReturnType<typeof fixture>>,
  before: Record<string, string>,
) {
  expect(await snapshotTree(value.projectsRoot)).toEqual(before);
  expect(await readFile(path.join(value.personal, 'auth.json'), 'utf8')).toBe('sentinel');
  expect(await readFile(path.join(value.work, 'auth.json'), 'utf8')).toBe('sentinel');
}

async function assertAllLinksRestored(value: Awaited<ReturnType<typeof fixture>>, except?: string) {
  for (const root of [value.personal, value.work]) {
    for (const [repo, sourceName, destinationName] of entries) {
      const destination = path.join(root, destinationName);
      if (destination === except) {
        continue;
      }
      expect((await lstat(destination)).isSymbolicLink()).toBe(true);
      expect(path.resolve(path.dirname(destination), await readlink(destination))).toBe(
        path.join(value.projectsRoot, repo, sourceName),
      );
    }
  }
}

async function assertAllOutputsExact(value: Awaited<ReturnType<typeof fixture>>) {
  for (const root of [value.personal, value.work]) {
    for (const [repo, sourceName, destinationName, kind] of entries) {
      const destination = path.join(root, destinationName);
      expect((await lstat(destination)).isSymbolicLink()).toBe(false);
      if (kind === 'empty') {
        expect(await readdir(destination)).toEqual([]);
      } else if (kind === 'file') {
        expect(await readFile(destination)).toEqual(
          await readFile(materializationSource(value.projectsRoot, repo, sourceName)),
        );
      } else {
        expect(await snapshotTree(destination)).toEqual(
          await snapshotTree(materializationSource(value.projectsRoot, repo, sourceName)),
        );
      }
    }
  }
}

async function assertNoDiscardedArtifacts(value: Awaited<ReturnType<typeof fixture>>) {
  for (const root of [value.personal, value.work]) {
    expect(
      Object.keys(await snapshotTree(root)).filter((name) => name.includes('.mpx-legacy-detach-')),
    ).toEqual([]);
  }
  expect((await readdir(value.stateRoot)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
}

function makeLinkSync(target: string, link: string, directory: boolean) {
  if (process.platform === 'win32') {
    execFileSync('cmd.exe', [
      '/d',
      '/s',
      '/c',
      'mklink',
      ...(directory ? ['/D'] : []),
      link,
      target,
    ]);
  } else {
    symlinkSync(target, link, directory ? 'dir' : 'file');
  }
}

async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), 'mpx-legacy-detach-'));
  temporaryRoots.push(base);
  const projectsRoot = path.join(base, 'projects');
  const stateRoot = path.join(base, 'state');
  const personal = path.join(base, 'personal');
  const work = path.join(base, 'work');
  await Promise.all(
    [projectsRoot, stateRoot, personal, work].map((value) => mkdir(value, { recursive: true })),
  );
  for (const [repo, sourceName, , kind] of entries) {
    const source = materializationSource(projectsRoot, repo, sourceName);
    await mkdir(path.dirname(source), { recursive: true });
    if (kind === 'file') {
      await writeFile(
        source,
        sourceName === 'settings.json' ? `${secret}\r\n` : `bytes:${sourceName}\r\n`,
      );
    } else {
      await mkdir(source, { recursive: true });
      if (kind === 'tree') {
        await writeFile(path.join(source, 'payload.txt'), `tree:${sourceName}\r\n`);
      } else {
        await writeFile(path.join(source, 'generated.txt'), 'must-not-copy');
      }
    }
  }
  for (const root of [personal, work]) {
    await mkdir(path.join(root, 'skills'), { recursive: true });
    await writeFile(path.join(root, 'auth.json'), 'sentinel');
    for (const [repo, sourceName, destinationName, kind] of entries) {
      await makeLink(
        path.join(projectsRoot, repo, sourceName),
        path.join(root, destinationName),
        kind !== 'file',
      );
    }
  }
  const config: PiLegacyDetachConfig = {
    identities: {
      home: { domain: 'personal', runtimeRoots: { pi: personal } },
      office: { domain: 'work', runtimeRoots: { pi: work } },
    },
  };
  return { base, projectsRoot, stateRoot, personal, work, config };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it('detaches the exact inventory in both roots without changing sources or native sentinels', async () => {
  const value = await fixture();
  const before = await snapshotTree(value.projectsRoot);
  await new PiLegacyDetachService(value).run();

  await assertAllOutputsExact(value);
  await assertSourcesAndSentinelsUnchanged(value, before);
  await assertNoDiscardedArtifacts(value);
  const state = (
    await Promise.all(
      (await readdir(value.stateRoot))
        .filter((name) => name.endsWith('.json'))
        .map((name) => readFile(path.join(value.stateRoot, name), 'utf8')),
    )
  ).join('');
  expect(state).not.toContain(value.personal);
  expect(state).not.toContain(value.projectsRoot);
  expect(state).not.toContain(secret);
});

it.each(['missing', 'wrong', 'regular'] as const)(
  'fails closed for a %s inventory entry',
  async (mode) => {
    const value = await fixture();
    const target = path.join(value.personal, 'agents');
    await rm(target, { recursive: true, force: true });
    if (mode === 'wrong') {
      await makeLink(path.join(value.projectsRoot, 'mpx-pi', 'themes'), target, true);
    }
    if (mode === 'regular') {
      await mkdir(target);
    }

    await expect(new PiLegacyDetachService(value).run()).rejects.toMatchObject({
      code: 'PI_LEGACY_INVENTORY_INVALID',
    });
    expect((await lstat(path.join(value.work, 'agents'))).isSymbolicLink()).toBe(true);
    expect((await lstat(path.join(value.personal, 'themes'))).isSymbolicLink()).toBe(true);
  },
);

it('fails closed for an unknown dangling target in place of a relocated legacy link', async () => {
  const value = await fixture();
  const target = path.join(value.personal, 'skills', 'mp-fallow-fix');
  await rm(target, { force: true });
  await makeLink(path.join(value.projectsRoot, 'unknown', 'mp-fallow-fix'), target, true);

  await expect(new PiLegacyDetachService(value).run()).rejects.toMatchObject({
    code: 'PI_LEGACY_INVENTORY_INVALID',
  });
  expect((await lstat(path.join(value.work, 'skills', 'mp-fallow-fix'))).isSymbolicLink()).toBe(
    true,
  );
});

it('rejects a missing relocated source before mutating either root', async () => {
  const value = await fixture();
  await rm(materializationSource(value.projectsRoot, 'mpx-claude-code', 'skills/mp-fallow-fix'), {
    recursive: true,
  });

  await expect(new PiLegacyDetachService(value).run()).rejects.toMatchObject({
    code: 'PI_LEGACY_SOURCE_INVALID',
  });
  await assertAllLinksRestored(value);
});

it('rejects an unsafe relocated source tree before mutating either root', async () => {
  const value = await fixture();
  const tree = materializationSource(value.projectsRoot, 'mpx-claude-code', 'skills/mp-vocabulary');
  await makeLink(path.join(tree, 'payload.txt'), path.join(tree, 'alias.txt'), false);

  await expect(new PiLegacyDetachService(value).run()).rejects.toMatchObject({
    code: 'PI_LEGACY_SOURCE_INVALID',
  });
  await assertAllLinksRestored(value);
});

it('rejects a link within a source tree before mutating either root', async () => {
  const value = await fixture();
  const tree = path.join(value.projectsRoot, 'mpx-pi', 'skills', 'mp-symlink');
  await makeLink(path.join(tree, 'payload.txt'), path.join(tree, 'alias.txt'), false);
  await expect(new PiLegacyDetachService(value).run()).rejects.toMatchObject({
    code: 'PI_LEGACY_SOURCE_INVALID',
  });
  expect((await lstat(path.join(value.work, 'agents'))).isSymbolicLink()).toBe(true);
});

it('rejects a reparse ancestor in the source path before mutation', async () => {
  const value = await fixture();
  const repo = path.join(value.projectsRoot, 'mpx-pi');
  const moved = path.join(value.projectsRoot, 'mpx-pi-real');
  await rename(repo, moved);
  await makeLink(moved, repo, true);
  await expect(new PiLegacyDetachService(value).run()).rejects.toMatchObject({
    code: 'PI_LEGACY_SOURCE_INVALID',
  });
  expect((await lstat(path.join(value.work, 'agents'))).isSymbolicLink()).toBe(true);
});

it('uses a completed receipt as a verified no-op', async () => {
  const value = await fixture();
  const service = new PiLegacyDetachService(value);
  await service.run();
  await writeFile(path.join(value.personal, 'settings.json'), 'user changed');
  await service.run();
  expect(await readFile(path.join(value.personal, 'settings.json'), 'utf8')).toBe('user changed');
});

const crashOrdinals = [
  ['early-personal', 0],
  ['late-personal', 12],
  ['early-work', 13],
  ['late-work', 25],
] as const;
const mutationCrashMatrix = (['journaled', 'backed-up', 'installed', 'recorded'] as const).flatMap(
  (point) => crashOrdinals.map(([position, ordinal]) => [point, position, ordinal] as const),
);

it.each(mutationCrashMatrix)(
  'restores all links after an abrupt %s interruption at %s',
  async (point, _position, ordinal) => {
    const value = await fixture();
    const before = await snapshotTree(value.projectsRoot);
    let seen = 0;
    await expect(
      new PiLegacyDetachService({
        ...value,
        testCrash: (event) => {
          if (event === point && seen++ === ordinal) {
            throw new Error(secret);
          }
        },
      }).run(),
    ).rejects.toMatchObject({ code: 'PI_LEGACY_CRASH_INJECTED' });

    await new PiLegacyDetachService(value).run();
    await assertAllLinksRestored(value);
    await assertSourcesAndSentinelsUnchanged(value, before);
    await assertNoDiscardedArtifacts(value);
  },
  30_000,
);

it('redacts injected failures from errors and persisted state', async () => {
  const value = await fixture();
  let thrown: unknown;
  try {
    await new PiLegacyDetachService({
      ...value,
      testCrash: (event) => {
        if (event === 'journaled') {
          throw new Error(secret, { cause: secret });
        }
      },
    }).run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({ code: 'PI_LEGACY_CRASH_INJECTED' });
  expect(String(thrown)).not.toContain(secret);
  expect(JSON.stringify(thrown)).not.toContain(secret);
  expect(String(JSON.stringify((thrown as { cause?: unknown }).cause))).not.toContain(secret);
  const stateBodies = await Promise.all(
    (await readdir(value.stateRoot)).map((name) =>
      readFile(path.join(value.stateRoot, name)).catch(() => Buffer.alloc(0)),
    ),
  );
  expect(Buffer.concat(stateBodies).toString()).not.toContain(secret);
  expect(Buffer.concat(stateBodies).toString()).not.toContain(value.projectsRoot);
  expect(Buffer.concat(stateBodies).toString()).not.toContain(value.personal);
});

it('persists only strict opaque digest evidence in the journal', async () => {
  const value = await fixture();
  await expect(
    new PiLegacyDetachService({
      ...value,
      testCrash: (event) => {
        if (event === 'journaled') {
          throw new Error(secret);
        }
      },
    }).run(),
  ).rejects.toMatchObject({ code: 'PI_LEGACY_CRASH_INJECTED' });
  const journalPath = path.join(value.stateRoot, 'pi-legacy-detach.journal.json');
  const body = await readFile(journalPath, 'utf8');
  const journal = JSON.parse(body) as {
    stepIds: string[];
    expectedOutputs: Record<string, { kind: string; size: number; digest: string }>;
  };
  expect(body).not.toContain(value.projectsRoot);
  expect(body).not.toContain(value.personal);
  expect(body).not.toContain(secret);
  expect(Object.keys(journal.expectedOutputs)).toEqual(expect.arrayContaining(journal.stepIds));
  expect(Object.keys(journal.expectedOutputs)).toHaveLength(26);
  for (const id of journal.stepIds) {
    expect(id).toMatch(/^[a-f\d-]{36}$/iu);
    expect(journal.expectedOutputs[id]).toMatchObject({
      kind: expect.stringMatching(/^(empty|file|tree)$/u),
      size: expect.any(Number),
      digest: expect.stringMatching(/^[a-f\d]{64}$/u),
    });
  }
});

it.each(['extra', 'malformed', 'wrong-kind'] as const)(
  'strictly rejects %s journal evidence',
  async (mode) => {
    const value = await fixture();
    await expect(
      new PiLegacyDetachService({
        ...value,
        testCrash: (event) => {
          if (event === 'journaled') {
            throw new Error(secret);
          }
        },
      }).run(),
    ).rejects.toMatchObject({ code: 'PI_LEGACY_CRASH_INJECTED' });
    const journalPath = path.join(value.stateRoot, 'pi-legacy-detach.journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      stepIds: string[];
      expectedOutputs: Record<string, { kind: string; size: number; digest: string }>;
    };
    if (mode === 'extra') {
      journal.expectedOutputs['00000000-0000-4000-8000-000000000000'] =
        journal.expectedOutputs[journal.stepIds[0]!]!;
    } else if (mode === 'malformed') {
      journal.expectedOutputs[journal.stepIds[0]!]!.digest = 'not-a-digest';
    } else {
      journal.expectedOutputs[journal.stepIds[0]!]!.kind = 'file';
    }
    await writeFile(journalPath, JSON.stringify(journal));
    await expect(new PiLegacyDetachService(value).run()).rejects.toMatchObject({
      code: 'PI_LEGACY_STATE_INVALID',
    });
    await assertAllLinksRestored(value);
  },
);

it('leaves a concurrently replaced unjournaled stage fail-closed and reports cleanup-required', async () => {
  const value = await fixture();
  let foreignStage: string | undefined;
  await expect(
    new PiLegacyDetachService({
      ...value,
      testCrash: (event) => {
        if (event !== 'staged' || foreignStage) {
          return;
        }
        const name = readdirSync(value.personal).find((entry) => entry.endsWith('.stage'))!;
        foreignStage = path.join(value.personal, name);
        rmSync(foreignStage, { recursive: true, force: true });
        mkdirSync(foreignStage);
        writeFileSync(path.join(foreignStage, 'foreign.txt'), 'FOREIGN-CONTENT');
        throw new Error(secret);
      },
    }).run(),
  ).rejects.toMatchObject({ code: 'PI_LEGACY_OPERATION_FAILED' });

  let recoveryError: unknown;
  try {
    await new PiLegacyDetachService(value).run();
  } catch (error) {
    recoveryError = error;
  }
  expect(recoveryError).toMatchObject({ code: 'PI_LEGACY_CLEANUP_REQUIRED' });
  expect(String(recoveryError)).not.toContain(value.personal);
  expect(String(recoveryError)).not.toContain(secret);
  expect(await readFile(path.join(foreignStage!, 'foreign.txt'), 'utf8')).toBe('FOREIGN-CONTENT');
  await assertAllLinksRestored(value);
});

it.each(['regular file', 'foreign link'] as const)(
  'does not move or delete a %s introduced immediately before a later step',
  async (replacement) => {
    const value = await fixture();
    const target = path.join(value.personal, 'keybindings.json');
    const foreign = path.join(value.base, 'foreign.txt');
    await writeFile(foreign, 'FOREIGN-CONTENT');
    let seen = 0;
    await expect(
      new PiLegacyDetachService({
        ...value,
        testCrash: (event) => {
          if (event !== 'journaled' || seen++ !== 5) {
            return;
          }
          rmSync(target, { force: true });
          if (replacement === 'regular file') {
            writeFileSync(target, 'FOREIGN-CONTENT');
          } else {
            makeLinkSync(foreign, target, false);
          }
        },
      }).run(),
    ).rejects.toMatchObject({ code: 'PI_LEGACY_RECOVERY_FAILED' });

    if (replacement === 'regular file') {
      expect(await readFile(target, 'utf8')).toBe('FOREIGN-CONTENT');
    } else {
      expect(path.resolve(path.dirname(target), await readlink(target))).toBe(foreign);
    }
    for (const destinationName of [
      'agents',
      'extensions',
      'prompts',
      'themes',
      'APPEND_SYSTEM.md',
    ]) {
      expect((await lstat(path.join(value.personal, destinationName))).isSymbolicLink()).toBe(true);
    }
  },
);

it('rolls back across both roots when the work root drifts at a per-step boundary', async () => {
  const value = await fixture();
  const before = await snapshotTree(value.projectsRoot);
  const target = path.join(value.work, 'keybindings.json');
  let seen = 0;
  await expect(
    new PiLegacyDetachService({
      ...value,
      testCrash: (event) => {
        if (event !== 'journaled' || seen++ !== 18) {
          return;
        }
        rmSync(target, { force: true });
        writeFileSync(target, 'FOREIGN-WORK-CONTENT');
      },
    }).run(),
  ).rejects.toMatchObject({ code: 'PI_LEGACY_RECOVERY_FAILED' });

  expect(await readFile(target, 'utf8')).toBe('FOREIGN-WORK-CONTENT');
  await assertAllLinksRestored(value, target);
  await assertSourcesAndSentinelsUnchanged(value, before);
});

it('verifies installed outputs from staged evidence rather than a changed source', async () => {
  const value = await fixture();
  let seen = 0;
  await new PiLegacyDetachService({
    ...value,
    testCrash: (event) => {
      if (event === 'recorded' && seen++ === 25) {
        writeFileSync(path.join(value.projectsRoot, 'mpx-pi', 'settings.json'), 'changed source');
      }
    },
  }).run();
  expect(await readFile(path.join(value.personal, 'settings.json'), 'utf8')).toBe(`${secret}\r\n`);
});

it('uses immutable journal evidence for committed recovery after sources change', async () => {
  const value = await fixture();
  let crashed = false;
  await expect(
    new PiLegacyDetachService({
      ...value,
      testCrash: (event) => {
        if (!crashed && event === 'committed') {
          crashed = true;
          throw new Error(secret);
        }
      },
    }).run(),
  ).rejects.toMatchObject({ code: 'PI_LEGACY_CRASH_INJECTED' });

  await writeFile(path.join(value.projectsRoot, 'mpx-pi', 'settings.json'), 'changed source');
  await new PiLegacyDetachService(value).run();
  expect(await readFile(path.join(value.personal, 'settings.json'), 'utf8')).toBe(`${secret}\r\n`);
});

const committedCrashMatrix = [
  ['committed', 'after commit', -1],
  ...crashOrdinals.map(([position, ordinal]) => ['backup-removed', position, ordinal] as const),
  ['receipted', 'after receipt', -1],
] as const;

it.each(committedCrashMatrix)(
  'finishes committed recovery after an abrupt %s interruption at %s',
  async (point, _position, ordinal) => {
    const value = await fixture();
    const before = await snapshotTree(value.projectsRoot);
    let seen = 0;
    await expect(
      new PiLegacyDetachService({
        ...value,
        testCrash: (event) => {
          if (event === point && (ordinal < 0 || seen++ === ordinal)) {
            throw new Error(secret);
          }
        },
      }).run(),
    ).rejects.toMatchObject({ code: 'PI_LEGACY_CRASH_INJECTED' });

    const service = new PiLegacyDetachService(value);
    await service.run();
    await assertAllOutputsExact(value);
    await assertSourcesAndSentinelsUnchanged(value, before);
    await assertNoDiscardedArtifacts(value);
    await writeFile(path.join(value.personal, 'settings.json'), 'personal user setting');
    await writeFile(path.join(value.work, 'settings.json'), 'work user setting');
    await service.run();
    expect(await readFile(path.join(value.personal, 'settings.json'), 'utf8')).toBe(
      'personal user setting',
    );
    expect(await readFile(path.join(value.work, 'settings.json'), 'utf8')).toBe(
      'work user setting',
    );
  },
  30_000,
);

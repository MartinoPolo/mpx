import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseStrictJson, StrictJsonError } from '../../src/strict-json.js';
import { assertValid, validateProject } from '../../src/schema.js';
import { parseUserConfig } from '../../src/user-config.js';
import { confirmInit, planInit, rollbackConfirmedInit } from '../../src/init.js';
const base = (provider = 'github') => ({
  schemaVersion: 1,
  project: { id: 'acme/app' },
  repository: { provider, remote: 'origin' },
});
describe('closed project schema', () => {
  it.each(['github', 'gitlab', 'gerrit', 'generic'])('accepts %s', (p) =>
    expect(() => assertValid(validateProject, base(p))).not.toThrow(),
  );
  it('accepts provider IDs while keeping provider configuration data-only', () =>
    expect(() =>
      assertValid(validateProject, {
        ...base('trusted-forge'),
        issues: { provider: 'trusted-issues' },
      }),
    ).not.toThrow());
  it('accepts kanban', () =>
    expect(() =>
      assertValid(validateProject, {
        ...base(),
        issues: {
          provider: 'kanbanflow',
          boardId: 'b',
          states: { todo: '1', wip: '2', review: '3', done: '4' },
        },
      }),
    ).not.toThrow());
  it.each([
    { ...base(), extra: 1 },
    { ...base(), schemaVersion: 2 },
  ])('rejects unknown', (x) => expect(() => assertValid(validateProject, x)).toThrow());
  it('rejects launch defaults', () =>
    expect(() =>
      assertValid(validateProject, { ...base(), launchDefaults: { scopes: {}, projects: {} } }),
    ).toThrow());
  it.each(['../app', 'owner//app', 'owner/app/extra'])('rejects unsafe project ID %s', (id) =>
    expect(() => assertValid(validateProject, { ...base(), project: { id } })).toThrow(),
  );
});
it('rejects empty or duplicate preparation dependencies', () => {
  const config = {
    ...base(),
    worktrees: {
      postCreate: {
        execution: 'foreground',
        steps: [{ id: '', uses: 'package-install', dependsOn: ['build', 'build'] }],
      },
    },
  };
  expect(() => assertValid(validateProject, config)).toThrow();
});
it('keeps machine-local issue and vault roots out of committed project config', () => {
  expect(() =>
    assertValid(validateProject, {
      ...base(),
      issues: { provider: 'local', store: 'personal-issues', view: 'obsidian-issues' },
    }),
  ).not.toThrow();
  expect(() =>
    assertValid(validateProject, {
      ...base(),
      issues: {
        provider: 'local',
        root: 'issues',
        views: {
          vaultRoot: 'C:/vault',
          outputRoot: 'C:/vault/MPX/Issues',
          resumeBaseUrl: 'mpx://resume',
        },
      },
    }),
  ).toThrow();
  expect(() =>
    assertValid(validateProject, { ...base(), issues: { provider: 'local' } }),
  ).toThrow();
});
it('accepts identity-local logical issue store and view registrations', () => {
  const value = JSON.parse(user('C:/work'));
  value.localIssueStores = { 'personal-issues': { root: '${MPX_PROJECTS}' } };
  value.localViews = {
    'obsidian-issues': {
      vaultRoot: '${MPX_OBSIDIAN_VAULT}',
      outputRoot: 'C:/vault/MPX/Issues',
      vaultSubtree: 'MPX/Issues',
      resumeBaseUrl: 'mpx://resume',
    },
  };
  expect(() =>
    parseUserConfig(JSON.stringify(value), {
      MPX_PROJECTS: 'C:/projects',
      MPX_OBSIDIAN_VAULT: 'C:/vault',
    }),
  ).not.toThrow();
});
describe('strict json', () => {
  it.each(['{"a":1,"a":2}', '{"__proto__":1}', '{"nested":{"constructor":1}}'])(
    'rejects malicious %s',
    (s) => expect(() => parseStrictJson(s)).toThrow(StrictJsonError),
  );
  it('schema rejects secret fields', () =>
    expect(() => assertValid(validateProject, { ...base(), token: 'secret' })).toThrow());
});
const user = (root: string, pack = 'core') =>
  JSON.stringify({
    identities: {},
    domains: { work: [root] },
    contentScopes: { work: { roots: [root], skillPacks: [pack] } },
    modes: {},
    skillPolicies: {},
    presets: {},
    launchDefaults: { scopes: {}, projects: {} },
    networkPolicies: {},
    executors: { host: {} },
  });
it('interpolates only approved complete MPX root tokens', () => {
  expect(
    parseUserConfig(user('${MPX_WORK}'), { MPX_WORK: 'C:/work' }).contentScopes.work?.roots,
  ).toEqual(['C:/work']);
  expect(() => parseUserConfig(user('x/${MPX_WORK}'), { MPX_WORK: 'C:/work' })).toThrow();
  expect(() => parseUserConfig(user('${MPX_SECRET}'), { MPX_SECRET: 'secret' })).toThrow();
});
it('rejects unknown skill packs', () =>
  expect(() => parseUserConfig(user('C:/work', 'unknown'))).toThrow());
it('accepts the five Phase H service manifest shapes', async () => {
  const root = new URL('../fixtures/phase-h/', import.meta.url);
  for (const name of [
    'checkout.json',
    'coupled.json',
    'project-shared.json',
    'external-database.json',
    'test-consumer.json',
  ]) {
    const value = JSON.parse(await readFile(new URL(name, root), 'utf8'));
    expect(() => assertValid(validateProject, value), name).not.toThrow();
  }
});
it('requires a preferred port for fixed-shared services', () => {
  const service = {
    scope: 'checkout',
    port: { mode: 'fixed-shared' },
    start: { type: 'package-script', script: 'dev' },
  };
  expect(() =>
    assertValid(validateProject, { ...base(), development: { services: { app: service } } }),
  ).toThrow();
});
it('accepts bounded family identifiers and rejects unsafe ones', () => {
  const service = (family: string) => ({
    scope: 'checkout',
    port: { mode: 'managed', preferred: 4173, family },
    start: { type: 'package-script', script: 'dev' },
  });
  expect(() =>
    assertValid(validateProject, {
      ...base(),
      development: { services: { app: service('web.preview') } },
    }),
  ).not.toThrow();
  expect(() =>
    assertValid(validateProject, {
      ...base(),
      development: { services: { app: service('../web') } },
    }),
  ).toThrow();
});
it('init is deterministic and read-only', () =>
  expect(planInit('C:/repo', false)).toEqual(planInit('C:/repo', false)));
it('confirmed init applies its plan byte-idempotently', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'mpx-config-init-'));
  const manifest = {
    schemaVersion: 1 as const,
    project: { id: 'sample/app' },
    repository: { provider: 'generic', remote: 'REPLACE_ME' },
  };
  try {
    const first = await confirmInit(cwd, false, manifest);
    const bytes = await readFile(path.join(cwd, 'mpxconfig.json'), 'utf8');
    const second = await confirmInit(cwd, true, manifest);
    expect(first.plan.actions[0]?.type).toBe('create');
    expect(second.plan.actions[0]?.type).toBe('skip');
    expect(await readFile(path.join(cwd, 'mpxconfig.json'), 'utf8')).toBe(bytes);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
it('publishes exactly one manifest across concurrent confirmations', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'mpx-config-concurrent-'));
  const manifest = {
    schemaVersion: 1 as const,
    project: { id: 'sample/app' },
    repository: { provider: 'generic', remote: 'REPLACE_ME' },
  };
  try {
    const results = await Promise.allSettled([
      confirmInit(cwd, false, manifest),
      confirmInit(cwd, false, manifest),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await readdir(cwd)).toEqual(['mpxconfig.json']);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
it('uses an exclusive copy fallback when hard-link publication is unavailable', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'mpx-config-copy-fallback-'));
  const manifest = {
    schemaVersion: 1 as const,
    project: { id: 'sample/app' },
    repository: { provider: 'generic', remote: 'REPLACE_ME' },
  };
  try {
    const confirmation = await confirmInit(cwd, false, manifest, {
      link: async () => {
        throw Object.assign(new Error('unsupported'), { code: 'EXDEV' });
      },
      copyFile,
    });
    expect(confirmation.created).toBe(true);
    expect(await readFile(confirmation.manifestPath, 'utf8')).toContain('"sample/app"');
    expect(await readdir(cwd)).toEqual(['mpxconfig.json']);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
it('retries cleanup only for its published pending temporary', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'mpx-config-pending-cleanup-'));
  const unrelated = path.join(cwd, 'unrelated.tmp');
  const manifest = {
    schemaVersion: 1 as const,
    project: { id: 'sample/app' },
    repository: { provider: 'generic', remote: 'REPLACE_ME' },
  };
  try {
    await writeFile(unrelated, 'keep');
    const first = await confirmInit(cwd, false, manifest, {
      unlink: async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      },
    });
    expect(first.pendingTemporaryPath).toBeDefined();
    const second = await confirmInit(cwd, true, manifest);
    expect(second.pendingTemporaryPath).toBeUndefined();
    await expect(readFile(first.pendingTemporaryPath!, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(unrelated, 'utf8')).toBe('keep');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
it('rollback removes only its unchanged invocation-owned regular manifest', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'mpx-config-rollback-'));
  const manifest = {
    schemaVersion: 1 as const,
    project: { id: 'sample/app' },
    repository: { provider: 'generic', remote: 'REPLACE_ME' },
  };
  try {
    const confirmation = await confirmInit(cwd, false, manifest);
    await rollbackConfirmedInit(confirmation);
    expect(await readdir(cwd)).toEqual([]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
it('rollback preserves an invocation-owned manifest that was modified in place', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'mpx-config-modified-'));
  const manifestPath = path.join(cwd, 'mpxconfig.json');
  const manifest = {
    schemaVersion: 1 as const,
    project: { id: 'sample/app' },
    repository: { provider: 'generic', remote: 'REPLACE_ME' },
  };
  try {
    const confirmation = await confirmInit(cwd, false, manifest);
    await writeFile(manifestPath, 'modified');
    await rollbackConfirmedInit(confirmation);
    expect(await readFile(manifestPath, 'utf8')).toBe('modified');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
it('rollback preserves a replacement manifest with a different file identity', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'mpx-config-replacement-'));
  const manifestPath = path.join(cwd, 'mpxconfig.json');
  const manifest = {
    schemaVersion: 1 as const,
    project: { id: 'sample/app' },
    repository: { provider: 'generic', remote: 'REPLACE_ME' },
  };
  try {
    const confirmation = await confirmInit(cwd, false, manifest);
    await unlink(manifestPath);
    await writeFile(manifestPath, 'replacement', { flag: 'wx' });
    const replacement = await stat(manifestPath);
    await rollbackConfirmedInit(confirmation);
    const after = await stat(manifestPath);
    expect({ dev: after.dev, ino: after.ino }).toEqual({
      dev: replacement.dev,
      ino: replacement.ino,
    });
    expect(await readFile(manifestPath, 'utf8')).toBe('replacement');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
it('rollback preserves a directory that replaced the owned manifest', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'mpx-config-directory-replacement-'));
  const manifestPath = path.join(cwd, 'mpxconfig.json');
  const manifest = {
    schemaVersion: 1 as const,
    project: { id: 'sample/app' },
    repository: { provider: 'generic', remote: 'REPLACE_ME' },
  };
  try {
    const confirmation = await confirmInit(cwd, false, manifest);
    await unlink(manifestPath);
    await mkdir(manifestPath);
    await writeFile(path.join(manifestPath, 'keep'), 'directory');
    await rollbackConfirmedInit(confirmation);
    expect(await readFile(path.join(manifestPath, 'keep'), 'utf8')).toBe('directory');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

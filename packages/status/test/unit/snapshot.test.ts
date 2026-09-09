import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createRuntimeStatusSnapshotReader,
  createStatusSnapshotRefreshController,
  parseStatusSnapshot,
  readStatusSnapshot,
  type StatusSnapshot,
} from '../../src/index.js';

const validSnapshot: StatusSnapshot = {
  schemaVersion: 1,
  project: { id: 'acme/web', cwd: 'C:/repo' },
  worktree: { id: 'main', path: 'C:/repo', role: 'main', branch: 'main' },
  portResolution: 'valid',
  services: [
    {
      id: 'web',
      mode: 'managed',
      scope: 'checkout',
      protocol: 'http',
      port: 4102,
      listening: false,
      conflict: 'none',
      pid: null,
    },
  ],
  diagnostics: [],
};

describe('StatusSnapshot parsing', () => {
  it('returns an independently normalized snapshot after strict validation', () => {
    const input = structuredClone(validSnapshot);
    const parsed = parseStatusSnapshot(input);

    expect(parsed).toEqual(validSnapshot);
    expect(parsed).not.toBe(input);
    expect(parsed.project).not.toBe(input.project);
    expect(parsed.services).not.toBe(input.services);
  });

  it.each([
    ['unknown schema', { ...validSnapshot, schemaVersion: 2 }],
    ['missing field', { ...validSnapshot, diagnostics: undefined }],
    ['unknown field', { ...validSnapshot, legacyPorts: { web: 4102 } }],
    [
      'malformed nested value',
      { ...validSnapshot, services: [{ ...validSnapshot.services[0], port: 70_000 }] },
    ],
    [
      'terminal escapes',
      {
        ...validSnapshot,
        diagnostics: [
          { code: 'PORT_BAD', severity: 'error', message: 'bad\u001b[2J', serviceId: 'web' },
        ],
      },
    ],
    [
      'unsafe service id',
      { ...validSnapshot, services: [{ ...validSnapshot.services[0], id: 'web status' }] },
    ],
    [
      'unbounded diagnostic',
      {
        ...validSnapshot,
        diagnostics: [
          { code: 'PORT_BAD', severity: 'error', message: 'x'.repeat(2_000), serviceId: null },
        ],
      },
    ],
    [
      'malformed nested diagnostic',
      {
        ...validSnapshot,
        diagnostics: [{ code: 'PORT_BAD', severity: 'fatal', message: 'bad', serviceId: null }],
      },
    ],
  ])('rejects %s snapshots', (_name, input) => {
    expect(() => parseStatusSnapshot(input)).toThrow(/status snapshot/i);
  });
});

describe('runtime status snapshot reader', () => {
  it('asynchronously validates each read from a read-only snapshot source', async () => {
    let value: unknown = validSnapshot;
    const reader = createRuntimeStatusSnapshotReader(async () => value);

    await expect(reader.read()).resolves.toEqual(validSnapshot);
    value = { ...validSnapshot, schemaVersion: 9 };
    await expect(reader.read()).rejects.toThrow(/schemaVersion/i);
  });

  it('publishes post-launch snapshot changes on an injected asynchronous clock', async () => {
    let value: unknown = validSnapshot;
    let tick: (() => Promise<void>) | undefined;
    const reader = createRuntimeStatusSnapshotReader(async () => value);
    const controller = createStatusSnapshotRefreshController(reader, {
      schedule: (callback) => {
        tick = callback;
        return () => {
          tick = undefined;
        };
      },
    });
    controller.start();
    await tick?.();
    expect(controller.current()?.services[0]?.port).toBe(4102);
    value = { ...validSnapshot, portResolution: 'stale', services: [] };
    await tick?.();
    expect(controller.current()?.portResolution).toBe('stale');
    controller.stop();
  });

  it('consumes a failed scheduled tick and recovers while retaining the last valid snapshot', async () => {
    let value: unknown = validSnapshot;
    let tick: (() => Promise<void>) | undefined;
    const controller = createStatusSnapshotRefreshController(
      createRuntimeStatusSnapshotReader(async () => value),
      {
        schedule: (callback) => {
          tick = callback;
          return () => {
            tick = undefined;
          };
        },
      },
    );
    controller.start();
    await tick?.();
    value = { ...validSnapshot, schemaVersion: 9 };
    await expect(tick?.()).resolves.toBeUndefined();
    expect(controller.current()).toEqual(validSnapshot);
    value = { ...validSnapshot, portResolution: 'stale', services: [] };
    await tick?.();
    expect(controller.current()?.portResolution).toBe('stale');
  });

  it('reads only the explicitly supplied snapshot JSON file', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mpx-status-'));
    const snapshotPath = path.join(directory, 'runtime-status.json');
    await writeFile(snapshotPath, JSON.stringify(validSnapshot), 'utf8');

    await expect(readStatusSnapshot(snapshotPath)).resolves.toEqual(validSnapshot);
  });
});

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { WindowsProcessCapabilities, type PowerShellRunner } from '@mpx/windows';
import {
  ClaudeActiveScanner,
  PiV2ActiveRegistryScanner,
  type ProcessInspection,
  type ProcessInspector,
} from '../../src/index.js';

const startedAt = '2025-01-01T00:00:00.000Z';

const later = '2025-01-02T00:00:00.000Z';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each([
  [
    'agents',
    { agents: [{ kind: 'interactive', sessionId: 'current', cwd: 'C:/repo', pid: 42 }] },
    'current',
    42,
    null,
  ],
  [
    'sessions',
    {
      sessions: [
        { type: 'interactive', sessionId: 'legacy', cwd: 'C:/repo', pid: 43, name: 'Legacy' },
      ],
    },
    'legacy',
    43,
    'Legacy',
  ],
  [
    'array',
    [{ kind: 'interactive', sessionId: 'array', cwd: 'C:/repo', pid: 44, name: null }],
    'array',
    44,
    null,
  ],
] as const)(
  'discovers Claude interactive agents from the %s envelope',
  async (_label, payload, nativeSessionId, pid, title) => {
    const scanner = new ClaudeActiveScanner(async () => ({
      available: true,
      exitCode: 0,
      stdout: JSON.stringify(payload),
    }));

    const result = await scanner.scan();

    expect(result.status).toBe('available');
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      nativeSessionId,
      nativeSessionRef: { kind: 'native-id', value: nativeSessionId },
      cwd: 'C:/repo',
      pid,
      title,
    });
  },
);

it('excludes background Claude agents and fails closed on conflicting discriminators', async () => {
  const scan = (payload: unknown) =>
    new ClaudeActiveScanner(async () => ({
      available: true,
      exitCode: 0,
      stdout: JSON.stringify(payload),
    })).scan();

  await expect(
    scan({ agents: [{ kind: 'background', sessionId: 'worker', cwd: 'C:/repo', pid: 42 }] }),
  ).resolves.toMatchObject({ status: 'available', sessions: [] });
  await expect(
    scan({ agents: [{ kind: 'interactive', type: 'background' }] }),
  ).resolves.toMatchObject({ status: 'malformed', sessions: [] });
});

it.each([
  { kind: null },
  { kind: 1 },
  { type: null },
  { type: false },
  { kind: 'background', type: 1 },
])('fails closed when a present Claude discriminator is not a string: %j', async (agent) => {
  const scanner = new ClaudeActiveScanner(async () => ({
    available: true,
    exitCode: 0,
    stdout: JSON.stringify({ agents: [agent] }),
  }));

  await expect(scanner.scan()).resolves.toMatchObject({ status: 'malformed', sessions: [] });
});

async function registryFixture(pids: readonly number[]) {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-pi-discovery-'));
  roots.push(root);
  const registry = path.join(root, 'active-sessions');
  await mkdir(registry);
  const entries = pids.map((pid, index) => ({
    version: 2,
    agent: 'pi',
    sessionId: `session-${index}`,
    sessionFile: path.join(root, `session-${index}.jsonl`),
    cwd: root,
    name: `Session ${index}`,
    pid,
    processStartedAt: startedAt,
    registeredAt: startedAt,
  }));
  await Promise.all(
    entries.map(async (entry, index) => {
      await writeFile(entry.sessionFile, 'session');
      await writeFile(path.join(registry, `${index}.json`), JSON.stringify(entry));
    }),
  );
  return {
    root,
    registry,
    entries,
    scanner: (inspector: ProcessInspector) =>
      new PiV2ActiveRegistryScanner(root, registry, inspector, () => Date.parse(later)),
  };
}

function present(pid: number, startFingerprint = startedAt): ProcessInspection {
  return { status: 'present', pid, startFingerprint };
}

it('samples unique newest registry PIDs in one fresh batch per scan without changing native output', async () => {
  const fixture = await registryFixture([42, 42, 43]);
  await writeFile(
    path.join(fixture.registry, 'newest.json'),
    JSON.stringify({ ...fixture.entries[2], pid: 44, registeredAt: later, name: 'Newest' }),
  );
  const inspect = vi.fn();
  const inspectMany = vi
    .fn<NonNullable<ProcessInspector['inspectMany']>>()
    .mockResolvedValueOnce(
      new Map([
        [42, present(42)],
        [44, present(44)],
      ]),
    )
    .mockResolvedValueOnce(
      new Map([
        [42, present(42, later)],
        [44, present(44)],
      ]),
    );
  const scanner = fixture.scanner({ inspect, inspectMany });
  expect(await scanner.scan()).toEqual({
    status: 'available',
    diagnostic: null,
    sessions: fixture.entries.map((entry, index) => ({
      nativeSessionId: entry.sessionId,
      nativeSessionRef: { kind: 'root-relative-file', value: `session-${index}.jsonl` },
      cwd: fixture.root,
      title: index === 2 ? 'Newest' : entry.name,
      pid: index === 2 ? 44 : entry.pid,
      startFingerprint: startedAt,
    })),
  });
  expect(inspectMany).toHaveBeenCalledExactlyOnceWith([42, 44]);
  expect((await scanner.scan()).sessions.map((session) => session.nativeSessionId)).toEqual([
    'session-2',
  ]);
  expect(inspectMany).toHaveBeenNthCalledWith(2, [42, 44]);
  expect(inspect).not.toHaveBeenCalled();
});

it('filters each registry entry by exact PID and normalized fingerprint in the shared snapshot', async () => {
  const fixture = await registryFixture([42, 42, 43, 44, 46]);
  await writeFile(
    path.join(fixture.registry, '1.json'),
    JSON.stringify({ ...fixture.entries[1], processStartedAt: later }),
  );
  await writeFile(
    path.join(fixture.registry, '0.json'),
    JSON.stringify({ ...fixture.entries[0], processStartedAt: '2025-01-01T00:00:00.0000000Z' }),
  );
  const processes = new Map<number, ProcessInspection>([
    [42, present(42)],
    [43, present(143)],
    [44, present(44, later)],
    [46, { status: 'absent' }],
  ]);
  const result = await fixture
    .scanner({ inspect: vi.fn(), inspectMany: async () => processes })
    .scan();
  expect(result).toMatchObject({ status: 'available', diagnostic: null });
  expect(result.sessions.map((session) => session.nativeSessionId)).toEqual(['session-0']);
});

it.each(['unknown', 'missing'])(
  'reports %s process inspection as unavailable even alongside a valid session',
  async (status) => {
    const fixture = await registryFixture([42, 43]);
    const processes = new Map<number, ProcessInspection>([[42, present(42)]]);
    if (status === 'unknown') {
      processes.set(43, { status: 'unknown' });
    }
    expect(
      await fixture.scanner({ inspect: vi.fn(), inspectMany: async () => processes }).scan(),
    ).toEqual({
      status: 'unavailable',
      sessions: [],
      diagnostic: 'PI_PROCESS_INSPECTION_UNAVAILABLE',
    });
  },
);

it.each(['{', 'failed', 'throwing'])(
  'reports an uninspectable Windows batch as unavailable: %s',
  async (failure) => {
    const fixture = await registryFixture([42]);
    const run = vi.fn<PowerShellRunner['run']>(async () => {
      if (failure === 'throwing') {
        throw new Error('native query failed');
      }
      return { stdout: failure, stderr: '', exitCode: failure === 'failed' ? 1 : 0 };
    });
    expect(
      await fixture
        .scanner(new WindowsProcessCapabilities({ runner: { run } }).asProcessInspector())
        .scan(),
    ).toEqual({
      status: 'unavailable',
      sessions: [],
      diagnostic: 'PI_PROCESS_INSPECTION_UNAVAILABLE',
    });
    expect(run).toHaveBeenCalledTimes(1);
  },
);

it('discovers an accepted registry above the Windows batch limit with bounded deduplicated queries', async () => {
  const limit = WindowsProcessCapabilities.inspectionBatchLimit;
  const pids = Array.from({ length: limit + 1 }, (_, index) => index + 1);
  const fixture = await registryFixture([...pids, 1]);
  const batches: number[][] = [];
  const livePid = pids[pids.length - 1]!;
  let fail = false;
  const run = vi.fn<PowerShellRunner['run']>(async (_script, parameters) => {
    const batch = JSON.parse(parameters!.PidsJson!) as number[];
    batches.push(batch);
    return {
      stdout: JSON.stringify(
        batch.includes(livePid) ? [{ ProcessId: livePid, StartedAt: startedAt }] : [],
      ),
      stderr: '',
      exitCode: fail && batches.length % Math.ceil(pids.length / limit) === 0 ? 1 : 0,
    };
  });
  const scanner = fixture.scanner(
    new WindowsProcessCapabilities({ runner: { run } }).asProcessInspector(),
  );
  expect(await scanner.scan()).toEqual({
    status: 'available',
    diagnostic: null,
    sessions: [
      {
        nativeSessionId: `session-${limit}`,
        nativeSessionRef: { kind: 'root-relative-file', value: `session-${limit}.jsonl` },
        cwd: fixture.root,
        title: `Session ${limit}`,
        pid: livePid,
        startFingerprint: startedAt,
      },
    ],
  });
  const chunkCount = Math.ceil(pids.length / limit);
  expect(run).toHaveBeenCalledTimes(chunkCount);
  expect(batches.every((batch) => batch.length <= limit)).toBe(true);
  expect(batches.flat()).toHaveLength(pids.length);
  expect(new Set(batches.flat())).toEqual(new Set(pids));
  fail = true;
  expect(await scanner.scan()).toEqual({
    status: 'unavailable',
    sessions: [],
    diagnostic: 'PI_PROCESS_INSPECTION_UNAVAILABLE',
  });
  expect(run).toHaveBeenCalledTimes(chunkCount * 2);
}, 30_000);

it.each([
  undefined,
  null,
  {},
  new Map([[42, null]]),
  new Map([[42, { status: 'unexpected' }]]),
  new Map([[42, { status: 'present', pid: 42, startFingerprint: 123 }]]),
  new Map([[42, { status: 'present', pid: '42', startFingerprint: startedAt }]]),
  new Map([[142, present(142)]]),
])('rejects malformed batch inspection without probing individually: %j', async (output) => {
  const fixture = await registryFixture([42]);
  const inspect = vi.fn();
  const inspectMany = vi.fn(async () => output as ReadonlyMap<number, ProcessInspection>);
  await expect(fixture.scanner({ inspect, inspectMany }).scan()).rejects.toMatchObject({
    code: 'PI_PROCESS_INSPECTION_MALFORMED',
  });
  expect(inspect).not.toHaveBeenCalled();
});

it('does not turn a failed batch into an absent snapshot or retry it with individual probes', async () => {
  const fixture = await registryFixture([42]);
  const failure = new Error('process inspection unavailable');
  const inspect = vi.fn();
  await expect(
    fixture.scanner({ inspect, inspectMany: vi.fn().mockRejectedValue(failure) }).scan(),
  ).rejects.toBe(failure);
  expect(inspect).not.toHaveBeenCalled();
});

it('keeps inspect-only injection compatible with bounded, unique, scan-local probes', async () => {
  const pids = Array.from({ length: 20 }, (_, index) => index + 1);
  const fixture = await registryFixture([...pids, 1]);
  let active = 0;
  let maximumActive = 0;
  const inspect = vi.fn(async (pid: number) => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    await setImmediate();
    active--;
    return pid === 2 ? null : { startFingerprint: pid === 3 ? later : startedAt };
  });
  const scanner = fixture.scanner({ inspect });
  expect((await scanner.scan()).sessions).toHaveLength(19);
  expect(maximumActive).toBe(8);
  expect(inspect).toHaveBeenCalledTimes(pids.length);
  expect(inspect.mock.calls.filter(([pid]) => pid === 1)).toHaveLength(1);
  await scanner.scan();
  expect(inspect).toHaveBeenCalledTimes(pids.length * 2);
});

it('preserves inspect-only rejection semantics', async () => {
  const fixture = await registryFixture([42]);
  const failure = new Error('legacy probe failed');
  await expect(
    fixture.scanner({ inspect: vi.fn().mockRejectedValue(failure) }).scan(),
  ).rejects.toBe(failure);
});

it('does not inspect an empty registry', async () => {
  const fixture = await registryFixture([]);
  const inspect = vi.fn();
  const inspectMany = vi.fn();
  expect(await fixture.scanner({ inspect, inspectMany }).scan()).toEqual({
    status: 'available',
    diagnostic: null,
    sessions: [],
  });
  expect(inspect).not.toHaveBeenCalled();
  expect(inspectMany).not.toHaveBeenCalled();
});

it('validates all registry entries before batch inspection', async () => {
  const fixture = await registryFixture([42]);
  await writeFile(
    path.join(fixture.registry, 'invalid.json'),
    JSON.stringify({ ...fixture.entries[0], version: 3 }),
  );
  const inspectMany = vi.fn();
  await expect(fixture.scanner({ inspect: vi.fn(), inspectMany }).scan()).rejects.toMatchObject({
    code: 'PI_REGISTRY_MALFORMED',
  });
  expect(inspectMany).not.toHaveBeenCalled();
});

it('retains root containment checks only for fingerprint-verified registry entries', async () => {
  const fixture = await registryFixture([42]);
  await writeFile(
    path.join(fixture.registry, '0.json'),
    JSON.stringify({
      ...fixture.entries[0],
      sessionFile: path.join(fixture.root, '..', 'outside.jsonl'),
    }),
  );
  const inspectMany = vi
    .fn<NonNullable<ProcessInspector['inspectMany']>>()
    .mockResolvedValueOnce(new Map([[42, { status: 'unknown' }]]))
    .mockResolvedValueOnce(new Map([[42, present(42, later)]]))
    .mockResolvedValueOnce(new Map([[42, present(42)]]));
  const scanner = fixture.scanner({ inspect: vi.fn(), inspectMany });
  expect(await scanner.scan()).toEqual({
    status: 'unavailable',
    sessions: [],
    diagnostic: 'PI_PROCESS_INSPECTION_UNAVAILABLE',
  });
  expect((await scanner.scan()).sessions).toEqual([]);
  await expect(scanner.scan()).rejects.toMatchObject({ code: 'PI_SESSION_ROOT_ESCAPE' });
});

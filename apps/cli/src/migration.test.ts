import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  buildCutoverPlan,
  captureSourceDrift,
  createParityReport,
  executeParityChecks,
  inspectOwnedActivation,
  migrationProjectionRoots,
  parseProcessCommandLines,
  persistMigrationObservation,
  processCommandLines,
  rollbackDrill,
  runtimeAccessAudit,
} from './migration.js';

const exec = promisify(execFile);
async function gitFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-j-source-'));
  await exec('git', ['init'], { cwd: root });
  await exec('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
  await exec('git', ['config', 'user.name', 'Test'], { cwd: root });
  await mkdir(path.join(root, 'private'));
  await writeFile(path.join(root, 'kept.txt'), 'before');
  await writeFile(path.join(root, 'private', 'auth.json'), 'SECRET');
  await exec('git', ['add', '.'], { cwd: root });
  await exec('git', ['commit', '-m', 'base'], { cwd: root });
  return root;
}

describe('Phase J migration reconciliation', () => {
  it('captures tracked, dirty, deleted, renamed, and untracked drift without private content', async () => {
    const root = await gitFixture();
    await exec('git', ['mv', 'kept.txt', 'renamed.txt'], { cwd: root });
    await writeFile(path.join(root, 'new.txt'), 'new');
    await writeFile(path.join(root, 'private', 'auth.json'), 'CHANGED SECRET');
    const baseline = {
      sources: [{ id: 'claude', commit: 'baseline' }],
      entries: [
        { source: 'claude', path: 'kept.txt', sha256: 'old' },
        {
          source: 'claude',
          path: 'private/auth.json',
          sha256: null,
          disposition: 'excluded',
          reason: 'private-account-state',
        },
      ],
    };
    const result = await captureSourceDrift({
      baseline,
      sources: [{ id: 'claude', root, symbolicRoot: '${MPX_PROJECTS}/mpx-claude-code' }],
    });
    expect(result.sources[0]).toMatchObject({ id: 'claude', dirty: true });
    expect(result.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'kept.txt', state: 'renamed', renamedTo: 'renamed.txt' }),
        expect.objectContaining({ path: 'renamed.txt', state: 'renamed', renamedFrom: 'kept.txt' }),
        expect.objectContaining({ path: 'new.txt', state: 'untracked' }),
        expect.objectContaining({
          path: 'private/auth.json',
          privacy: 'private-account-state',
          sha256: null,
        }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain('CHANGED SECRET');
  });

  it('reports every source disposition/evidence and fails the explicit exception gate', () => {
    const baseline = {
      entries: [
        {
          source: 'claude',
          path: 'a',
          destination: 'content/a',
          disposition: 'canonicalized',
          evidence: [{ kind: 'behavior-test', reference: 'a.test' }],
        },
        { source: 'pi', path: 'b', destination: null, disposition: 'retired', evidence: [] },
      ],
    };
    const report = createParityReport({
      baseline,
      drift: { entries: [] },
      exceptions: [{ id: 'J-1', reason: 'live proof pending' }],
    });
    expect(report.sourceEntries).toHaveLength(2);
    expect(report.parity.map((item) => item.id)).toEqual([
      'semantic',
      'generation',
      'hooks',
      'tools',
      'status',
      'dependencies',
    ]);
    expect(report.gate).toMatchObject({ passed: false, exceptionCount: 1 });
  });

  it('accepts only bounded inline JSON arrays for offline process snapshots', async () => {
    expect(() => parseProcessCommandLines({ CommandLine: 'legacy' })).toThrow(
      'invalid command-line JSON',
    );
    await expect(processCommandLines('["captured command"]')).resolves.toEqual([
      'captured command',
    ]);
    await expect(processCommandLines(path.join(tmpdir(), 'arbitrary.json'))).rejects.toThrow(
      'inline JSON array',
    );
    await expect(processCommandLines(`[${' '.repeat(8 * 1024 * 1024)}]`)).rejects.toThrow(
      'bounded',
    );
    if (process.platform === 'win32') {
      await expect(
        processCommandLines(undefined, (async () => {
          throw new Error('command failed');
        }) as never),
      ).rejects.toThrow('process audit is unavailable');
    }
  });

  it('audits old access read-only with hashed evidence and supports legacy-disabled acceptance', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-j-audit-')),
      projects = process.env.MPX_PROJECTS ?? path.join(root, 'projects'),
      oldPi = path.join(projects, 'mpx-pi'),
      oldClaude = path.join(projects, 'mpx-claude-code');
    const log = path.join(root, 'runtime.log');
    await writeFile(log, `opened ${oldPi}/skills; token=secret`);
    const audit = await runtimeAccessAudit({
      roots: [root],
      processLines: [`node ${oldClaude}/bin.js --password nope`],
      environment: { MPX_PLUGIN_PATH: oldPi, API_TOKEN: 'secret' },
      legacyDisabled: true,
    });
    expect(audit.readOnly).toBe(true);
    expect(audit.findings.length).toBeGreaterThan(0);
    expect(audit.acceptance).toMatchObject({ mode: 'legacy-disabled', passed: false });
    expect(JSON.stringify(audit)).not.toContain('token=secret');
    expect(JSON.stringify(audit)).not.toContain('password nope');
  });

  it('binds exactly four projection routes without fallback and rejects duplicate roots', () => {
    const base = path.resolve(tmpdir(), 'mpx-projections'),
      one = path.join(base, 'one'),
      two = path.join(base, 'two'),
      three = path.join(base, 'three');
    const env = {
      LOCALAPPDATA: path.join(base, 'must-not-fallback'),
      MPX_CLAUDE_PERSONAL_PROJECTION_ROOT: one,
      MPX_CLAUDE_WORK_PROJECTION_ROOT: two,
      MPX_PI_PERSONAL_PROJECTION_ROOT: three,
    };
    expect(migrationProjectionRoots(env)).toEqual([
      { route: 'claude-personal', status: 'configured', root: one },
      { route: 'claude-work', status: 'configured', root: two },
      { route: 'pi-personal', status: 'configured', root: three },
      { route: 'pi-work', status: 'unconfigured' },
    ]);
    expect(() =>
      migrationProjectionRoots({ ...env, MPX_PI_WORK_PROJECTION_ROOT: 'relative' }),
    ).toThrowError(expect.objectContaining({ code: 'MIGRATION_AUDIT_ROOT_INVALID' }));
    expect(() =>
      migrationProjectionRoots({ ...env, MPX_PI_WORK_PROJECTION_ROOT: one }),
    ).toThrowError(expect.objectContaining({ code: 'MIGRATION_AUDIT_ROOT_DUPLICATE' }));
  });

  it('observes missing audit roots safely but blocks acceptance', async () => {
    const missing = path.join(tmpdir(), `mpx-missing-${Date.now()}`);
    const audit = await runtimeAccessAudit({
      roots: [{ label: 'appdata-logs', root: missing }],
      projectionRoots: [
        { route: 'claude-personal', status: 'configured', root: missing },
        { route: 'claude-work', status: 'unconfigured' },
        { route: 'pi-personal', status: 'unconfigured' },
        { route: 'pi-work', status: 'unconfigured' },
      ],
      legacyDisabled: true,
    });
    expect(audit.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'appdata-logs', status: 'missing' }),
        expect.objectContaining({ label: 'claude-work', status: 'unconfigured' }),
      ]),
    );
    expect(audit.acceptance.passed).toBe(false);
    expect(JSON.stringify(audit)).not.toContain(missing);
  });

  it('builds a semantic dependency closure before invoking its Vitest entries', async () => {
    const calls: { program: string; args: string[] }[] = [];
    const results = await executeParityChecks({
      repoRoot: path.resolve('.'),
      declarations: [
        {
          id: 'semantic',
          kind: 'vitest',
          entry: 'semantic.test.ts',
          buildFilters: ['@mpx/skills...', '@mpx/provider-github...'],
        },
      ],
      exists: async () => true,
      environment: { PNPM_HOME: path.resolve('pnpm-home') },
      runner: async (request) => {
        calls.push({ program: request.program, args: request.args });
        return { status: 'passed', exitCode: 0, stdout: '', stderr: '' };
      },
    });
    expect(results[0]?.status).toBe('passed');
    expect(calls).toEqual([
      {
        program: expect.stringMatching(/[\\/]pnpm(?:\.exe)?$/u),
        args: ['--filter', '@mpx/skills...', '--filter', '@mpx/provider-github...', 'build'],
      },
      {
        program: process.execPath,
        args: [
          path.join(path.resolve('.'), 'node_modules', 'vitest', 'vitest.mjs'),
          'run',
          'semantic.test.ts',
          '--reporter=dot',
        ],
      },
    ]);
  });

  it('keeps the active semantic parity check aligned with the skills unit-test path', async () => {
    const calls: string[][] = [];
    await executeParityChecks({
      repoRoot: path.resolve('.'),
      exists: async () => true,
      environment: { PNPM_HOME: path.resolve('pnpm-home') },
      runner: async (request) => {
        calls.push(request.args);
        return { status: 'passed', exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const semanticArgs = calls.find((args) =>
      args.includes('tests/contract/providers/conformance.test.ts'),
    );
    expect(semanticArgs).toContain('packages/skills/test/unit/canonical-content.test.ts');
    expect(calls.flat()).not.toContain('packages/skills/test/canonical-content.test.ts');
  });

  it('executes declared parity checks with bounded digest-only results and fail-closed gating', async () => {
    const calls: string[] = [];
    const results = await executeParityChecks({
      repoRoot: path.resolve('.'),
      declarations: [
        { id: 'ok', kind: 'node', entry: 'ok.mjs' },
        { id: 'slow', kind: 'vitest', entry: 'slow.test.ts' },
        { id: 'missing', kind: 'node', entry: 'missing.mjs' },
      ],
      exists: async (file) => !file.endsWith('missing.mjs'),
      runner: async (request) => {
        calls.push(request.program);
        if (request.args.includes('slow.test.ts')) {
          return {
            status: 'timed-out' as const,
            exitCode: null,
            stdout: 'partial secret',
            stderr: '',
          };
        }
        return { status: 'passed' as const, exitCode: 0, stdout: 'lots of output', stderr: '' };
      },
    });
    expect(results.map((item) => item.status)).toEqual(['passed', 'timed-out', 'unavailable']);
    expect(results[0]).toMatchObject({
      exitCode: 0,
      stdout: { bytes: 14, digest: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(JSON.stringify(results)).not.toContain('lots of output');
    expect(calls.every((program) => path.isAbsolute(program))).toBe(true);
    const report = createParityReport({
      baseline: { entries: [] },
      drift: { entries: [] },
      exceptions: [],
      parityResults: results,
    });
    expect(report.gate.passed).toBe(false);
    const failed = await executeParityChecks({
      repoRoot: path.resolve('.'),
      declarations: [{ id: 'failed', kind: 'node', entry: 'present.mjs' }],
      exists: async () => true,
      runner: async () => ({
        status: 'failed',
        exitCode: 2,
        stdout: '',
        stderr: 'failure details',
      }),
    });
    const notRun = await executeParityChecks({
      repoRoot: path.resolve('.'),
      declarations: [{ id: 'later', kind: 'node', entry: 'present.mjs' }],
      totalTimeoutMs: 0,
      exists: async () => true,
    });
    expect(failed[0]).toMatchObject({ status: 'failed', exitCode: 2 });
    expect(notRun[0]?.status).toBe('not-run');
    expect(
      createParityReport({
        baseline: { entries: [] },
        drift: { entries: [] },
        exceptions: [],
        parityResults: [...results, ...results],
      }).gate.passed,
    ).toBe(false);
  });

  it('persists deterministic private create-only observations and reuses only identical bytes', async () => {
    const local = await mkdtemp(path.join(tmpdir(), 'mpx-observations-'));
    const evidence = { kind: 'combined', audit: { passed: false }, secretFree: true };
    const created = await persistMigrationObservation({ localAppData: local, evidence });
    const reused = await persistMigrationObservation({ localAppData: local, evidence });
    expect(created).toMatchObject({
      kind: 'mpx-migration-observation',
      schemaVersion: 1,
      storage: 'localappdata/migration-observations',
      disposition: 'created',
    });
    expect(reused).toMatchObject({ ...created, disposition: 'reused' });
    expect(JSON.stringify(created)).not.toContain(local);
    const directory = path.join(local, 'mpx', 'migration-observations'),
      files = await import('node:fs/promises').then((fs) => fs.readdir(directory));
    expect(files).toEqual([`${created.digest}.json`]);
    await rm(path.join(directory, files[0]!), { force: true });
    await symlink(path.join(local, 'elsewhere'), path.join(directory, files[0]!));
    await expect(
      persistMigrationObservation({ localAppData: local, evidence }),
    ).rejects.toMatchObject({ code: 'MIGRATION_OBSERVATION_UNSAFE' });
    const raced = await mkdtemp(path.join(tmpdir(), 'mpx-observation-race-')),
      attacker = path.join(raced, 'attacker'),
      observations = path.join(raced, 'mpx', 'migration-observations'),
      displaced = path.join(raced, 'displaced');
    await mkdir(attacker);
    await expect(
      persistMigrationObservation({
        localAppData: raced,
        evidence: { race: true },
        hooks: {
          beforePublish: async () => {
            await rename(observations, displaced);
            await symlink(attacker, observations, 'junction');
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'MIGRATION_OBSERVATION_UNSAFE' });
    expect(await import('node:fs/promises').then((fs) => fs.readdir(attacker))).toEqual([]);
  });

  it('classifies owned markers strictly and binds non-exact status into cutover gating', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-markers-')),
      exact = path.join(root, 'exact'),
      malformed = path.join(root, 'malformed'),
      absent = path.join(root, 'absent');
    await writeFile(exact, '# start\nowned\n# end\n');
    await writeFile(malformed, '# start\nmissing end\n');
    const exactResult = await inspectOwnedActivation({
      file: exact,
      label: 'profile',
      startMarker: '# start',
      endMarker: '# end',
    });
    const malformedResult = await inspectOwnedActivation({
      file: malformed,
      label: 'bad',
      startMarker: '# start',
      endMarker: '# end',
    });
    expect(exactResult).toMatchObject({
      label: 'profile',
      status: 'exact',
      contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(malformedResult.status).toBe('malformed');
    expect(
      (
        await inspectOwnedActivation({
          file: absent,
          label: 'gone',
          startMarker: '# start',
          endMarker: '# end',
        })
      ).status,
    ).toBe('absent');
    expect(JSON.stringify([exactResult, malformedResult])).not.toContain(root);
    const inaccessible = path.join(root, 'linked');
    await symlink(exact, inaccessible);
    expect(
      (
        await inspectOwnedActivation({
          file: inaccessible,
          label: 'linked',
          startMarker: '# start',
          endMarker: '# end',
        })
      ).status,
    ).toBe('inaccessible');
    const raced = await inspectOwnedActivation({
      file: exact,
      label: 'raced',
      startMarker: '# start',
      endMarker: '# end',
      hooks: {
        afterOpen: async () => {
          await writeFile(exact, 'replacement with different bytes');
        },
      },
    });
    expect(raced.status).toBe('race');
    await writeFile(exact, '# start\nowned\n# end\n');
    const inPlace = await inspectOwnedActivation({
      file: exact,
      label: 'in-place',
      startMarker: '# start',
      endMarker: '# end',
      hooks: {
        afterOpen: async () => {
          const handle = await import('node:fs/promises').then((fs) => fs.open(exact, 'r+'));
          try {
            await handle.write(Buffer.from('X'), 0, 1, 0);
            await handle.sync();
          } finally {
            await handle.close();
          }
        },
      },
    });
    expect(inPlace.status).toBe('race');
    const plan = buildCutoverPlan({
      gatePassed: true,
      markerInspections: [exactResult, malformedResult],
    });
    expect(plan.actions.map((item) => item.eligible)).toEqual([true, false]);
    expect(plan.gatePassed).toBe(false);
  });

  it('fails closed on symlinked audit entries without following private links', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-j-malicious-audit-')),
      outside = await mkdtemp(path.join(tmpdir(), 'mpx-j-private-target-'));
    await writeFile(path.join(outside, 'secret.txt'), '/mp: SECRET-CONTENT');
    await symlink(
      outside,
      path.join(root, 'sessions'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(runtimeAccessAudit({ roots: [root], legacyDisabled: true })).rejects.toMatchObject(
      { code: 'MIGRATION_AUDIT_SYMLINK' },
    );
  });

  it('plans only exact owned removals behind the gate and restores an immutable rollback simulation', async () => {
    const body = 'foreign\n# >>> old-mpx owned >>>\nlegacy\n# <<< old-mpx owned <<<\n';
    const plan = buildCutoverPlan({
      gatePassed: false,
      ownedActivations: [
        {
          path: 'profile',
          startMarker: '# >>> old-mpx owned >>>',
          endMarker: '# <<< old-mpx owned <<<',
          content: body,
        },
      ],
    });
    expect(plan.actions[0]).toMatchObject({ kind: 'remove-owned-marker-block', eligible: false });
    expect(plan.manualOnly.map((x) => x.kind)).toEqual(['archive', 'rename', 'remotes']);
    expect(plan.confirmationDigest).toMatch(/^[a-f0-9]{64}$/);
    const drill = await rollbackDrill({
      content: body,
      startMarker: '# >>> old-mpx owned >>>',
      endMarker: '# <<< old-mpx owned <<<',
      now: new Date('2026-01-01T00:00:00Z'),
    });
    expect(drill).toMatchObject({ passed: true, snapshot: { immutable: true, retentionDays: 30 } });
    expect(drill.snapshot.digest).toBe(drill.restoredDigest);
  });
});

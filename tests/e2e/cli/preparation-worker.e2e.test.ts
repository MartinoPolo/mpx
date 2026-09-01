import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import type { PreparationPlan } from '@mpx/config';
import { createPreparationApproval, preparationApprovalPhrases } from '@mpx/worktrees';
import {
  preparationRuntime,
  cleanupPreparationWorker,
  pollPreparationTerminal,
  preparationDiagnostic,
  shouldRetryUnknownPreparation,
} from '@mpx/application/node';

const executeFile = promisify(execFile);
const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it('runs the production CLI preparation worker handshake through a trusted direct argv command', async () => {
  const diagnostics: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'mpx-preparation-worker-e2e-'));
    cleanup.push(temporary);
    const repository = path.join(temporary, 'repository');
    const localAppData = path.join(temporary, 'local');
    await executeFile('git', ['init', repository]);
    await writeFile(
      path.join(repository, 'mpxconfig.json'),
      `${JSON.stringify({ schemaVersion: 1, project: { id: 'fixture/preparation-worker' }, repository: { provider: 'generic', remote: 'origin' } })}\n`,
    );
    await executeFile('git', ['-C', repository, 'add', 'mpxconfig.json']);
    await executeFile('git', [
      '-C',
      repository,
      '-c',
      'user.name=MPX Test',
      '-c',
      'user.email=mpx@example.invalid',
      'commit',
      '-m',
      'fixture',
    ]);

    const stateRoot = path.join(localAppData, 'mpx');
    const runtime = preparationRuntime(
      stateRoot,
      { ...process.env, LOCALAPPDATA: localAppData },
      path.resolve(import.meta.dirname, '../../../apps/cli/dist/main.js'),
    );
    const plan: PreparationPlan = {
      execution: 'background',
      steps: [
        {
          id: 'harmless',
          uses: 'executable',
          argv: ['node', '-e', "process.stdout.write('worker-e2e-ready');setTimeout(()=>{},1500)"],
          required: true,
          timeoutSeconds: 30,
        },
      ],
      order: ['harmless'],
      logging: { maxOutputBytes: 65536, redactEnvironmentValues: true },
    };
    const packageManager = 'pnpm' as const;
    const approval = await createPreparationApproval(
      {
        plan,
        worktreeRoot: repository,
        packageManager,
        environment: { ...process.env, LOCALAPPDATA: localAppData },
      },
      runtime.adapters,
    );
    const key = 'production-worker-e2e';
    await runtime.run({
      key,
      plan,
      worktreeRoot: repository,
      packageManager,
      exactApproval: JSON.stringify(preparationApprovalPhrases(approval)),
    });
    const state = await pollPreparationTerminal(() => runtime.adapters.store.load(key), {
      deadline: Date.now() + 60_000,
      intervalMs: 50,
    });
    if (shouldRetryUnknownPreparation(attempt, state)) {
      diagnostics.push(preparationDiagnostic(state));
      await cleanupPreparationWorker(state, () => runtime.cancel(key));
      continue;
    }
    try {
      expect(state?.status, [...diagnostics, preparationDiagnostic(state)].join(' | ')).toBe(
        'ready',
      );
      expect(state?.worker).toMatchObject({
        pid: expect.any(Number),
        startFingerprint: expect.any(String),
        ownerToken: expect.any(String),
      });
      expect(state?.steps).toMatchObject([
        { id: 'harmless', status: 'ready', logPath: expect.any(String) },
      ]);
      expect(await readFile(state!.steps[0]!.logPath!, 'utf8')).toContain('worker-e2e-ready');
      expect(
        await readdir(path.join(stateRoot, 'worktrees', 'preparation', 'worker-requests')),
      ).toEqual([]);
      return;
    } finally {
      await cleanupPreparationWorker(state, () => runtime.cancel(key)).catch(() => undefined);
    }
  }
}, 130_000);

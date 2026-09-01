import { expect, it, vi } from 'vitest';
import {
  MigrationApplicationService,
  type MigrationApplicationRequest,
  type MigrationExecutionPort,
} from '../../src/migration-application-service.js';

it('delegates the migration request to the injected execution port and returns its data', async () => {
  const request: MigrationApplicationRequest = {
    action: 'report',
    repoRoot: '/repo',
    env: { MPX_PROJECTS: '/projects' },
    legacyDisabled: true,
  };
  const data = { schemaVersion: 1, kind: 'mpx-phase-j-parity-report' };
  const execute = vi.fn(async () => data);
  const service = new MigrationApplicationService({ execute } satisfies MigrationExecutionPort);

  await expect(service.execute(request)).resolves.toBe(data);
  expect(execute).toHaveBeenCalledOnce();
  expect(execute).toHaveBeenCalledWith(request);
});

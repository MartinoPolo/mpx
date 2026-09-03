import { expect, it, vi } from 'vitest';
import type { InstallApplicationService, InstallApplicationRequest } from '@mpx/application';
import { executeInstallCommand } from '../../src/install-command.js';

function input(
  action: string | undefined,
  options: [string, string | boolean][] = [],
  args: string[] = [],
) {
  return { action, args, options: new Map<string, string | boolean | string[]>(options) };
}

function service(result: unknown = { ok: true }) {
  const execute = vi.fn(async (_request: InstallApplicationRequest) => result);
  return { application: { execute } as Pick<InstallApplicationService, 'execute'>, execute };
}

it('rejects positional arguments before handling the action', async () => {
  const target = service();
  await expect(
    executeInstallCommand(input(undefined, [], ['unexpected']), target),
  ).rejects.toMatchObject({
    code: 'INSTALL_USAGE_ERROR',
    message: 'install commands accept no positional arguments',
  });
  expect(target.execute).not.toHaveBeenCalled();
});

it.each([
  ['intent', [['request', 'request.json']], { action: 'intent', request: 'request.json' }],
  ['prepare', [['request', 'request.json']], { action: 'prepare', request: 'request.json' }],
  ['plan', [['intent', 'intent.json']], { action: 'plan', intent: 'intent.json' }],
  [
    'apply',
    [
      ['plan', 'plan.json'],
      ['confirm-plan', 'digest'],
    ],
    { action: 'apply', plan: 'plan.json', confirmation: 'digest' },
  ],
  [
    'verify',
    [
      ['strict', true],
      ['external-plan', 'external.json'],
    ],
    { action: 'verify', strict: true, externalPlan: 'external.json' },
  ],
  [
    'rollback',
    [
      ['transaction', 'tx'],
      ['confirm-plan', 'digest'],
    ],
    { action: 'rollback', transaction: 'tx', confirmation: 'digest' },
  ],
  ['uninstall', [['confirm-plan', 'digest']], { action: 'uninstall', confirmation: 'digest' }],
] as const)(
  'maps %s grammar to a discriminated application request',
  async (action, options, expected) => {
    const target = service();
    await executeInstallCommand(
      input(action, [...options] as [string, string | boolean][]),
      target,
    );
    expect(target.execute).toHaveBeenCalledWith(expected);
  },
);

it('preserves the application result as the CLI data envelope', async () => {
  const apply = { schemaVersion: 1, kind: 'install-apply', receipt: { kind: 'receipt' } };
  const target = service(apply);
  await expect(executeInstallCommand(input('apply'), target)).resolves.toEqual({ data: apply });
});

it('rejects an unsupported action without invoking the service', async () => {
  const target = service();
  await expect(executeInstallCommand(input('unknown'), target)).rejects.toMatchObject({
    message: 'install requires intent, prepare, plan, apply, verify, rollback, or uninstall',
  });
  expect(target.execute).not.toHaveBeenCalled();
});

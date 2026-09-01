import { describe, expect, it, vi } from 'vitest';
import { executeAccountCommand } from '../../src/account-command.js';

describe('account command grammar adapter', () => {
  it('forwards the parsed action request unchanged to the prebuilt application service', async () => {
    const request = {
      action: 're-enroll' as const,
      identityName: 'work',
      confirmationDigest: 'digest',
    };
    const output = { schemaVersion: 1, status: 're-enrolled' };
    const service = { execute: vi.fn(async () => output) };
    await expect(executeAccountCommand(request, service)).resolves.toBe(output);
    expect(service.execute).toHaveBeenCalledWith(request);
  });
});

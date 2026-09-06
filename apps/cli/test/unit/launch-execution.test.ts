import { describe, expect, it } from 'vitest';
import { defaultContext } from '../../src/context.js';
import { captureIo } from '../../src/io.js';
import { run } from '../../src/main.js';

describe('canonical launch dispatch', () => {
  it('provides production route and audit services on the default context', () => {
    expect(defaultContext.launchRoutes).toBeDefined();
    expect(defaultContext.launchAudit).toBeDefined();
  });

  it.each(['claude', 'pi'] as const)('admits launch %s through routing', async (runtime) => {
    const io = captureIo();

    expect(await run(['launch', runtime, '--runtime-arg', '--version'], io, { env: {} })).toBe(1);
    expect(io.err.join('')).not.toContain('RUNTIME_ARGS_SCOPE_INVALID');
  });

  it('rejects runtime arguments outside canonical launch execution', async () => {
    const io = captureIo();

    expect(await run(['doctor', '--runtime-arg', '--version'], io, { env: {} })).toBe(1);
    expect(io.err.join('')).toContain('RUNTIME_ARGS_SCOPE_INVALID');
  });

  it('rejects host approval outside canonical launch execution', async () => {
    const io = captureIo();

    expect(await run(['doctor', '--approve-host'], io, { env: {} })).toBe(1);
    expect(io.err.join('')).toContain('HOST_APPROVAL_SCOPE_INVALID');
  });
});

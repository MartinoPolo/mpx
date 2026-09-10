import { expect, it, vi } from 'vitest';
import { createNodeSessionApplicationService } from '../../src/node/session-application-service.js';

it('scopes the initial Node lifecycle consumption before opening excluded event directories', async () => {
  const identity = { domain: 'personal', name: 'main' };
  const eventDirectory = vi.fn(() => {
    throw new Error('excluded directory');
  });
  const store = {
    listLifecycleBindingIds: async () => ['work-pi', 'personal-claude'],
    readLifecycleBinding: async (bindingId: string) => ({
      binding:
        bindingId === 'work-pi'
          ? { runtime: 'pi', identityRef: 'work:main' }
          : { runtime: 'claude', identityRef: 'personal:main' },
    }),
    eventDirectory,
  };
  const reconcile = vi.fn(async () => ({ records: [], diagnostics: [] }));
  const application = createNodeSessionApplicationService({
    store: store as never,
    planCurrentResume: vi.fn(),
    sessionService: { list: async () => [], reconcile } as never,
  });
  await application.list({ filter: { runtime: 'pi', identity, liveness: 'active' } });
  expect(eventDirectory).not.toHaveBeenCalled();
  expect(reconcile).toHaveBeenCalledExactlyOnceWith(['work-pi', 'personal-claude'], {
    runtime: 'pi',
    identity,
  });
});

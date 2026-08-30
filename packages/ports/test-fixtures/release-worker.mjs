import { PortService, RegistryStore } from '../dist/index.js';

process.on('message', async (message) => {
  if (message?.type !== 'go') {
    return;
  }
  const { stateRoot, main, identity } = message;
  const git = { identify: async () => main, list: async () => [main] };
  const platform = {
    holdAvailablePorts: async () => ({ release: async () => undefined }),
    inspectListeners: async () => [],
    killProcess: async () => undefined,
    inspectProcess: async () => undefined,
  };
  try {
    const result = await new PortService({
      store: new RegistryStore(stateRoot, { retryMs: 1 }),
      git,
      platform,
    }).releaseLinkedAfterRemoval({ repositoryCwd: main.path, identity });
    process.send?.({ type: 'done', result });
  } catch (error) {
    process.send?.({ type: 'error', error: { message: String(error), code: error?.code } });
  }
});
process.send?.({ type: 'ready' });

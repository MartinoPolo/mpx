import { PortService, RealGitWorktreeAdapter, RegistryStore } from '../dist/index.js';

const send = (message) => process.send?.(message);
const waitFor = (type) =>
  new Promise((resolve) => {
    const listener = (message) => {
      if (message?.type === type) {
        process.off('message', listener);
        resolve(message);
      }
    };
    process.on('message', listener);
  });

send({ type: 'ready', pid: process.pid });
const { stateRoot, cwd, config, configHash } = await waitFor('go');
const platform = {
  holdAvailablePorts: async (ports) => {
    send({ type: 'holding', ports });
    await waitFor('continue');
    return { release: async () => undefined };
  },
  inspectListeners: async () => [],
  killProcess: async () => undefined,
  inspectProcess: async () => undefined,
};
const service = new PortService({
  store: new RegistryStore(stateRoot),
  git: new RealGitWorktreeAdapter(),
  platform,
});
send({ type: 'ensuring', cwd });
try {
  const result = await service.ensure({ cwd, config, configHash });
  send({ type: 'done', lease: result.lease });
  process.disconnect?.();
} catch (error) {
  send({ type: 'failed', message: String(error), code: error?.code });
  process.exitCode = 1;
  process.disconnect?.();
}

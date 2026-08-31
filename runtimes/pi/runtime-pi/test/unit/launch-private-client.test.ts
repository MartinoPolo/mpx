import { expect, it } from 'vitest';
import { RUNTIME_TOOL_INVENTORY_SHA256 } from '@mpx/runtime-tools';
import { parseLaunchPrivateClientConfig } from '../../src/launch-private-client.js';
const h = (c: string) => c.repeat(64);
const config = {
  schemaVersion: 1,
  endpoint: 'tcp://127.0.0.1:4312',
  nonce: h('a'),
  launchKey: h('b'),
  identity: { name: 'personal', domain: 'personal' },
  planKey: h('c'),
  runtimeToolInventorySha256: RUNTIME_TOOL_INVENTORY_SHA256,
  capabilitySha256: h('d'),
};
it('fails closed for absent, cross-identity, and stale launch-private bridge configuration', () => {
  expect(() =>
    parseLaunchPrivateClientConfig(undefined, {
      launchKey: config.launchKey,
      identity: config.identity,
    }),
  ).toThrow(/BRIDGE_CONFIG_REQUIRED/u);
  expect(() =>
    parseLaunchPrivateClientConfig(JSON.stringify(config), {
      launchKey: config.launchKey,
      identity: { name: 'work', domain: 'work' },
    }),
  ).toThrow(/BRIDGE_ATTESTATION_FAILED/u);
  expect(() =>
    parseLaunchPrivateClientConfig(JSON.stringify({ ...config, launchKey: h('e') }), {
      launchKey: config.launchKey,
      identity: config.identity,
    }),
  ).toThrow(/BRIDGE_ATTESTATION_FAILED/u);
});

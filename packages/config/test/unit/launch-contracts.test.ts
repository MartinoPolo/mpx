import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseUserConfig } from '../../src/user-config.js';

const text = readFileSync(
  new URL('../fixtures/user-launch-contracts.json', import.meta.url),
  'utf8',
);
const fixture = (): any => JSON.parse(text);
const environment = {
  MPX_PROJECTS: 'C:/projects',
  MPX_WORK: 'C:/work',
  MPX_CLONED: 'C:/cloned',
  MPX_OBSIDIAN_VAULT: 'C:/obsidian',
  MPX_AI_GENERATED: 'C:/generated',
  HOME: 'C:/Users/me',
};

it.each([
  [
    'secret-like property',
    (value: any) => {
      value.apiKey = 'x';
    },
  ],
  [
    'secret-like value',
    (value: any) => {
      value.localIssueStores = { issues: { root: 'token' } };
    },
  ],
  [
    'native runtime auth injection',
    (value: any) => {
      value.identities.personal.runtimeRoots.auth = 'auth.json';
    },
  ],
] as const)('rejects %s in UserConfig v2', (_label, mutate) => {
  const value = fixture();
  mutate(value);
  expect(() => parseUserConfig(JSON.stringify(value), environment)).toThrow();
});

it.each(['private-key', 'id_rsa.pub', 'id_ecdsa', 'id_ed25519_sk.pub', 'ssh.exe', 'route.pem'])(
  'rejects unsafe SSH route label %s',
  (route) => {
    const value = fixture();
    value.identities.personal.sshRoute = route;
    expect(() => parseUserConfig(JSON.stringify(value), environment)).toThrow();
  },
);

it.each(['id_rsa', 'id_ed25519', 'private-key', 'provider-token'])(
  'rejects unsafe provider route label %s',
  (route) => {
    const value = fixture();
    value.identities.personal.providerRoutes.github = route;
    expect(() => parseUserConfig(JSON.stringify(value), environment)).toThrow();
  },
);

it.each(['ssh-personal', 'github-personal', 'work-route.v2'])(
  'accepts opaque route label %s',
  (route) => {
    const value = fixture();
    value.identities.personal.sshRoute = route;
    value.identities.personal.providerRoutes.github = route;
    expect(() => parseUserConfig(JSON.stringify(value), environment)).not.toThrow();
  },
);

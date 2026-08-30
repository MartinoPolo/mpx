import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { ConfigValidationError } from './schema.js';
import { classifyCwd, classifyContentScope, resolveConfig } from './resolve.js';
import { parseUserConfig } from './user-config.js';
import type { ProjectConfig } from './types.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    realpath: async (value: string) => {
      if (value === 'C:/stale') {
        throw new Error('missing');
      }
      return value.replaceAll('\\', '/');
    },
  };
});

const project: ProjectConfig = {
  schemaVersion: 1,
  project: { id: 'acme/app' },
  repository: { provider: 'github', remote: 'origin' },
};

const text = readFileSync(
  new URL('../test/fixtures/user-launch-contracts.json', import.meta.url),
  'utf8',
);
const fixture = (): any => JSON.parse(text);
const environment = {
  MPX_PROJECTS: 'C:/projects',
  MPX_WORK: 'C:/work',
  MPX_CLONED: 'C:/cloned',
  MPX_OBSIDIAN_VAULT: 'C:/obsidian',
  MPX_AI_GENERATED: 'C:/generated',
  MPX_ONEDRIVE: 'C:/onedrive',
  HOME: 'C:/Users/me',
};

it('loads closed independent launch contracts and interpolates only documented roots', () => {
  const config = parseUserConfig(text, {
    ...environment,
    MPX_PROJECTS: 'C:/Users/me/projects',
    MPX_CLONED: 'C:/Users/me/cloned',
  });
  expect(config.identities.personal?.runtimeRoots.claude).toBe('C:/Users/me/.claude');
  expect(config.domains.personal).toEqual(['C:/Users/me/projects']);
  expect(config.presets['work-project']).toEqual(
    expect.objectContaining({
      executor: 'docker',
      workspace: 'clone',
      networkPolicy: 'implementation',
    }),
  );
  expect(() =>
    parseUserConfig(text.replace('"github-personal"', '"${MPX_PROJECTS}"'), {
      ...environment,
      MPX_PROJECTS: 'C:/projects',
    }),
  ).toThrow('Environment interpolation is not allowed');
});

it.each([
  ['secret-like property', { ...fixture(), token: 'x' }],
  [
    'secret-like route',
    {
      ...fixture(),
      identities: {
        ...fixture().identities,
        personal: { ...fixture().identities.personal, sshRoute: 'private-key' },
      },
    },
  ],
  [
    'native auth path',
    {
      ...fixture(),
      identities: {
        ...fixture().identities,
        personal: {
          ...fixture().identities.personal,
          runtimeRoots: { claude: '~/.claude', pi: '~/.pi/agent', auth: 'auth.json' },
        },
      },
    },
  ],
])('rejects %s', (_label, value) => {
  expect(() => parseUserConfig(JSON.stringify(value), environment)).toThrow();
});

it.each(['id_rsa.pub', 'id_ecdsa', 'id_ed25519_sk.pub', 'id_xmss', 'ssh.exe', 'route.pem'])(
  'rejects unsafe route label %s',
  (route) => {
    const value = fixture();
    value.identities.personal.sshRoute = route;
    expect(() => parseUserConfig(JSON.stringify(value), environment)).toThrow();
  },
);

it.each(['ssh-personal', 'github-personal'])('accepts opaque route label %s', (route) => {
  const value = fixture();
  value.identities.personal.sshRoute = route;
  expect(() => parseUserConfig(JSON.stringify(value), environment)).not.toThrow();
});

it.each([
  [
    'identity domain',
    (value: any) => {
      value.identities.personal.domain = 'missing';
    },
    '/identities/personal/domain',
  ],
  [
    'preset identity',
    (value: any) => {
      value.presets['personal-dev'].identity = 'missing';
    },
    '/presets/personal-dev/identity',
  ],
  [
    'preset mode',
    (value: any) => {
      value.presets['personal-dev'].mode = 'missing';
    },
    '/presets/personal-dev/mode',
  ],
  [
    'preset skill policy',
    (value: any) => {
      value.presets['personal-dev'].skillPolicy = 'missing';
    },
    '/presets/personal-dev/skillPolicy',
  ],
  [
    'preset content scope',
    (value: any) => {
      value.presets['personal-dev'].contentScope = 'missing';
    },
    '/presets/personal-dev/contentScope',
  ],
  [
    'preset executor',
    (value: any) => {
      value.presets['personal-dev'].executor = 'missing-executor';
    },
    '/presets/personal-dev/executor',
  ],
  [
    'preset network policy',
    (value: any) => {
      value.presets['personal-dev'].networkPolicy = 'missing-policy';
    },
    '/presets/personal-dev/networkPolicy',
  ],
  [
    'scope launch-default scope',
    (value: any) => {
      value.launchDefaults.scopes.missing = { personal: 'personal-dev' };
    },
    '/launchDefaults/scopes/missing',
  ],
  [
    'scope launch-default identity',
    (value: any) => {
      value.launchDefaults.scopes.personal.missing = 'personal-dev';
    },
    '/launchDefaults/scopes/personal/missing',
  ],
  [
    'scope launch-default preset',
    (value: any) => {
      value.launchDefaults.scopes.personal.personal = 'missing';
    },
    '/launchDefaults/scopes/personal/personal',
  ],
])('rejects dangling %s references separately', (_label, mutate, pointer) => {
  const value = fixture();
  mutate(value);
  expect(() => parseUserConfig(JSON.stringify(value), environment)).toThrowError(
    expect.objectContaining({
      code: 'CONFIG_INVALID',
      errors: expect.arrayContaining([expect.objectContaining({ instancePath: pointer })]),
    }),
  );
});

it('represents the five built-in resource matrices with symbolic resources and no CWD authority', () => {
  const value = fixture();
  value.modes = {
    project: { resources: { 'selected-project': 'read-write' } },
    developer: {
      resources: { 'identity-domain': 'read-write', 'cloned-repositories': 'read-only' },
    },
    'personal-assistant': {
      resources: { 'assistant-input': 'read-write', 'assistant-output': 'read-write' },
    },
    'computer-control': {
      resources: {
        'computer-control-config': 'read-write',
        'computer-control-executable-settings': 'staged-write',
      },
    },
    unrestricted: { resources: { host: 'read-write' } },
  };
  const config = parseUserConfig(JSON.stringify(value), environment);
  expect(config.modes).toEqual(value.modes);
  expect(JSON.stringify(config.modes)).not.toContain('cwd');
});

it('rejects unknown policy fields and malformed policy shapes', () => {
  const unknown = fixture();
  unknown.skillPolicies.clean.description = 'clean';
  expect(() => parseUserConfig(JSON.stringify(unknown), environment)).toThrow(
    ConfigValidationError,
  );
  const malformed = fixture();
  malformed.skillPolicies.clean.skillExposure = 'explicit-only';
  expect(() => parseUserConfig(JSON.stringify(malformed), environment)).toThrow(
    ConfigValidationError,
  );
});

it('defines clean as explicit-only by default', () => {
  const config = parseUserConfig(text, environment);
  expect(config.skillPolicies.clean).toEqual({ skillExposure: { default: 'explicit-only' } });
});

it('rejects a clean per-skill off override because clean cannot hide a trusted skill', () => {
  const value = fixture();
  value.skillPolicies.clean.skillExposure.skills = { review: 'off' };
  expect(() => parseUserConfig(JSON.stringify(value), environment)).toThrowError(
    /retain all selected trusted skills/u,
  );
});

it('accepts exactly the four authoritative exposure states', () => {
  const value = fixture();
  value.contentScopes.personal.skillExposure = {
    default: 'full',
    skills: { lean: 'name-only', manual: 'explicit-only', disabled: 'off' },
  };
  expect(() => parseUserConfig(JSON.stringify(value), environment)).not.toThrow();
});

it.each(['full', 'name-only', 'off'])('rejects clean %s overrides', (exposure) => {
  const value = fixture();
  value.skillPolicies.clean.skillExposure.skills = { review: exposure };
  expect(() => parseUserConfig(JSON.stringify(value), environment)).toThrowError(
    /retain all selected trusted skills/u,
  );
});

it('rejects mode and skill-policy declarations that widen their built-in policy', () => {
  const mode = fixture();
  mode.modes.project.resources.host = 'read-write';
  expect(() => parseUserConfig(JSON.stringify(mode), environment)).toThrowError(
    expect.objectContaining({ code: 'CONFIG_INVALID' }),
  );
  const policy = fixture();
  policy.skillPolicies.developer.skillPacks = ['core', 'work', 'personal'];
  expect(() => parseUserConfig(JSON.stringify(policy), environment)).toThrowError(
    expect.objectContaining({ code: 'CONFIG_INVALID' }),
  );
});

it('rejects path-bearing resource declarations', () => {
  const value = fixture();
  value.modes.project.resources = { 'C:/projects': 'read-write' };
  expect(() => parseUserConfig(JSON.stringify(value), environment)).toThrowError(
    expect.objectContaining({ code: 'CONFIG_INVALID' }),
  );
});

it.each([
  ['unsupported root token', '${MPX_UNKNOWN}', { MPX_UNKNOWN: 'C:/unknown' }],
  ['missing environment root', '${MPX_PROJECTS}', {}],
  ['interpolation in a route', '${MPX_PROJECTS}', { MPX_PROJECTS: 'C:/projects' }],
])('normalizes %s to stable CONFIG_INVALID', (label, interpolation, env) => {
  const value = fixture();
  if (label === 'interpolation in a route') {
    value.identities.personal.gitAuthorRoute = interpolation;
  } else {
    value.domains.personal[0] = interpolation;
  }
  expect(() =>
    parseUserConfig(JSON.stringify(value), {
      ...environment,
      ...env,
      ...(label === 'missing environment root' ? { MPX_PROJECTS: undefined } : {}),
    }),
  ).toThrowError(
    expect.objectContaining({ name: 'ConfigValidationError', code: 'CONFIG_INVALID' }),
  );
});

it('classifies domains independently, Windows-case-insensitively, by longest root', async () => {
  const config = parseUserConfig(text, { ...environment, MPX_PROJECTS: 'C:/Users/ME/Projects' });
  config.domains.nested = ['C:/Users/me/projects/team'];
  await expect(classifyCwd('c:/users/me/PROJECTS/team/repo', config)).resolves.toEqual({
    status: 'known',
    domain: 'nested',
    root: 'C:/Users/me/projects/team',
  });
  await expect(classifyContentScope('C:/elsewhere', config)).resolves.toEqual({
    status: 'unknown',
  });
});

it('reports unknown CWD and refuses config resolution instead of defaulting to core', async () => {
  const config = parseUserConfig(text, environment);
  await expect(classifyCwd('C:/unknown/repo', config)).resolves.toEqual({ status: 'unknown' });
  await expect(resolveConfig(project, config, 'C:/unknown/repo')).rejects.toMatchObject({
    code: 'CWD_CLASSIFICATION_UNKNOWN',
  });
});

it('accepts closed workspace strategies and named network policy declarations', () => {
  for (const workspace of ['clone', 'host-worktree', 'direct']) {
    const value = fixture();
    value.launchDefaults = { scopes: {}, projects: {} };
    value.presets['personal-dev'].workspace = workspace;
    expect(() => parseUserConfig(JSON.stringify(value), environment)).not.toThrow();
  }
  const value = fixture();
  value.presets['personal-dev'].workspace = 'bind';
  expect(() => parseUserConfig(JSON.stringify(value), environment)).toThrowError(
    expect.objectContaining({ code: 'CONFIG_INVALID' }),
  );
});

it('rejects network policy extension cycles', () => {
  const value = fixture();
  value.networkPolicies.implementation = { extends: 'delivery', approvedProjectAdditions: true };
  expect(() => parseUserConfig(JSON.stringify(value), environment)).toThrowError(/cycle/u);
});

it('requires launch-default preset identity to match its identity key', () => {
  const value = fixture();
  value.launchDefaults.scopes.personal.personal = 'work-project';
  expect(() => parseUserConfig(JSON.stringify(value), environment)).toThrowError(/identity/u);
});

it.each([
  [
    'host executor',
    (value: any) => {
      value.presets['personal-dev'].executor = 'host';
    },
  ],
  [
    'unrestricted mode',
    (value: any) => {
      value.presets['personal-dev'].mode = 'unrestricted';
    },
  ],
  [
    'direct workspace',
    (value: any) => {
      value.presets['personal-dev'].workspace = 'direct';
    },
  ],
])('rejects %s in launch defaults', (_label, mutate) => {
  const value = fixture();
  mutate(value);
  expect(() => parseUserConfig(JSON.stringify(value), environment)).toThrowError(/launch default/u);
});

it.each(['grants', 'extraMounts', 'credentials'])('rejects preset %s expansion fields', (field) => {
  const value = fixture();
  value.presets['personal-dev'][field] = [];
  expect(() => parseUserConfig(JSON.stringify(value), environment)).toThrowError(
    expect.objectContaining({ code: 'CONFIG_INVALID' }),
  );
});

it.each(['../mpx', '/absolute', 'owner//repo', 'owner/repo/extra', 'owner\\repo'])(
  'rejects unsafe launch-default project ID %s',
  (projectId) => {
    const value = fixture();
    value.launchDefaults.projects = { [projectId]: { personal: 'personal-dev' } };
    expect(() => parseUserConfig(JSON.stringify(value), environment)).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
  },
);

it('keeps identity routes out of content scope and project overrides', () => {
  const value = fixture();
  value.contentScopes.personal.connections = { github: 'work' };
  expect(() => parseUserConfig(JSON.stringify(value), environment)).toThrow();
  delete value.contentScopes.personal.connections;
  value.projects = { 'acme/app': { providerRoutes: { github: 'work' } } };
  expect(() => parseUserConfig(JSON.stringify(value), environment)).toThrow();
});

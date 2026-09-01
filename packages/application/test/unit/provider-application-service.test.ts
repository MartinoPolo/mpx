import { describe, expect, it, vi } from 'vitest';
import type { IdentityConfig, ProjectConfig } from '@mpx/config';
import { MpxError } from '@mpx/core';
import type {
  ProviderCapability,
  ProviderDescriptor,
  ProviderProbeRequest,
  ProviderProbeResult,
  ProviderRole,
} from '@mpx/providers';
import {
  createProviderApplicationService,
  type PreparedProviderInvocation,
} from '../../src/index.js';

const descriptor = (
  id: string,
  roles: readonly ProviderRole[],
  capabilities: readonly ProviderCapability[],
): ProviderDescriptor => ({
  id,
  roles,
  capabilities,
  backend: 'synthetic',
  schema: { type: 'object', properties: {}, additionalProperties: false },
});

const repositoryProvider = descriptor(
  'cobalt',
  ['repository'],
  ['review.view', 'review.ready', 'review.merge', 'ci.status'],
);
const issueProvider = descriptor('amber', ['issues'], ['issue.list']);
const descriptors = [repositoryProvider, issueProvider];
const registry = {
  list: (role?: ProviderRole) => descriptors.filter((item) => !role || item.roles.includes(role)),
  get: (id: string, role?: ProviderRole) => {
    const found = descriptors.find(
      (item) => item.id === id && (!role || item.roles.includes(role)),
    );
    if (!found) {
      throw new Error('not found');
    }
    return found;
  },
  assertCapability: (id: string, capability: string) => {
    const found = descriptors.find((item) => item.id === id);
    if (!found?.capabilities.includes(capability as ProviderCapability)) {
      throw new Error('unsupported');
    }
  },
};
const project = (policy?: 'human' | 'agent'): ProjectConfig => ({
  schemaVersion: 1,
  project: { id: 'sample' },
  repository: { provider: 'cobalt', remote: 'origin' },
  issues: { provider: 'amber' },
  ...(policy ? { workflow: { codeReview: { markReady: policy, merge: policy } } } : {}),
});
const identity: IdentityConfig = {
  domain: 'example',
  runtimeRoots: { claude: 'C:/claude', pi: 'C:/pi' },
  gitAuthorRoute: 'git',
  providerRoutes: { cobalt: 'cobalt-work', amber: 'amber-work' },
};

function setup(routeRequired = true) {
  const invoke = vi.fn(async () => ({ schemaVersion: 1, id: '42' }));
  const createProviderService = vi.fn(async () => ({ invoke }));
  const probe = vi.fn<(request: ProviderProbeRequest) => Promise<ProviderProbeResult>>(
    async () => ({ status: 'ready' }),
  );
  const routePolicy = {
    requiresRoute: vi.fn(() => routeRequired),
  };
  return {
    invoke,
    createProviderService,
    probe,
    routePolicy,
    service: createProviderApplicationService({
      registry,
      createProviderService,
      probe,
      routePolicy,
    }),
  };
}

const prepare = (
  service: ReturnType<typeof createProviderApplicationService>,
  capability: string,
  options: {
    role?: ProviderRole;
    configuredProject?: ProjectConfig;
    identityName?: string;
    configuredIdentity?: IdentityConfig;
    cwd?: string;
  } = {},
) =>
  service.prepareInvocation({
    project: options.configuredProject ?? project(),
    role: options.role ?? 'issues',
    capability,
    ...(options.identityName === undefined ? {} : { identityName: options.identityName }),
    ...(options.configuredIdentity === undefined ? {} : { identity: options.configuredIdentity }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });

describe('ProviderApplicationService', () => {
  it('prepares an opaque provider route before invoking typed input', async () => {
    const { service, createProviderService, invoke, routePolicy } = setup();
    const prepared = prepare(service, 'issue.list', {
      identityName: 'work',
      configuredIdentity: identity,
      cwd: 'C:/project',
    });

    await expect(service.invokePrepared(prepared, {})).resolves.toEqual({
      data: { schemaVersion: 1, id: '42' },
    });
    expect(routePolicy.requiresRoute).toHaveBeenCalledWith({
      providerId: 'amber',
      role: 'issues',
      capabilities: ['issue.list'],
    });
    expect(createProviderService).toHaveBeenCalledWith({
      project: project(),
      providerId: 'amber',
      capability: 'issue.list',
      cwd: 'C:/project',
    });
    expect(invoke).toHaveBeenCalledWith({
      providerId: 'amber',
      capability: 'issue.list',
      route: 'amber-work',
      input: {},
    });
  });

  it('checks capabilities during preflight before creating a provider service', () => {
    const { service, createProviderService } = setup();
    expect(() =>
      prepare(service, 'issue.move', {
        identityName: 'work',
        configuredIdentity: identity,
      }),
    ).toThrow('unsupported');
    expect(createProviderService).not.toHaveBeenCalled();
  });

  it('requires the selected identity route according to the injected neutral policy', () => {
    const { service } = setup();
    expect(() =>
      prepare(service, 'issue.list', {
        identityName: 'work',
        configuredIdentity: { ...identity, providerRoutes: {} },
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'PROVIDER_ROUTE_REQUIRED',
        message: "Identity 'work' has no route for provider 'amber'.",
      }),
    );
  });

  it('allows a policy-selected route-neutral provider without an identity', async () => {
    const { service, invoke } = setup(false);
    const prepared = prepare(service, 'issue.list');
    await service.invokePrepared(prepared, {});
    expect(invoke).toHaveBeenCalledWith({
      providerId: 'amber',
      capability: 'issue.list',
      input: {},
    });
  });

  it('prevents prepared invocation forgery and mutation from bypassing route preflight', async () => {
    const { service } = setup();
    const prepared = prepare(service, 'issue.list', {
      identityName: 'work',
      configuredIdentity: identity,
    });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(() => Reflect.set(prepared, 'route', undefined)).toThrow();
    await expect(
      service.invokePrepared(
        {
          providerId: 'amber',
          role: 'issues',
          capability: 'issue.list',
          route: undefined,
        } as unknown as PreparedProviderInvocation,
        {},
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'INVALID_PREPARED_INVOCATION',
        message: 'The prepared provider invocation is invalid.',
      }),
    );
  });

  it.each([
    ['review.ready', 'markReady', 'mark reviews ready'],
    ['review.merge', 'merge', 'merge reviews'],
  ] as const)('enforces human workflow policy for %s', (capability, _setting, wording) => {
    const { service, invoke } = setup();
    expect(() =>
      prepare(service, capability, {
        role: 'repository',
        configuredProject: project('human'),
        identityName: 'work',
        configuredIdentity: identity,
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'WORKFLOW_POLICY_DENIED',
        message: `Project workflow policy requires a human to ${wording}.`,
        capability,
      }),
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('propagates provider service errors without wrapping them', async () => {
    const failure = new Error('provider failed');
    const service = createProviderApplicationService({
      registry,
      routePolicy: { requiresRoute: () => true },
      createProviderService: async () => ({ invoke: async () => Promise.reject(failure) }),
      probe: async () => ({ status: 'unsupported' }),
    });
    const prepared = prepare(service, 'issue.list', {
      identityName: 'work',
      configuredIdentity: identity,
    });
    await expect(service.invokePrepared(prepared, {})).rejects.toBe(failure);
  });

  it('constructs list and explain results from provider-neutral registry data', () => {
    const { service } = setup();
    expect(service.list({ role: 'issues' })).toEqual({ data: [issueProvider] });
    expect(service.explain({ project: project(), role: 'repository' })).toEqual({
      data: {
        role: 'repository',
        provider: 'cobalt',
        adapter: 'synthetic',
        capabilities: ['review.view', 'review.ready', 'review.merge', 'ci.status'],
        route: null,
        routeSelection: 'identity-required',
      },
    });
  });

  it('validates the explicit doctor identity before provider selection', async () => {
    const { service, probe } = setup();
    await expect(service.doctor({ project: project() })).rejects.toEqual(
      expect.objectContaining({
        code: 'IDENTITY_REQUIRED',
        message: 'Provider doctor requires an explicit identity.',
      }),
    );
    expect(probe).not.toHaveBeenCalled();
  });

  it('constructs doctor results in role order and reports probe failures through the exit code', async () => {
    const { service, probe } = setup();
    probe.mockResolvedValueOnce({
      status: 'error',
      error: { code: 'AUTH_FAILURE', message: 'Authentication failed.', retryable: false },
    });
    const result = await service.doctor({
      project: project(),
      identityName: 'work',
      identity,
      cwd: 'C:/project',
    });
    expect(
      result.data.providers.map(({ role, provider, status }) => ({ role, provider, status })),
    ).toEqual([
      { role: 'issues', provider: 'amber', status: 'error' },
      { role: 'repository', provider: 'cobalt', status: 'ready' },
    ]);
    expect(result.exitCode).toBe(1);
  });

  it('throws shared core errors for application validation failures', () => {
    const { service } = setup();
    expect(() => prepare(service, 'issue.list')).toThrow(MpxError);
  });
});

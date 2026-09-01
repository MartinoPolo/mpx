import { describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@mpx/config';
import {
  createNodeProviderService,
  type NodeProviderInvoker,
} from '../../src/node/provider-application-service.js';

const project: ProjectConfig = {
  schemaVersion: 1,
  project: { id: 'sample' },
  repository: { provider: 'github', remote: 'origin' },
  issues: { provider: 'github' },
};

describe('Node provider composition', () => {
  it('short-circuits all concrete composition when a provider service is injected', async () => {
    const injected: NodeProviderInvoker = { invoke: vi.fn(async () => 'injected') };
    const resolver = { resolve: vi.fn(async () => 'example/acme/project') };

    const service = await createNodeProviderService(
      {
        env: {},
        providerService: injected,
        repositorySelectorResolver: resolver,
        providerProcessExecutor: { execute: vi.fn() },
      },
      project,
      'C:/operation',
      { providerId: 'github', capability: 'issue.list' },
    );

    expect(service).toBe(injected);
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('prefers injected process and repository adapters during concrete composition', async () => {
    const executor = { execute: vi.fn() };
    const resolver = { resolve: vi.fn(async () => 'example/acme/project') };

    await createNodeProviderService(
      {
        env: {},
        providerProcessExecutor: executor,
        repositorySelectorResolver: resolver,
      },
      project,
      'C:/operation',
      { providerId: 'github', capability: 'issue.list' },
    );

    expect(resolver.resolve).toHaveBeenCalledWith({ root: 'C:/operation', remote: 'origin' });
    expect(executor.execute).not.toHaveBeenCalled();
  });
});

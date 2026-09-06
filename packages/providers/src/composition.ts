import type { JsonValue } from '@mpx/core';
import type { ProviderCapabilityInputMap, ProviderCapabilityOutputMap } from './contracts.js';
import type { ProviderProcessExecutor } from './process.js';
import { providerRegistry, type ProviderCapability } from './registry.js';
import { ProviderService, type ProviderAdapter } from './service.js';
import { createGitHubAdapters, type GitHubAdapterOptions } from './adapters/github.js';
import { createGitLabAdapters, type GitLabAdapterOptions } from './adapters/gitlab.js';
import { createGerritAdapter, type GerritAdapterOptions } from './adapters/gerrit.js';
import { createKanbanFlowAdapter, type KanbanFlowAdapterOptions } from './adapters/kanbanflow.js';
import { createLocalIssueAdapter, type LocalIssue } from './adapters/local.js';

export type BuiltinProviderId = 'github' | 'gitlab' | 'gerrit' | 'kanbanflow' | 'local';

export interface BuiltinProviderOptions {
  readonly providerId?: string;
  readonly cwd?: string;
  readonly repository?: string;
  readonly remote?: string;
  readonly github?: Omit<GitHubAdapterOptions, 'cwd' | 'repository'>;
  readonly gitlab?: Omit<GitLabAdapterOptions, 'cwd' | 'repository'>;
  readonly gerrit?: Omit<GerritAdapterOptions, 'cwd' | 'repository' | 'remote'>;
  readonly kanbanflow?: Omit<KanbanFlowAdapterOptions, 'cwd'>;
  readonly local?: Readonly<{
    root: string;
    staleLockMilliseconds?: number;
    projectId?: string;
    onChanged?: (issue: LocalIssue) => Promise<void>;
  }>;
}

/** Creates MPX's fixed built-in adapters. Configuration can select, but never extend, this set. */
function createBuiltinProviderAdapters(
  executor: ProviderProcessExecutor,
  options: BuiltinProviderOptions = {},
): readonly ProviderAdapter[] {
  const selected = options.providerId;
  return Object.freeze([
    ...(selected === undefined || selected === 'github'
      ? createGitHubAdapters(executor, {
          ...options.github,
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.repository === undefined ? {} : { repository: options.repository }),
        })
      : []),
    ...(selected === undefined || selected === 'gitlab'
      ? createGitLabAdapters(executor, {
          ...options.gitlab,
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.repository === undefined ? {} : { repository: options.repository }),
        })
      : []),
    ...(selected === 'gerrit' && options.repository !== undefined && options.remote !== undefined
      ? [
          createGerritAdapter(executor, {
            ...options.gerrit,
            repository: options.repository,
            remote: options.remote,
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          }),
        ]
      : []),
    ...(selected === undefined || selected === 'kanbanflow'
      ? [
          createKanbanFlowAdapter(executor, {
            ...options.kanbanflow,
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          }),
        ]
      : []),
    ...(selected === 'local' && options.local ? [createLocalIssueAdapter(options.local)] : []),
  ]);
}

/** Public façade over MPX's canonical registry and fixed built-in adapter set. */
export interface BuiltinProviderService {
  invoke<Capability extends ProviderCapability>(request: {
    providerId: string;
    capability: Capability;
    route?: string;
    input: ProviderCapabilityInputMap[Capability];
  }): Promise<ProviderCapabilityOutputMap[Capability]>;
  invoke(request: {
    providerId: string;
    capability: string;
    route?: string;
    input: JsonValue;
  }): Promise<unknown>;
}

/** Composes only MPX's canonical built-in providers around the trusted process executor port. */
export function createBuiltinProviderService(
  executor: ProviderProcessExecutor,
  options: BuiltinProviderOptions = {},
): BuiltinProviderService {
  return new ProviderService(providerRegistry, createBuiltinProviderAdapters(executor, options));
}

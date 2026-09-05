import type { ProviderAdapter } from './service.js';
import type { ProviderProcessExecutor } from './process.js';
import { createGitHubAdapters, type GitHubAdapterOptions } from './adapters/github.js';
import { createGitLabAdapters, type GitLabAdapterOptions } from './adapters/gitlab.js';
import { createGerritAdapter, type GerritAdapterOptions } from './adapters/gerrit.js';
import { createKanbanFlowAdapter, type KanbanFlowAdapterOptions } from './adapters/kanbanflow.js';
import { createLocalIssueAdapter, type LocalIssue } from './adapters/local.js';

export type BuiltinProviderId = 'github' | 'gitlab' | 'gerrit' | 'kanbanflow' | 'local';

export interface BuiltinProviderAdapterOptions {
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
export function createBuiltinProviderAdapters(
  executor: ProviderProcessExecutor,
  options: BuiltinProviderAdapterOptions = {},
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

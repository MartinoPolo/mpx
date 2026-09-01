import path from 'node:path';
import { loadUserConfig, type ProjectConfig } from '@mpx/config';
import { MpxError, type JsonValue } from '@mpx/core';
import { createGitHubAdapters } from '@mpx/provider-github';
import { createGitLabAdapters } from '@mpx/provider-gitlab';
import { createKanbanFlowAdapter } from '@mpx/provider-kanbanflow';
import { createLocalIssueAdapter } from '@mpx/provider-local';
import {
  BUILTIN_PROVIDERS,
  ProviderRegistry,
  ProviderService,
  probeProvider,
  providerRegistry,
  type ProviderAdapter,
  type ProviderDescriptor,
  type ProviderProcessExecutor,
} from '@mpx/providers';
import { createProviderApplicationService } from '../provider-application-service.js';
import { createNodeLocalIssueViewRebuilder } from './local-issue-view-rebuilder.js';
import {
  NodeProviderProcessExecutor,
  NodeRepositorySelectorResolver,
} from './provider-process-adapters.js';

export interface NodeProviderInvoker {
  invoke(request: {
    providerId: string;
    capability: string;
    route?: string;
    input: JsonValue;
  }): Promise<unknown>;
}

export interface NodeRepositorySelector {
  resolve(request: { root: string; remote: string }): Promise<string>;
}

/** Structural composition inputs; deliberately independent of the CLI context. */
export interface NodeProviderCompositionDependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly providerService?: NodeProviderInvoker;
  readonly providerProcessExecutor?: ProviderProcessExecutor;
  readonly repositorySelectorResolver?: NodeRepositorySelector;
  readonly trustedProviderComposition?: Readonly<{
    descriptors: readonly ProviderDescriptor[];
    adapters: readonly ProviderAdapter[];
  }>;
}

function configuredProviderRegistry(
  dependencies: NodeProviderCompositionDependencies,
): ProviderRegistry {
  const extensions = dependencies.trustedProviderComposition?.descriptors ?? [];
  return extensions.length === 0
    ? providerRegistry
    : new ProviderRegistry([...BUILTIN_PROVIDERS, ...extensions], extensions);
}

export async function createNodeProviderService(
  dependencies: NodeProviderCompositionDependencies,
  config: ProjectConfig,
  cwd: string,
  selection?: { providerId: string; capability: string },
): Promise<NodeProviderInvoker> {
  if (dependencies.providerService) {
    return dependencies.providerService;
  }
  const executor =
    dependencies.providerProcessExecutor ?? new NodeProviderProcessExecutor(dependencies.env);
  const selectedProvider = selection?.providerId;
  const needsForgeRepository =
    selectedProvider === undefined ||
    selectedProvider === 'github' ||
    selectedProvider === 'gitlab';
  const repository = needsForgeRepository
    ? await (
        dependencies.repositorySelectorResolver ??
        new NodeRepositorySelectorResolver(dependencies.env)
      ).resolve({ root: cwd, remote: config.repository.remote })
    : undefined;

  let localRoot: string | undefined;
  let localOnChanged: (() => Promise<void>) | undefined;
  if (selectedProvider === 'local' && config.issues?.provider === 'local') {
    const appdata = dependencies.env.APPDATA;
    if (!appdata || !path.isAbsolute(appdata)) {
      throw new MpxError({
        code: 'LOCAL_ISSUE_STORE_UNAVAILABLE',
        message: 'Local issues require identity-local user configuration.',
      });
    }
    const user = await loadUserConfig(path.join(appdata, 'mpx', 'config.json'), dependencies.env);
    localRoot = user.localIssueStores?.[config.issues.store ?? '']?.root;
    if (!localRoot) {
      throw new MpxError({
        code: 'LOCAL_ISSUE_STORE_UNAVAILABLE',
        message: 'The selected logical local issue store is not registered in user configuration.',
      });
    }
    if (config.issues.view) {
      const view = user.localViews?.[config.issues.view];
      if (!view) {
        throw new MpxError({
          code: 'LOCAL_VIEW_UNAVAILABLE',
          message: 'The selected logical local view is not registered in user configuration.',
        });
      }
      localOnChanged = async () => {
        await createNodeLocalIssueViewRebuilder().rebuild({
          storeRoot: localRoot!,
          projectId: config.project.id,
          view: {
            vaultRoot: view.vaultRoot,
            outputRoot: view.outputRoot,
            resumeBaseUrl: view.resumeBaseUrl,
          },
        });
      };
    }
  }

  const adapters = [
    ...(selectedProvider === undefined || selectedProvider === 'github'
      ? createGitHubAdapters(executor, { cwd, ...(repository === undefined ? {} : { repository }) })
      : []),
    ...(selectedProvider === undefined || selectedProvider === 'gitlab'
      ? createGitLabAdapters(executor, { cwd, ...(repository === undefined ? {} : { repository }) })
      : []),
    ...(selectedProvider === undefined || selectedProvider === 'kanbanflow'
      ? [
          createKanbanFlowAdapter(executor, {
            cwd,
            ...(config.issues?.provider === 'kanbanflow' && config.issues.states !== undefined
              ? { states: config.issues.states }
              : {}),
          }),
        ]
      : []),
    ...(selectedProvider === 'local' && localRoot
      ? [
          createLocalIssueAdapter({
            root: localRoot,
            projectId: config.project.id,
            ...(localOnChanged ? { onChanged: async () => localOnChanged() } : {}),
          }),
        ]
      : []),
    ...(dependencies.trustedProviderComposition?.adapters.filter(
      (adapter) => selectedProvider === undefined || adapter.providerId === selectedProvider,
    ) ?? []),
  ];
  return new ProviderService(configuredProviderRegistry(dependencies), adapters);
}

export function createNodeConfiguredProviderApplicationService(
  dependencies: NodeProviderCompositionDependencies,
) {
  const executor =
    dependencies.providerProcessExecutor ?? new NodeProviderProcessExecutor(dependencies.env);
  return createProviderApplicationService({
    registry: configuredProviderRegistry(dependencies),
    routePolicy: {
      requiresRoute: ({ providerId, capabilities }) =>
        providerId !== 'local' && capabilities.length > 0,
    },
    createProviderService: async ({ project, providerId, capability, cwd }) => {
      const service = await createNodeProviderService(dependencies, project, cwd ?? process.cwd(), {
        providerId,
        capability,
      });
      return { invoke: (request) => service.invoke(request) };
    },
    probe: (request) => probeProvider(request, executor),
  });
}

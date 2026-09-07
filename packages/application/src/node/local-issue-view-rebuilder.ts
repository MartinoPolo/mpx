import type { ProjectConfig, UserConfig } from '@mpx/config';
import { MpxError } from '@mpx/core';
import { LocalIssueStore, rebuildObsidianIssueViews } from './local-issue-store.js';

export interface NodeLocalIssueViewRebuilder {
  rebuild(request: {
    readonly storeRoot: string;
    readonly projectId: string;
    readonly view: {
      readonly vaultRoot: string;
      readonly outputRoot: string;
      readonly resumeBaseUrl: string;
    };
  }): Promise<unknown>;
}

interface LocalIssueViewRebuilderDependencies {
  readonly createStore: (root: string, options: { projectId: string }) => unknown;
  readonly rebuildViews: (
    store: unknown,
    options: {
      vaultRoot: string;
      outputRoot: string;
      projectId: string;
      resumeBaseUrl: string;
    },
  ) => Promise<unknown>;
}

const productionDependencies: LocalIssueViewRebuilderDependencies = {
  createStore: (root, options) => new LocalIssueStore(root, options),
  rebuildViews: (store, options) => rebuildObsidianIssueViews(store as LocalIssueStore, options),
};

/** Concrete local-provider structural adapter; exported only from @mpx/application/node. */
export function createNodeLocalIssueViewRebuilder(
  dependencies: LocalIssueViewRebuilderDependencies = productionDependencies,
): NodeLocalIssueViewRebuilder {
  return {
    rebuild(request) {
      const store = dependencies.createStore(request.storeRoot, {
        projectId: request.projectId,
      });
      return dependencies.rebuildViews(store, {
        ...request.view,
        projectId: request.projectId,
      });
    },
  };
}

export function createConfiguredNodeLocalIssueStore(options: {
  readonly project: ProjectConfig;
  readonly user: UserConfig;
}): LocalIssueStore {
  const issues = options.project.issues;
  if (issues?.provider !== 'local' || !issues.store) {
    throw new MpxError({
      code: 'LOCAL_ISSUE_CONFIG_INVALID',
      message: 'The project must select the local provider and a registered logical store.',
    });
  }
  const registration = options.user.localIssueStores?.[issues.store];
  if (!registration) {
    throw new MpxError({
      code: 'LOCAL_ISSUE_STORE_NOT_FOUND',
      message: `Local issue store '${issues.store}' is not registered in user configuration.`,
    });
  }
  const view = issues.view === undefined ? undefined : options.user.localViews?.[issues.view];
  if (issues.view !== undefined && !view) {
    throw new MpxError({
      code: 'LOCAL_ISSUE_VIEW_NOT_FOUND',
      message: `Local issue view '${issues.view}' is not registered in user configuration.`,
    });
  }
  const rebuilder = createNodeLocalIssueViewRebuilder();
  const store = new LocalIssueStore(registration.root, {
    projectId: options.project.project.id,
    ...(view
      ? {
          onChanged: async () => {
            await rebuilder.rebuild({
              storeRoot: registration.root,
              projectId: options.project.project.id,
              view: {
                vaultRoot: view.vaultRoot,
                outputRoot: view.outputRoot,
                resumeBaseUrl: view.resumeBaseUrl,
              },
            });
          },
        }
      : {}),
  });
  return store;
}

import { LocalIssueStore, rebuildObsidianIssueViews } from '@mpx/providers';
import type { LocalIssueViewRebuilder } from '../project-application-service.js';

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
): LocalIssueViewRebuilder {
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

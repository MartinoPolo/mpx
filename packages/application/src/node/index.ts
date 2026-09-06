import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { discoverProjectConfig } from '@mpx/config';
import { MpxError, sha256Canonical, type JsonValue } from '@mpx/core';
import {
  DurableDevServiceManager,
  createSystemRuntime,
  type ExecutorKind,
} from '@mpx/dev-services';
import { PortService, RealGitWorktreeAdapter, RegistryStore } from '@mpx/ports';
import { createStatusProvider } from '@mpx/status';
import { WindowsPortPlatformAdapter, WindowsProcessCapabilities } from '@mpx/windows';
import {
  createNodeWorktreeIncludeDependencies,
  resolveTrustedExecutable,
  type FileSystemAdapter,
} from '@mpx/worktrees';
import {
  LifecycleApplicationService,
  type LifecycleApplicationDependencies,
  type LifecycleDevService,
} from '../lifecycle-application-service.js';
import {
  WorkspaceApplicationService,
  type WorkspaceApplicationDependencies,
} from '../workspace-application-service.js';
import { preparationRuntime, windowsProcessIdentityInspector } from './preparation-lifecycle.js';
import { createNodeWorktreeLifecycleService } from './worktree-lifecycle.js';

export * from './account-application-service.js';
export * from './local-issue-view-rebuilder.js';
export * from './pi-auth-availability.js';
export * from './preparation-worker-polling.js';
export * from './preparation-lifecycle.js';
export * from './preparation-status.js';
export * from './worktree-lifecycle.js';
export * from './session-application-service.js';
export * from './sbx-execution.js';
export * from './session-docker-resume.js';
export * from './setup-application-service.js';

/** Concrete Node process/state adapter; kept out of the provider-neutral package root. */
export function createNodeDevService(
  environment: NodeJS.ProcessEnv,
  projectRoot: string,
): LifecycleDevService {
  const executor = runtimeExecutor(environment);
  if (executor !== 'host') {
    throw new MpxError({
      code: 'DEV_EXECUTOR_UNSUPPORTED',
      message: 'Docker development services require an injected Docker service manager.',
    });
  }
  const local = environment.LOCALAPPDATA;
  if (!local || !path.isAbsolute(local)) {
    throw new Error('LOCALAPPDATA is required for durable development-service state.');
  }
  const scope = sha256Canonical({
    projectRoot: canonicalNodeWorkspacePath(projectRoot, process.platform),
  } as JsonValue);
  const manager = new DurableDevServiceManager(
    createSystemRuntime(),
    path.join(local, 'mpx', 'dev-services', scope),
  );
  return Object.assign(manager, { runtimeKind: 'host' as const });
}

function runtimeExecutor(environment: NodeJS.ProcessEnv): ExecutorKind {
  if (environment.MPX_RUNTIME_CONTEXT === undefined) {
    return 'host';
  }
  const selected = environment.MPX_RUNTIME_EXECUTOR;
  if (selected !== 'host' && selected !== 'docker') {
    throw new MpxError({
      code: 'DEV_EXECUTOR_UNSUPPORTED',
      message: 'MPX_RUNTIME_EXECUTOR must be exactly host or docker.',
    });
  }
  return selected;
}

function canonicalNodeWorkspacePath(value: string, platform: NodeJS.Platform): string {
  const implementation = platform === 'win32' ? path.win32 : path.posix;
  const canonical = implementation.resolve(value).replaceAll('\\', '/').replace(/\/$/u, '');
  return platform === 'win32' ? canonical.toLowerCase() : canonical;
}

export function createNodeWorkspacePathAdapter(platform: NodeJS.Platform = process.platform) {
  const implementation = platform === 'win32' ? path.win32 : path.posix;
  const canonical = (value: string) => canonicalNodeWorkspacePath(value, platform);
  return {
    resolve: (...parts: string[]) => implementation.resolve(...parts),
    equals: (left: string, right: string) => canonical(left) === canonical(right),
    contains(root: string, candidate: string) {
      const base = canonical(root),
        selected = canonical(candidate);
      return selected === base || selected.startsWith(`${base}/`);
    },
  };
}

export interface NodeWorkspaceApplicationOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly stateRoot: string;
  readonly cwd: string;
  readonly preparationWorkerEntry: string;
  readonly dockerServices?: WorkspaceApplicationDependencies['services'];
}

/** Production Node composition for the complete workspace facade. */
export function createNodeWorkspaceApplicationService(
  options: NodeWorkspaceApplicationOptions,
): WorkspaceApplicationService {
  const executor = runtimeExecutor(options.environment);
  if (!path.isAbsolute(options.stateRoot) || !path.isAbsolute(options.cwd)) {
    throw new MpxError({
      code: 'WORKSPACE_NODE_BINDING_INVALID',
      message: 'Workspace state and caller roots must be absolute.',
    });
  }
  if (executor === 'docker' && !options.dockerServices) {
    throw new MpxError({
      code: 'DEV_EXECUTOR_UNSUPPORTED',
      message: 'Docker development services require an injected Docker service manager.',
    });
  }
  const portService = new PortService({
    store: new RegistryStore(options.stateRoot),
    git: new RealGitWorktreeAdapter(),
    platform: new WindowsPortPlatformAdapter(),
  });
  const fileSystem: FileSystemAdapter = {
    realpath,
    readText: (file) => readFile(file, 'utf8'),
    writeText: (file, content) => writeFile(file, content, 'utf8'),
    mkdir: (directory) => mkdir(directory, { recursive: true }).then(() => undefined),
    exists: async (value) => {
      try {
        await access(value);
        return true;
      } catch {
        return false;
      }
    },
  };
  const worktrees = createNodeWorktreeLifecycleService({
    stateRoot: options.stateRoot,
    operationCwd: options.cwd,
    ports: portService,
    preparation: preparationRuntime(
      options.stateRoot,
      options.environment,
      options.preparationWorkerEntry,
    ),
    includes: createNodeWorktreeIncludeDependencies(),
    fileSystem,
    processIdentityInspector: windowsProcessIdentityInspector(new WindowsProcessCapabilities()),
  });
  const workspacePath = createNodeWorkspacePathAdapter();
  const hostManagers = new Map<
    string,
    WorkspaceApplicationDependencies['services'] extends {
      forWorkspace(root: string): infer T;
    }
      ? Awaited<T>
      : never
  >();
  const services: WorkspaceApplicationDependencies['services'] =
    executor === 'docker'
      ? options.dockerServices!
      : {
          forWorkspace(root) {
            const key = canonicalNodeWorkspacePath(root, process.platform);
            let manager = hostManagers.get(key);
            if (!manager) {
              manager = createNodeDevService(options.environment, root) as never;
              hostManagers.set(key, manager);
            }
            return manager;
          },
        };
  return new WorkspaceApplicationService({
    executor,
    async resolvePackageInvocation(manager, cwd) {
      const command = manager === 'auto' ? 'npm' : manager;
      if (executor === 'docker') {
        return { executable: command, prefixArguments: [] };
      }
      const resolved = await resolveTrustedExecutable(command, cwd);
      return {
        executable: resolved.path,
        prefixArguments: resolved.trustedPrefixArguments,
        trustedAbsoluteExecutable: true,
      };
    },
    worktrees,
    ports: portService,
    projects: {
      async discover(cwd) {
        const found = await discoverProjectConfig(cwd);
        if (!found) {
          throw new MpxError({ code: 'PROJECT_NOT_FOUND', message: 'No MPX project was found.' });
        }
        return found;
      },
    },
    status: createStatusProvider({ portService }),
    services,
    path: workspacePath,
  });
}

/** Wires concrete Node path semantics to application-owned lifecycle orchestration. */
export function createNodeLifecycleApplicationService(
  dependencies: Omit<LifecycleApplicationDependencies, 'path'>,
): LifecycleApplicationService {
  return new LifecycleApplicationService({ ...dependencies, path: { resolve: path.resolve } });
}
export * from './launch-execution-adapters.js';
export * from './launch-execution-runtime.js';
export * from './launch-execution.js';
export * from './launch-production.js';
export * from './claude-gateway.js';
export * from './provider-process-adapters.js';
export * from './provider-application-service.js';
export * from './private-route-materializer.js';
export * from './session-lifecycle-bridge.js';
export * from './session-production-adapters.js';
export * from './session-resume-launch.js';

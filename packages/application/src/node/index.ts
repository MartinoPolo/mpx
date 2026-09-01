import path from 'node:path';
import { sha256Canonical, type JsonValue } from '@mpx/core';
import { DurableDevServiceManager, createSystemRuntime } from '@mpx/dev-services';
import {
  LifecycleApplicationService,
  type LifecycleApplicationDependencies,
  type LifecycleDevService,
} from '../lifecycle-application-service.js';

export * from './account-application-service.js';
export * from './pi-auth-availability.js';
export * from './preparation-worker-polling.js';
export * from './preparation-lifecycle.js';
export * from './preparation-status.js';
export * from './worktree-lifecycle.js';
export * from './session-legacy-import.js';
export * from './session-application-service.js';

/** Concrete Node process/state adapter; kept out of the provider-neutral package root. */
export function createNodeDevService(
  environment: NodeJS.ProcessEnv,
  projectRoot: string,
): LifecycleDevService {
  const local = environment.LOCALAPPDATA;
  if (!local || !path.isAbsolute(local)) {
    throw new Error('LOCALAPPDATA is required for durable development-service state.');
  }
  const scope = sha256Canonical({
    projectRoot: path.resolve(projectRoot).replaceAll('\\', '/').toLowerCase(),
  } as JsonValue);
  const manager = new DurableDevServiceManager(
    createSystemRuntime(),
    path.join(local, 'mpx', 'dev-services', scope),
  );
  return Object.assign(manager, { runtimeKind: 'host' as const });
}

/** Wires concrete Node path semantics to application-owned lifecycle orchestration. */
export function createNodeLifecycleApplicationService(
  dependencies: Omit<LifecycleApplicationDependencies, 'path'>,
): LifecycleApplicationService {
  return new LifecycleApplicationService({ ...dependencies, path: { resolve: path.resolve } });
}
export * from './launch-execution-adapters.js';

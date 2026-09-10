import {
  SessionService,
  verifyNativeResumeSeed,
  projectSessionResurrectionRecord,
  verifyResumeConfirmation,
  type SessionProcessInspector,
  type SessionStore,
} from '@mpx/sessions';
import {
  SessionApplicationService,
  type SessionApplicationDependencies,
} from '../session-application-service.js';

export interface NodeSessionApplicationDependencies extends Omit<
  SessionApplicationDependencies,
  | 'sessions'
  | 'nativeBindings'
  | 'projectResurrectionRecord'
  | 'planResume'
  | 'verifyResumeConfirmation'
> {
  readonly store: SessionStore;
  readonly processInspector?: SessionProcessInspector;
  readonly sessionService?: SessionService;
}

/** Wires the Node-backed session domain and durable store to neutral application ports. */
export function createNodeSessionApplicationService(
  dependencies: NodeSessionApplicationDependencies,
): SessionApplicationService {
  const { store, processInspector, sessionService, ...applicationDependencies } = dependencies;
  const sessions = sessionService ?? new SessionService(store, undefined, processInspector);
  return new SessionApplicationService({
    ...applicationDependencies,
    sessions,
    nativeBindings: store,
    projectResurrectionRecord: projectSessionResurrectionRecord,
    planResume: (record, resumeDependencies) =>
      verifyNativeResumeSeed(store, record, resumeDependencies),
    verifyResumeConfirmation,
  });
}

import {
  LifecycleEventDirectoryConsumer,
  SessionService,
  verifyNativeResumeSeed,
  projectSessionResurrectionRecordV1,
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
  | 'consumePending'
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
  const consumer = new LifecycleEventDirectoryConsumer(store, sessions);
  return new SessionApplicationService({
    ...applicationDependencies,
    sessions,
    nativeBindings: store,
    consumePending: async (scope) => {
      let consumed = 0;
      for (const bindingId of await store.listLifecycleBindingIds()) {
        consumed += await consumer.consume(bindingId, scope);
      }
      return consumed;
    },
    projectResurrectionRecord: projectSessionResurrectionRecordV1,
    planResume: (record, resumeDependencies) =>
      verifyNativeResumeSeed(store, record, resumeDependencies),
    verifyResumeConfirmation,
  });
}

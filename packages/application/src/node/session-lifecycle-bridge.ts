import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { canonicalNativeRootDigest, type LaunchDescriptor } from '@mpx/launch';
import {
  createRuntimeSessionObservation,
  createSessionLifecycleBinding,
  type NativeSessionRef,
  type RuntimeContext,
  type RuntimeSessionObservation,
  type SessionLifecycleBinding,
} from '@mpx/runtime-contracts';
import {
  LifecycleEventDirectoryConsumer,
  SessionError,
  SessionService,
  SessionStore,
  deriveNativeBindingRef,
  type NativeBindingRecord,
  type SessionProcessInspector,
} from '@mpx/sessions';
import { WindowsProcessCapabilities } from '@mpx/windows';
import { windowsProcessIdentityInspector } from './preparation-lifecycle.js';

export interface LaunchLifecyclePreparation {
  readonly binding: SessionLifecycleBinding;
  readonly eventDirectory: string;
}
export interface SessionLifecycleBridge {
  prepare(input: {
    descriptor: LaunchDescriptor;
    runtimeContext: RuntimeContext;
    nativeRuntimeRoot: string;
    cwd: string;
    nativeSessionRef?: NativeSessionRef;
    nativeBinding?: NativeBindingRecord;
  }): Promise<LaunchLifecyclePreparation>;
  consume(bindingId: string): Promise<void>;
  /** Consumes durable events and returns the observation bound to this launch only. */
  observe(bindingId: string): Promise<RuntimeSessionObservation | undefined>;
}
export function productionSessionProcessInspector(): SessionProcessInspector {
  return windowsProcessIdentityInspector(new WindowsProcessCapabilities());
}

export class ProductionSessionLifecycleBridge implements SessionLifecycleBridge {
  private readonly store: SessionStore;
  private readonly onSessionsChanged: (() => Promise<void>) | undefined;
  private readonly processInspector: SessionProcessInspector;

  constructor(input: {
    store: SessionStore;
    onSessionsChanged?: () => Promise<void>;
    processInspector?: SessionProcessInspector;
  }) {
    this.store = input.store;
    this.onSessionsChanged = input.onSessionsChanged;
    this.processInspector = input.processInspector ?? productionSessionProcessInspector();
  }
  async prepare(input: {
    descriptor: LaunchDescriptor;
    runtimeContext: RuntimeContext;
    nativeRuntimeRoot: string;
    cwd: string;
    nativeSessionRef?: NativeSessionRef;
    nativeBinding?: NativeBindingRecord;
  }): Promise<LaunchLifecyclePreparation> {
    const now = new Date().toISOString(),
      bindingId = randomUUID();
    const rootDigest = canonicalNativeRootDigest(input.nativeRuntimeRoot);
    const generatedRef = deriveNativeBindingRef(
      input.descriptor.identity,
      input.descriptor.runtime,
      rootDigest,
    );
    const matchingBindings = input.nativeBinding
      ? []
      : (await this.store.listNativeBindings()).filter(
          (binding) =>
            binding.identity.domain === input.descriptor.identity.domain &&
            binding.identity.name === input.descriptor.identity.name &&
            binding.runtime === input.descriptor.runtime &&
            binding.recordedRootDigest === rootDigest,
        );
    if (matchingBindings.length > 1) {
      throw new SessionError(
        'SESSION_NATIVE_BINDING_DUPLICATE',
        'Multiple native bindings claim the exact launch identity, runtime, and root.',
      );
    }
    const nativeBindingRef = input.nativeBinding?.ref ?? matchingBindings[0]?.ref ?? generatedRef;
    if (input.nativeBinding) {
      const persisted = await this.store.readNativeBinding(input.nativeBinding.ref);
      if (
        JSON.stringify(persisted) !== JSON.stringify(input.nativeBinding) ||
        persisted.ref !== generatedRef ||
        persisted.recordedRootDigest !== rootDigest ||
        persisted.runtime !== input.descriptor.runtime ||
        persisted.identity.domain !== input.descriptor.identity.domain ||
        persisted.identity.name !== input.descriptor.identity.name
      ) {
        throw new SessionError(
          'SESSION_RESUME_BINDING_MISMATCH',
          'The supplied native binding does not match the exact launch identity, runtime, and root.',
        );
      }
    } else {
      const existing =
        matchingBindings[0] ??
        (await this.store.listNativeBindings()).find((binding) => binding.ref === generatedRef);
      if (existing) {
        if (
          existing.ref !== generatedRef ||
          existing.recordedRootDigest !== rootDigest ||
          existing.runtime !== input.descriptor.runtime ||
          existing.identity.domain !== input.descriptor.identity.domain ||
          existing.identity.name !== input.descriptor.identity.name
        ) {
          throw new SessionError(
            'SESSION_BINDING_MISMATCH',
            'The native binding reference is inconsistent.',
          );
        }
      } else {
        await this.store.saveNativeBinding({
          schemaVersion: 1,
          ref: nativeBindingRef,
          identity: {
            domain: input.descriptor.identity.domain,
            name: input.descriptor.identity.name,
          },
          runtime: input.descriptor.runtime,
          recordedRootDigest: rootDigest,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    const binding = createSessionLifecycleBinding({
      bindingId,
      bindingRef: `lifecycle-${bindingId}`,
      runtime: input.descriptor.runtime,
      identityRef: `${input.descriptor.identity.domain}:${input.descriptor.identity.name}`,
      launchKey: input.descriptor.launchKey,
      launchDescriptorDigest: input.runtimeContext.launchDescriptor.digest,
      artifactKey: input.runtimeContext.runtimeArtifact.artifactKey,
      manifestKey: input.runtimeContext.manifestKey,
      projectRef: input.descriptor.binding.projectId ?? 'unbound',
      repositoryRef: input.descriptor.binding.repositoryId,
      worktreeRef: input.cwd,
      createdAt: now,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
    await this.store.saveLifecycleBinding({
      schemaVersion: 2,
      binding,
      nativeBindingRef,
      nativeSessionRef: input.nativeSessionRef ?? null,
      launch: {
        launchKey: input.descriptor.launchKey,
        descriptorDigest: input.runtimeContext.launchDescriptor.digest,
        mode: input.descriptor.mode,
        selection: structuredClone(input.descriptor.selection),
        executor: { kind: input.descriptor.executor.name },
        workspace: input.descriptor.workspace,
        networkPolicy: input.descriptor.networkPolicy.name,
        artifactKey: input.runtimeContext.runtimeArtifact.artifactKey,
        manifestKey: input.runtimeContext.manifestKey,
      },
      location: {
        cwd: input.cwd,
        project: input.descriptor.binding.projectId,
        repository: input.descriptor.binding.repositoryId,
        worktree: null,
      },
    });
    const eventDirectory = this.store.eventDirectory(bindingId);
    await mkdir(eventDirectory, { recursive: true });
    const stat = await lstat(eventDirectory);
    const resolvedDirectory = await realpath(eventDirectory),
      expectedDirectory = path.resolve(eventDirectory);
    const samePath =
      process.platform === 'win32'
        ? resolvedDirectory.replaceAll('\\', '/').toLowerCase() ===
          expectedDirectory.replaceAll('\\', '/').toLowerCase()
        : resolvedDirectory === expectedDirectory;
    if (stat.isSymbolicLink() || !stat.isDirectory() || !samePath) {
      throw new Error('Unsafe lifecycle event directory');
    }
    return { binding, eventDirectory };
  }
  async consume(bindingId: string): Promise<void> {
    const consumed = await new LifecycleEventDirectoryConsumer(
      this.store,
      new SessionService(this.store, undefined, this.processInspector),
    ).consume(bindingId);
    if (consumed > 0) {
      await this.onSessionsChanged?.();
    }
  }
  async observe(bindingId: string): Promise<RuntimeSessionObservation | undefined> {
    const binding = await this.store.readLifecycleBinding(bindingId);
    const nativeBinding = await this.store.readNativeBinding(binding.nativeBindingRef);
    const service = new SessionService(this.store, undefined, this.processInspector);
    const observations = await service.reconcile([bindingId], {
      identity: nativeBinding.identity,
      runtime: binding.binding.runtime,
      lifecycleBindingId: bindingId,
    });
    const matching = observations.records.filter(
      (record) =>
        record.lifecycle.bindingId === bindingId &&
        record.nativeBindingRef === binding.nativeBindingRef,
    );
    if (matching.length > 1) {
      throw new SessionError(
        'SESSION_LIFECYCLE_OBSERVATION_DUPLICATE',
        'Multiple sessions claim one lifecycle binding.',
      );
    }
    const result =
      matching.length === 0
        ? undefined
        : (() => {
            const record = matching[0]!;
            return createRuntimeSessionObservation({
              runtime: record.runtime,
              identityRef: binding.binding.identityRef,
              runtimeQualifiedId: record.runtimeQualifiedId,
              displayId: record.recordId,
              title: record.metadata.title,
              resumeState: record.resume.state === 'resumable' ? 'resumable' : 'unknown',
              lifecycleState: record.liveness === 'inactive' ? 'shutdown' : record.liveness,
              workflowStatus: record.workflow.status,
              inbox: record.workflow.inbox,
              dispositionAt: record.workflow.dispositionAt ?? null,
              capturedAt: record.timestamps.updatedAt,
              freshUntil: record.timestamps.updatedAt,
              source: 'sessions:lifecycle',
              diagnostic: record.resume.diagnostic,
            });
          })();
    await this.onSessionsChanged?.();
    return result;
  }
}

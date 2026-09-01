import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { canonicalNativeRootDigest, type LaunchDescriptor } from '@mpx/launch';
import {
  createSessionLifecycleBindingV1,
  type NativeSessionRefV1,
  type RuntimeContextV1,
  type RuntimeSessionObservationV1,
  type SessionLifecycleBindingV1,
} from '@mpx/runtime-contracts';
import {
  LifecycleEventDirectoryConsumer,
  SessionError,
  SessionService,
  SessionStore,
  deriveNativeBindingRef,
  type NativeBindingRecordV1,
} from '@mpx/sessions';

export interface LaunchLifecyclePreparation {
  readonly binding: SessionLifecycleBindingV1;
  readonly eventDirectory: string;
}
function reconcileAccountBindingRef(
  existing: string | null,
  resolved: string | null,
): string | null {
  if (existing !== null && resolved !== null && existing !== resolved) {
    throw new SessionError(
      'SESSION_ACCOUNT_BINDING_MISMATCH',
      'The enrolled account binding does not match the existing session binding.',
    );
  }
  return existing ?? resolved;
}
export interface SessionLifecycleBridge {
  prepare(input: {
    descriptor: LaunchDescriptor;
    runtimeContext: RuntimeContextV1;
    nativeRuntimeRoot: string;
    cwd: string;
    nativeSessionRef?: NativeSessionRefV1;
    nativeBinding?: NativeBindingRecordV1;
  }): Promise<LaunchLifecyclePreparation>;
  consume(bindingId: string): Promise<void>;
  /** Consumes durable events and returns the observation bound to this launch only. */
  observe(bindingId: string): Promise<RuntimeSessionObservationV1 | undefined>;
}
export class ProductionSessionLifecycleBridge implements SessionLifecycleBridge {
  constructor(
    private readonly store: SessionStore,
    private readonly accountBindingRef?: (
      identity: string,
      runtime: 'claude' | 'pi',
    ) => Promise<string | null>,
    private readonly onSessionsChanged?: () => Promise<void>,
  ) {}
  async prepare(input: {
    descriptor: LaunchDescriptor;
    runtimeContext: RuntimeContextV1;
    nativeRuntimeRoot: string;
    cwd: string;
    nativeSessionRef?: NativeSessionRefV1;
    nativeBinding?: NativeBindingRecordV1;
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
        if (this.accountBindingRef) {
          const resolvedAccountBindingRef = await this.accountBindingRef(
            input.descriptor.identity.name,
            input.descriptor.runtime,
          );
          const accountBindingRef = reconcileAccountBindingRef(
            existing.accountBindingRef,
            resolvedAccountBindingRef,
          );
          if (accountBindingRef !== existing.accountBindingRef) {
            await this.store.saveNativeBinding({ ...existing, accountBindingRef, updatedAt: now });
          }
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
          accountBindingRef:
            (await this.accountBindingRef?.(
              input.descriptor.identity.name,
              input.descriptor.runtime,
            )) ?? null,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    const binding = createSessionLifecycleBindingV1({
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
      schemaVersion: 1,
      binding,
      nativeBindingRef,
      nativeSessionRef: input.nativeSessionRef ?? null,
      launch: {
        launchKey: input.descriptor.launchKey,
        descriptorDigest: input.runtimeContext.launchDescriptor.digest,
        mode: input.descriptor.mode,
        skillPolicy: input.descriptor.skillPolicy,
        contentScope: input.descriptor.contentScope.name,
        executor: { kind: input.descriptor.executor.name },
        workspace: input.descriptor.workspace,
        networkPolicy: input.descriptor.networkPolicy.name,
        grants: input.descriptor.grants,
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
      new SessionService(this.store),
    ).consume(bindingId);
    if (consumed > 0) {
      await this.onSessionsChanged?.();
    }
  }
  async observe(bindingId: string): Promise<RuntimeSessionObservationV1 | undefined> {
    const binding = await this.store.readLifecycleBinding(bindingId);
    const service = new SessionService(this.store);
    const observations = await service.reconcile([], [bindingId]);
    const records = await service.list({ runtime: binding.binding.runtime });
    const matching = records.filter(
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
        : observations.find(
            (observation) =>
              observation.runtimeQualifiedId === matching[0]!.runtimeQualifiedId &&
              observation.identityRef === binding.binding.identityRef,
          );
    await this.onSessionsChanged?.();
    return result;
  }
}

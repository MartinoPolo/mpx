import { execFile } from 'node:child_process';
import path from 'node:path';
import type { UserConfig } from '@mpx/config';
import { MpxError } from '@mpx/core';
import { canonicalNativeRootDigest } from '@mpx/launch';
import {
  ClaudeActiveScanner,
  PiV2ActiveRegistryScanner,
  SessionStore,
  deriveNativeBindingRef,
  type IdentityV1,
  type ProcessInspector,
  type ResumeDependencies,
  type SessionRecordV1,
  type RuntimeDiscovery,
} from '@mpx/sessions';
import { PiResumeTargetError, verifyPiResumeTarget } from '@mpx/runtime-pi';
import { WindowsProcessCapabilities } from '@mpx/windows';

export function productionSessionResumeDependencies(input: {
  user: UserConfig;
  store: SessionStore;
  verifier?: {
    verify(
      accountBindingRef: string,
    ): Promise<'verified' | 'unavailable' | 'mismatch' | 'duplicate'>;
  };
  environment?: NodeJS.ProcessEnv;
  processes?: {
    inspect(pid: number): Promise<{ readonly startFingerprint: string } | undefined>;
  };
  piTargetVerifier?: (
    root: string,
    ref: Parameters<typeof verifyPiResumeTarget>[1],
  ) => Promise<unknown>;
}): (record: SessionRecordV1) => Promise<ResumeDependencies> {
  const {
    user,
    store,
    verifier,
    environment = process.env,
    processes = new WindowsProcessCapabilities(),
    piTargetVerifier = verifyPiResumeTarget,
  } = input;
  return async (record) => ({
    resolveConfiguredRoot: async (nativeBindingRef) => {
      const binding = await store.readNativeBinding(nativeBindingRef);
      const configured = user.identities[binding.identity.name];
      if (!configured || configured.domain !== binding.identity.domain) {
        throw new MpxError({
          code: 'SESSION_RESUME_IDENTITY_MISMATCH',
          message: 'The recorded identity is not configured.',
        });
      }
      const root = configured.runtimeRoots[binding.runtime];
      return {
        root,
        canonicalRootDigest: canonicalNativeRootDigest(root),
        identity: binding.identity,
        runtime: binding.runtime,
      };
    },
    ...(verifier
      ? { verifyAccountBinding: (accountBindingRef: string) => verifier.verify(accountBindingRef) }
      : {}),
    verifyNativeTarget: async (root, ref, runtimeQualifiedId) => {
      if (record.runtime === 'pi') {
        try {
          await piTargetVerifier(root, ref);
        } catch (failure) {
          if (
            failure instanceof PiResumeTargetError &&
            failure.code === 'PI_RESUME_TARGET_INVALID'
          ) {
            return { valid: false, activity: 'unavailable' as const };
          }
          return { valid: true, activity: 'unavailable' as const };
        }
        if (!record.process) {
          return { valid: true, activity: 'unavailable' as const };
        }
        let inspected;
        try {
          inspected = await processes.inspect(record.process.pid);
        } catch {
          return { valid: true, activity: 'unavailable' as const };
        }
        if (inspected === undefined) {
          return { valid: true, activity: 'inactive' as const };
        }
        return {
          valid: true,
          activity:
            inspected.startFingerprint === record.process.startFingerprint
              ? ('active' as const)
              : ('unavailable' as const),
        };
      }
      const expected = runtimeQualifiedId.slice('claude:'.length);
      const valid =
        ref.kind === 'native-id' &&
        ref.value === expected &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(ref.value);
      if (!valid) {
        return { valid: false, activity: 'unavailable' as const };
      }
      const executable = environment.MPX_CLAUDE_EXECUTABLE;
      if (!executable || !path.isAbsolute(executable)) {
        return { valid: true, activity: 'unavailable' as const };
      }
      const activity = await new Promise<'active' | 'inactive' | 'unavailable'>((resolve) =>
        execFile(
          executable,
          ['agents', '--json'],
          {
            env: { ...environment, CLAUDE_CONFIG_DIR: root },
            shell: false,
            windowsHide: true,
            timeout: 15_000,
            maxBuffer: 4 * 1024 * 1024,
          },
          (failure, stdout) => {
            if (failure) {
              resolve('unavailable');
              return;
            }
            try {
              const value = JSON.parse(stdout) as unknown;
              const entries = Array.isArray(value)
                ? value
                : typeof value === 'object' &&
                    value !== null &&
                    Array.isArray((value as { agents?: unknown }).agents)
                  ? (value as { agents: unknown[] }).agents
                  : [];
              resolve(
                entries.some(
                  (item) =>
                    typeof item === 'object' &&
                    item !== null &&
                    (item as { sessionId?: unknown }).sessionId === ref.value,
                )
                  ? 'active'
                  : 'inactive',
              );
            } catch {
              resolve('unavailable');
            }
          },
        ),
      );
      return { valid: true, activity };
    },
  });
}

export interface ProductionSessionDiscoveryOptions {
  readonly piProcessInspector?: ProcessInspector;
  readonly clock?: () => number;
}

export async function productionSessionDiscoveries(input: {
  user: UserConfig;
  store: SessionStore;
  environment: NodeJS.ProcessEnv;
  accountResolver?: {
    resolve(
      identity: IdentityV1,
      runtime: 'claude' | 'pi',
      nativeRoot: string,
    ): Promise<string | null>;
  };
  options?: ProductionSessionDiscoveryOptions;
}): Promise<
  readonly {
    scanner: RuntimeDiscovery;
    context: { identity: IdentityV1; nativeBindingRef: string; runtime: 'claude' | 'pi' };
  }[]
> {
  const { user, store, environment, accountResolver, options = {} } = input;
  const existing = await store.listNativeBindings();
  const piProcessInspector = options.piProcessInspector ?? {
    inspect: async (pid: number) => {
      try {
        const inspected = await new WindowsProcessCapabilities().inspect(pid);
        return inspected ? { startFingerprint: inspected.startFingerprint } : null;
      } catch {
        return null;
      }
    },
  };
  const result: {
    scanner: RuntimeDiscovery;
    context: { identity: IdentityV1; nativeBindingRef: string; runtime: 'claude' | 'pi' };
  }[] = [];
  for (const [name, configured] of Object.entries(user.identities).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const identity = { domain: configured.domain, name };
    for (const runtime of ['claude', 'pi'] as const) {
      const root = configured.runtimeRoots[runtime];
      const recordedRootDigest = canonicalNativeRootDigest(root);
      const ref = deriveNativeBindingRef(identity, runtime, recordedRootDigest);
      const tupleBindings = existing.filter(
        (binding) =>
          binding.identity.domain === identity.domain &&
          binding.identity.name === identity.name &&
          binding.runtime === runtime &&
          binding.recordedRootDigest === recordedRootDigest,
      );
      if (tupleBindings.length > 1) {
        throw new MpxError({
          code: 'SESSION_NATIVE_BINDING_DUPLICATE',
          message: 'Multiple native binding records claim the same identity, runtime, and root.',
        });
      }
      const prior = existing.find((binding) => binding.ref === ref) ?? tupleBindings[0];
      if (
        prior &&
        (prior.identity.domain !== identity.domain ||
          prior.identity.name !== identity.name ||
          prior.runtime !== runtime ||
          prior.recordedRootDigest !== recordedRootDigest)
      ) {
        throw new MpxError({
          code: 'SESSION_BINDING_MISMATCH',
          message:
            'A stable native binding reference is inconsistent with its exact identity, runtime, or root.',
        });
      }
      let resolvedAccountBindingRef = prior?.accountBindingRef ?? null;
      let accountResolutionUnavailable = false;
      if (accountResolver) {
        try {
          resolvedAccountBindingRef = await accountResolver.resolve(identity, runtime, root);
        } catch {
          // A transient account lookup cannot revoke previously persisted authority. The
          // affected scanner still fails closed for this discovery run.
          accountResolutionUnavailable = true;
        }
      }
      const timestamp = new Date().toISOString();
      const binding = prior
        ? resolvedAccountBindingRef === prior.accountBindingRef
          ? prior
          : { ...prior, accountBindingRef: resolvedAccountBindingRef, updatedAt: timestamp }
        : {
            schemaVersion: 1 as const,
            ref,
            identity,
            runtime,
            recordedRootDigest,
            accountBindingRef: resolvedAccountBindingRef,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
      if ((!prior && !accountResolutionUnavailable) || (prior && binding !== prior)) {
        await store.saveNativeBinding(binding);
      }
      if (runtime === 'pi') {
        // Active Pi discovery is admitted only for an enrolled, exact configured root.
        // The scanner receives that root directly; it never infers or scans a home directory.
        result.push({
          scanner:
            accountResolutionUnavailable || binding.accountBindingRef === null
              ? {
                  runtime: 'pi',
                  scan: async () => ({
                    status: 'unavailable',
                    sessions: [],
                    diagnostic: 'PI_DISCOVERY_UNAVAILABLE',
                  }),
                }
              : new PiV2ActiveRegistryScanner(
                  root,
                  path.join(root, 'agent-resurrect', 'active-sessions'),
                  piProcessInspector,
                  {
                    ...(options.clock ? { clock: options.clock } : {}),
                    missingDirectory: 'available-empty',
                  },
                ),
          context: { identity, nativeBindingRef: binding.ref, runtime },
        });
        continue;
      }
      const scanner: RuntimeDiscovery = new ClaudeActiveScanner(async (command) => {
        const executable = environment.MPX_CLAUDE_EXECUTABLE;
        if (
          !executable ||
          !path.isAbsolute(executable) ||
          command.join('\0') !== 'claude\0agents\0--json'
        ) {
          return { available: false, exitCode: 1, stdout: '' };
        }
        return new Promise((resolve) =>
          execFile(
            executable,
            ['agents', '--json'],
            {
              env: { ...environment, CLAUDE_CONFIG_DIR: root },
              shell: false,
              windowsHide: true,
              timeout: 15_000,
              maxBuffer: 4 * 1024 * 1024,
            },
            (error, stdout, stderr) =>
              resolve({
                available: !error,
                exitCode:
                  typeof (error as { code?: unknown } | null)?.code === 'number'
                    ? (error as { code: number }).code
                    : error
                      ? 1
                      : 0,
                stdout,
                stderr,
              }),
          ),
        );
      });
      result.push({ scanner, context: { identity, nativeBindingRef: binding.ref, runtime } });
    }
  }
  return result;
}

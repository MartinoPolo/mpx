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
  parseClaudeActiveAgents,
  type IdentityV1,
  type ProcessInspector,
  type ResumeDependencies,
  type SessionRecordV1,
  type RuntimeDiscovery,
} from '@mpx/sessions';
import { PiResumeTargetError, verifyPiResumeTarget } from '@mpx/runtime-pi';
import { WindowsProcessCapabilities } from '@mpx/windows';
import type { SessionDiscoveryScope } from '../session-application-service.js';
import { ExactNativeRootVerifier } from './exact-native-root.js';
import { createPiAuthAvailabilityProbe, type PiAuthVerifier } from './pi-auth-availability.js';
import { resolveTrustedRuntimeExecutable } from './launch-execution-adapters.js';

export function claudeActivityFromAgentsOutput(
  stdout: string,
  nativeSessionId: string,
): 'active' | 'inactive' {
  const sessions = parseClaudeActiveAgents(JSON.parse(stdout) as unknown);
  return sessions.some((session) => session.nativeSessionId === nativeSessionId)
    ? 'active'
    : 'inactive';
}

export function productionSessionResumeDependencies(input: {
  user: UserConfig;
  store: SessionStore;
  environment?: NodeJS.ProcessEnv;
  processes?: {
    inspect(pid: number): Promise<{ readonly startFingerprint: string } | undefined>;
  };
  piTargetVerifier?: (
    root: string,
    ref: Parameters<typeof verifyPiResumeTarget>[1],
  ) => Promise<unknown>;
  exactNativeRootVerifier?: { verify(root: string): Promise<void> };
  piAuthVerifier?: PiAuthVerifier;
  cwd?: string;
}): (record: SessionRecordV1) => Promise<ResumeDependencies> {
  const {
    user,
    store,
    environment = process.env,
    processes = new WindowsProcessCapabilities(),
    piTargetVerifier = verifyPiResumeTarget,
  } = input;
  const cwd = input.cwd ?? process.cwd();
  const exactRoot = input.exactNativeRootVerifier ?? new ExactNativeRootVerifier();
  const auth =
    input.piAuthVerifier ??
    createPiAuthAvailabilityProbe({
      cwd,
      environment,
      resolveTrustedExecutable: () =>
        resolveTrustedRuntimeExecutable({ runtime: 'pi', cwd, environment }),
    });
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
      if (binding.runtime === 'pi') {
        await exactRoot.verify(root);
        await auth.verify(root);
      }
      return {
        root,
        canonicalRootDigest: canonicalNativeRootDigest(root),
        identity: binding.identity,
        runtime: binding.runtime,
      };
    },
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
          return {
            valid: true,
            activity:
              record.liveness === 'inactive' ? ('inactive' as const) : ('unavailable' as const),
          };
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
              resolve(claudeActivityFromAgentsOutput(stdout, ref.value));
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
  readonly exactNativeRootVerifier?: { verify(root: string): Promise<void> };
  readonly piAuthVerifier?: PiAuthVerifier;
}

export async function productionSessionDiscoveries(input: {
  user: UserConfig;
  store: SessionStore;
  environment: NodeJS.ProcessEnv;
  cwd?: string;
  options?: ProductionSessionDiscoveryOptions;
  scope?: SessionDiscoveryScope;
}): Promise<
  readonly {
    scanner: RuntimeDiscovery;
    context: { identity: IdentityV1; nativeBindingRef: string; runtime: 'claude' | 'pi' };
  }[]
> {
  const { user, store, environment, options = {}, scope } = input;
  const cwd = input.cwd ?? process.cwd();
  const exactRoot = options.exactNativeRootVerifier ?? new ExactNativeRootVerifier();
  const auth =
    options.piAuthVerifier ??
    createPiAuthAvailabilityProbe({
      cwd,
      environment,
      resolveTrustedExecutable: () =>
        resolveTrustedRuntimeExecutable({ runtime: 'pi', cwd, environment }),
    });
  const existing = await store.listNativeBindings();
  const piProcessInspector =
    options.piProcessInspector ?? new WindowsProcessCapabilities().asProcessInspector();
  const result: {
    scanner: RuntimeDiscovery;
    context: { identity: IdentityV1; nativeBindingRef: string; runtime: 'claude' | 'pi' };
  }[] = [];
  for (const [name, configured] of Object.entries(user.identities).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (
      scope?.identity !== undefined &&
      (scope.identity.name !== name || scope.identity.domain !== configured.domain)
    ) {
      continue;
    }
    const identity = { domain: configured.domain, name };
    for (const runtime of ['claude', 'pi'] as const) {
      if (scope?.runtime !== undefined && scope.runtime !== runtime) {
        continue;
      }
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
        (prior.ref !== ref ||
          prior.identity.domain !== identity.domain ||
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
      const timestamp = new Date().toISOString();
      const binding = prior ?? {
        schemaVersion: 1 as const,
        ref,
        identity,
        runtime,
        recordedRootDigest,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      if (!prior) {
        await store.saveNativeBinding(binding);
      }
      if (runtime === 'pi') {
        let available = true;
        try {
          await exactRoot.verify(root);
          await auth.verify(root);
        } catch {
          available = false;
        }
        result.push({
          scanner: available
            ? new PiV2ActiveRegistryScanner(
                root,
                path.join(root, 'agent-resurrect', 'active-sessions'),
                piProcessInspector,
                {
                  ...(options.clock ? { clock: options.clock } : {}),
                  missingDirectory: 'available-empty',
                },
              )
            : {
                runtime: 'pi',
                scan: async () => ({
                  status: 'unavailable',
                  sessions: [],
                  diagnostic: 'PI_DISCOVERY_UNAVAILABLE',
                }),
              },
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

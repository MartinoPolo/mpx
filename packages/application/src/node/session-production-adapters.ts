import { execFile } from 'node:child_process';
import path from 'node:path';
import type { UserConfig } from '@mpx/config';
import { MpxError } from '@mpx/core';
import { canonicalNativeRootDigest } from '@mpx/launch';
import { SessionStore, type ResumeDependencies, type SessionRecord } from '@mpx/sessions';
import { PiResumeTargetError, verifyPiResumeTarget } from '@mpx/runtime-pi';
import { WindowsProcessCapabilities } from '@mpx/windows';
import { ExactNativeRootVerifier } from './exact-native-root.js';
import { createPiAuthAvailabilityProbe, type PiAuthVerifier } from './pi-auth-availability.js';
import { resolveTrustedRuntimeExecutable } from './launch-execution-adapters.js';

export function claudeActivityFromAgentsOutput(
  stdout: string,
  nativeSessionId: string,
): 'active' | 'inactive' {
  const value = JSON.parse(stdout) as unknown;
  const agents = Array.isArray(value)
    ? value
    : value !== null &&
        typeof value === 'object' &&
        Array.isArray((value as { agents?: unknown }).agents)
      ? (value as { agents: unknown[] }).agents
      : value !== null &&
          typeof value === 'object' &&
          Array.isArray((value as { sessions?: unknown }).sessions)
        ? (value as { sessions: unknown[] }).sessions
        : undefined;
  if (!agents) {
    throw new Error('missing agents array');
  }
  return agents.some(
    (agent) =>
      agent !== null &&
      typeof agent === 'object' &&
      ((agent as { kind?: unknown }).kind ?? (agent as { type?: unknown }).type) ===
        'interactive' &&
      (agent as { sessionId?: unknown }).sessionId === nativeSessionId,
  )
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
}): (record: SessionRecord) => Promise<ResumeDependencies> {
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

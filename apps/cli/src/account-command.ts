import { execFile } from 'node:child_process';
import { MpxError } from '@mpx/core';
import type { UserConfig } from '@mpx/config';
import { RootAttestationService, type IdentityV1 } from '@mpx/sessions';
import {
  resolveTrustedRuntimeExecutable,
  type LaunchExecutionContext,
} from './launch-execution.js';

interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}
interface ProbeRequest {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly shell: false;
}
interface ProbeDependencies {
  readonly resolve: () => Promise<{ executable: string; argvPrefix: readonly string[] }>;
  readonly run: (request: ProbeRequest) => Promise<ProcessResult>;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}
export interface AccountAuthVerifier {
  verify(root: string): Promise<void>;
}
const authArgs = ['auth', 'check', '--provider', 'openai-codex', '--json', '--no-refresh'] as const;
function accountError(code: string, message: string): MpxError {
  return new MpxError({ code, message, retryable: false });
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
  );
}
export class PiAuthAvailabilityProbe implements AccountAuthVerifier {
  constructor(readonly dependencies: ProbeDependencies) {}
  async verify(root: string): Promise<void> {
    let result: ProcessResult;
    try {
      const trusted = await this.dependencies.resolve();
      const environment = Object.fromEntries(
        Object.entries(this.dependencies.environment).filter(
          ([key]) => key.toLowerCase() !== 'pi_coding_agent_dir',
        ),
      );
      result = await this.dependencies.run({
        executable: trusted.executable,
        argv: [...trusted.argvPrefix, ...authArgs],
        cwd: this.dependencies.cwd,
        environment: { ...environment, PI_CODING_AGENT_DIR: root },
        timeoutMs: 15_000,
        maxOutputBytes: 16_384,
        shell: false,
      });
    } catch {
      throw accountError(
        'ACCOUNT_AUTH_UNAVAILABLE',
        'Pi OAuth availability could not be verified.',
      );
    }
    if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) > 16_384) {
      throw accountError('ACCOUNT_AUTH_UNAVAILABLE', 'Pi OAuth is unavailable.');
    }
    let value: unknown;
    try {
      value = JSON.parse(result.stdout) as unknown;
    } catch {
      throw accountError('ACCOUNT_AUTH_UNAVAILABLE', 'Pi OAuth availability output is malformed.');
    }
    if (
      !exact(value, ['status', 'provider', 'authType']) ||
      value.status !== 'ready' ||
      value.provider !== 'openai-codex' ||
      value.authType !== 'oauth'
    ) {
      throw accountError('ACCOUNT_AUTH_UNAVAILABLE', 'Pi OAuth is unavailable.');
    }
  }
}
function nodeProbeRunner(request: ProbeRequest): Promise<ProcessResult> {
  return new Promise((resolve, reject) =>
    execFile(
      request.executable,
      [...request.argv],
      {
        cwd: request.cwd,
        env: request.environment,
        timeout: request.timeoutMs,
        maxBuffer: request.maxOutputBytes,
        shell: false,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code !== 'number') {
          reject(error);
          return;
        }
        resolve({
          exitCode:
            typeof (error as { code?: unknown } | null)?.code === 'number'
              ? (error as { code: number }).code
              : error
                ? 1
                : 0,
          stdout,
          stderr,
        });
      },
    ),
  );
}
export function productionPiAuthProbe(input: {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  resolver?: LaunchExecutionContext['launchExecutableResolver'];
}): PiAuthAvailabilityProbe {
  return new PiAuthAvailabilityProbe({
    cwd: input.cwd,
    environment: input.environment,
    resolve: () =>
      resolveTrustedRuntimeExecutable({
        runtime: 'pi',
        cwd: input.cwd,
        environment: input.environment,
        ...(input.resolver ? { resolver: input.resolver } : {}),
      }),
    run: nodeProbeRunner,
  });
}

type Action = 'enroll' | 're-enroll' | 'list' | 'status' | 'verify';
interface CommandInput {
  readonly action: Action;
  readonly identityName?: string;
  readonly confirmationDigest?: string;
}
interface CommandDependencies {
  readonly user: UserConfig;
  readonly service: RootAttestationService;
  readonly auth: AccountAuthVerifier;
}
function configuredIdentity(
  user: UserConfig,
  name: string | undefined,
): { identity: IdentityV1; root: string } {
  if (!name) {
    throw accountError('IDENTITY_REQUIRED', 'Account commands require --identity NAME.');
  }
  const configured = user.identities[name];
  if (!configured) {
    throw accountError('IDENTITY_UNKNOWN', `Unknown identity '${name}'.`);
  }
  return { identity: { domain: configured.domain, name }, root: configured.runtimeRoots.pi };
}
function publicRecord(
  record: { identity: IdentityV1; runtime: 'pi'; mode: 'root-attested' },
  status: string,
) {
  return Object.freeze({
    schemaVersion: 1 as const,
    identity: record.identity,
    runtime: record.runtime,
    mode: record.mode,
    status,
  });
}
async function configuredStatus(
  service: RootAttestationService,
  identity: IdentityV1,
  root: string,
): Promise<'missing' | 'enrolled' | 'root-changed'> {
  const record = await service.find(identity);
  if (!record) {
    return 'missing';
  }
  try {
    await service.verify(identity, root);
    return 'enrolled';
  } catch (error) {
    if (
      (error as { code?: unknown }).code === 'ACCOUNT_ROOT_CHANGED' ||
      (error as { code?: unknown }).code === 'ACCOUNT_ROOT_INVALID'
    ) {
      return 'root-changed';
    }
    throw error;
  }
}
export async function executeAccountCommand(
  input: CommandInput,
  dependencies: CommandDependencies,
): Promise<Record<string, unknown>> {
  if (input.action === 'list') {
    if (input.identityName !== undefined || input.confirmationDigest !== undefined) {
      throw accountError(
        'ACCOUNT_USAGE_INVALID',
        'Account list accepts no identity or confirmation options.',
      );
    }
    await dependencies.service.store.list();
    const accounts = await Promise.all(
      Object.keys(dependencies.user.identities)
        .sort()
        .map(async (name) => {
          const configured = dependencies.user.identities[name]!;
          const identity = { domain: configured.domain, name };
          return publicRecord(
            { identity, runtime: 'pi', mode: 'root-attested' },
            await configuredStatus(dependencies.service, identity, configured.runtimeRoots.pi),
          );
        }),
    );
    return { schemaVersion: 1, accounts };
  }
  const { identity, root } = configuredIdentity(dependencies.user, input.identityName);
  if (input.action === 'status') {
    if (input.confirmationDigest !== undefined) {
      throw accountError('ACCOUNT_USAGE_INVALID', 'Account status does not accept confirmation.');
    }
    return publicRecord(
      { identity, runtime: 'pi', mode: 'root-attested' },
      await configuredStatus(dependencies.service, identity, root),
    );
  }
  if (input.action === 'verify') {
    if (input.confirmationDigest !== undefined) {
      throw accountError('ACCOUNT_USAGE_INVALID', 'Account verify does not accept confirmation.');
    }
    const record = await dependencies.service.verify(identity, root);
    await dependencies.auth.verify(root);
    return publicRecord(record, 'verified');
  }
  const plan = await dependencies.service.plan(input.action, identity, root);
  if (input.confirmationDigest === undefined) {
    return {
      schemaVersion: 1,
      operation: input.action,
      identity,
      runtime: 'pi',
      mode: 'root-attested',
      confirmationDigest: plan.confirmationDigest,
      status: 'planned',
      proves: 'configured-root-and-registry-state',
      liveAuth: 'deferred-until-confirmation',
    };
  }
  if (input.confirmationDigest !== plan.confirmationDigest) {
    throw accountError(
      'ACCOUNT_PLAN_STALE',
      'The account enrollment confirmation is stale or invalid.',
    );
  }
  await dependencies.auth.verify(root);
  const rechecked = await dependencies.service.plan(input.action, identity, root);
  if (rechecked.confirmationDigest !== input.confirmationDigest) {
    throw accountError('ACCOUNT_PLAN_STALE', 'The account enrollment confirmation became stale.');
  }
  const record = await dependencies.service.confirm(rechecked);
  return {
    schemaVersion: 1,
    operation: input.action,
    identity: record.identity,
    runtime: 'pi',
    mode: 'root-attested',
    status: input.action === 'enroll' ? 'enrolled' : 're-enrolled',
  };
}

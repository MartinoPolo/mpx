import { execFile } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { MpxError } from '@mpx/core';
export interface PiAuthVerifier {
  verify(root: string): Promise<void>;
}

export interface TrustedExecutable {
  readonly executable: string;
  readonly argvPrefix: readonly string[];
}
export interface PiAuthProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}
export interface PiAuthProcessRequest {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly shell: false;
}
export interface PiAuthAvailabilityDependencies {
  readonly resolveTrustedExecutable: () => Promise<TrustedExecutable>;
  readonly run: (request: PiAuthProcessRequest) => Promise<PiAuthProcessResult>;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

const authArgs = ['auth', 'check', '--provider', 'openai-codex', '--json', '--no-refresh'] as const;
const unavailable = (message: string): MpxError =>
  new MpxError({ code: 'PI_AUTH_UNAVAILABLE', message, retryable: false });
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');

export class PiAuthAvailabilityProbe implements PiAuthVerifier {
  constructor(readonly dependencies: PiAuthAvailabilityDependencies) {}

  async verify(root: string): Promise<void> {
    let result: PiAuthProcessResult;
    try {
      const trusted = await this.dependencies.resolveTrustedExecutable();
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
    } catch (error) {
      if (error instanceof MpxError) {
        throw error;
      }
      throw unavailable('Pi OAuth availability could not be verified.');
    }
    if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) > 16_384) {
      throw unavailable('Pi OAuth is unavailable.');
    }
    let value: unknown;
    try {
      value = JSON.parse(result.stdout) as unknown;
    } catch {
      throw unavailable('Pi OAuth availability output is malformed.');
    }
    if (
      !exact(value, ['status', 'provider', 'authType']) ||
      value.status !== 'ready' ||
      value.provider !== 'openai-codex' ||
      value.authType !== 'oauth'
    ) {
      throw unavailable('Pi OAuth is unavailable.');
    }
  }
}

function nodeProbeRunner(request: PiAuthProcessRequest): Promise<PiAuthProcessResult> {
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

export function createPiAuthAvailabilityProbe(
  input: Omit<PiAuthAvailabilityDependencies, 'run'> & {
    readonly run?: PiAuthAvailabilityDependencies['run'];
  },
): PiAuthAvailabilityProbe {
  return new PiAuthAvailabilityProbe({ ...input, run: input.run ?? nodeProbeRunner });
}

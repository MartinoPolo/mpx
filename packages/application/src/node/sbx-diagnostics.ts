import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  diagnoseSbx,
  resolveTrustedSbxExecutable,
  SBX_V0_39_0_PIN,
  type BoundedProcessRunner,
} from '@mpx/executors';

export interface DefaultSbxDiagnosticDependencies {
  resolveExecutable?: () => Promise<string>;
  runner?: BoundedProcessRunner;
}

function candidates(environment: NodeJS.ProcessEnv): {
  candidates: string[];
  trustedRoots: string[];
} {
  const roots = [environment.LOCALAPPDATA, environment.ProgramFiles].filter(
    (value): value is string => Boolean(value) && path.isAbsolute(value!),
  );
  return {
    trustedRoots: roots,
    candidates: roots.flatMap((root) => [path.join(root, 'sbx', 'sbx.exe')]),
  };
}

async function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** Performs the production read-only sbx diagnostic probe. */
export async function createDefaultSbxDiagnostics(
  environment: NodeJS.ProcessEnv,
  operationCwd: string,
  dependencies: DefaultSbxDiagnosticDependencies = {},
): Promise<{ available: boolean; failureCodes: readonly string[]; readOnly: true }> {
  const locations = candidates(environment);
  let executable: string;
  try {
    executable = dependencies.resolveExecutable
      ? await dependencies.resolveExecutable()
      : await resolveTrustedSbxExecutable({
          candidates: locations.candidates,
          projectRoot: operationCwd,
          trustedRoots: locations.trustedRoots,
          expectedSha256: SBX_V0_39_0_PIN.windowsBinarySha256,
          inspect: async (file) => {
            const info = await lstat(file);
            const canonical = await realpath(file);
            return {
              file: info.isFile() && !info.isSymbolicLink(),
              realpath: canonical,
              sha256: await sha256File(canonical),
            };
          },
        });
  } catch {
    return { available: false, failureCodes: ['SBX_NOT_FOUND'], readOnly: true };
  }
  const runner: BoundedProcessRunner = dependencies.runner ?? {
    run: (request) =>
      new Promise((resolve, reject) => {
        execFile(
          request.executable,
          [...request.argv],
          {
            cwd: request.cwd,
            env: environment,
            timeout: request.timeoutMs,
            maxBuffer: request.maxOutputBytes,
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            const code =
              error && typeof (error as { code?: unknown }).code === 'number'
                ? (error as { code: number }).code
                : 0;
            if (error && typeof (error as { code?: unknown }).code !== 'number') reject(error);
            else resolve({ exitCode: code, stdout, stderr, truncated: false });
          },
        );
      }),
  };
  return diagnoseSbx({ executable, cwd: operationCwd, runner, pin: SBX_V0_39_0_PIN });
}

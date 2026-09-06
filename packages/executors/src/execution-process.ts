import path from 'node:path';

export class ExecutionError extends Error {
  readonly name = 'ExecutionError';
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, string | number | boolean | null>>,
  ) {
    super(message);
  }
  toJSON(): {
    code: string;
    message: string;
    details?: Readonly<Record<string, string | number | boolean | null>>;
  } {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function fail(
  code: string,
  message: string,
  details?: Readonly<Record<string, string | number | boolean | null>>,
): never {
  throw new ExecutionError(code, message, details);
}

export interface ProcessRequest {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

export interface BoundedProcessRunner {
  run(
    request: Required<
      Pick<
        ProcessRequest,
        'executable' | 'argv' | 'cwd' | 'environment' | 'timeoutMs' | 'maxOutputBytes'
      >
    > & { readonly shell: false },
  ): Promise<ProcessResult>;
}

export function invokeBoundedProcess(
  runner: BoundedProcessRunner,
  request: ProcessRequest,
): Promise<ProcessResult> {
  if (!path.win32.isAbsolute(request.executable) && !path.posix.isAbsolute(request.executable)) {
    fail('PROCESS_EXECUTABLE_UNTRUSTED', 'Process executable must be absolute.');
  }
  if (
    request.argv.length > 256 ||
    request.argv.some((arg) => typeof arg !== 'string' || arg.length > 8192)
  ) {
    fail('PROCESS_ARGV_INVALID', 'Process argv exceeds safety bounds.');
  }
  return runner.run({
    executable: request.executable,
    argv: [...request.argv],
    cwd: request.cwd,
    environment: request.environment,
    timeoutMs: Math.min(request.timeoutMs ?? 120_000, 300_000),
    maxOutputBytes: Math.min(request.maxOutputBytes ?? 65_536, 1_048_576),
    shell: false,
  });
}

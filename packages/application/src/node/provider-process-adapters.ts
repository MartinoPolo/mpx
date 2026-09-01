import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { MpxError } from '@mpx/core';
import { isSafeRouteLabel } from '@mpx/config';
import type {
  ProviderProcessExecutor,
  ProviderProcessRequest,
  ProviderProcessResult,
} from '@mpx/providers';

const builtInProviderExecutables = new Set(['gh', 'glab', 'kf']);
const providerProcessTimeoutMilliseconds = 120_000;
const providerProcessMaxBufferBytes = 10 * 1024 * 1024;
const safeRepositorySegment = /^[A-Za-z0-9_.][A-Za-z0-9._-]*$/u;
const safeRemoteName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export interface NodeRepositorySelectorResolverContract {
  resolve(request: { root: string; remote: string }): Promise<string>;
}

type ExecutableResolver = (
  executable: string,
  operationCwd: string,
  environment: NodeJS.ProcessEnv,
) => Promise<string>;

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function resolutionError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function isWithin(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

async function resolveTrustedExecutableOnPath(
  executable: string,
  operationCwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  if (!path.isAbsolute(operationCwd)) {
    throw resolutionError('EINVAL', 'The operation cwd must be absolute.');
  }
  const canonicalOperationCwd = await realpath(operationCwd);
  const pathValue = environmentValue(environment, 'PATH') ?? '';
  const pathExtensions =
    process.platform === 'win32'
      ? [
          '',
          ...(environmentValue(environment, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
            .split(';')
            .filter(Boolean)
            .map((extension) => (extension.startsWith('.') ? extension : `.${extension}`)),
        ]
      : [''];

  for (const rawDirectory of pathValue.split(path.delimiter)) {
    const directory =
      rawDirectory.startsWith('"') && rawDirectory.endsWith('"')
        ? rawDirectory.slice(1, -1)
        : rawDirectory;
    if (!path.isAbsolute(directory)) {
      continue;
    }
    for (const extension of pathExtensions) {
      const candidate = path.join(directory, `${executable}${extension}`);
      try {
        if (!(await stat(candidate)).isFile()) {
          continue;
        }
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === 'ENOENT' ||
          (error as NodeJS.ErrnoException).code === 'ENOTDIR'
        ) {
          continue;
        }
        throw error;
      }
      const canonicalCandidate = await realpath(candidate);
      if (isWithin(canonicalOperationCwd, canonicalCandidate)) {
        throw resolutionError('EACCES', 'Executables inside the operation cwd are not trusted.');
      }
      return canonicalCandidate;
    }
  }
  throw resolutionError('ENOENT', 'The trusted executable was not found on PATH.');
}

export async function resolveBuiltInProviderExecutable(
  executable: string,
  operationCwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (!builtInProviderExecutables.has(executable)) {
    throw resolutionError('EINVAL', 'The provider executable is not a trusted built-in.');
  }
  return resolveTrustedExecutableOnPath(executable, operationCwd, environment);
}

export function classifyProviderProcessResult(
  error: unknown,
  stdout: string,
  stderr: string,
  authExitCodes: readonly number[] = [],
): ProviderProcessResult {
  if (error !== null && error !== undefined) {
    const exitCode = (error as { code?: unknown }).code;
    if (typeof exitCode !== 'number' || !Number.isInteger(exitCode) || exitCode < 0) {
      throw error;
    }
    return {
      exitCode,
      stdout,
      stderr,
      ...(authExitCodes.includes(exitCode) ? { failure: 'auth' as const } : {}),
    };
  }
  return { exitCode: 0, stdout, stderr };
}

function routeBoundEnvironment(
  environment: NodeJS.ProcessEnv,
  executable: string,
  route: string | undefined,
): NodeJS.ProcessEnv {
  if (route === undefined || !isSafeRouteLabel(route)) {
    throw resolutionError('EINVAL', 'A safe provider route is required.');
  }
  const appData = environmentValue(environment, 'APPDATA');
  if (!appData || !path.isAbsolute(appData)) {
    throw resolutionError(
      'EINVAL',
      'APPDATA must be an absolute path for provider authentication.',
    );
  }
  const isolatedEntries = Object.entries(environment).filter(
    ([key]) =>
      !['gh_config_dir', 'glab_config_dir', 'mpx_provider_route'].includes(key.toLowerCase()),
  );
  const result: NodeJS.ProcessEnv = {
    ...Object.fromEntries(isolatedEntries),
    MPX_PROVIDER_ROUTE: route,
  };
  const runtimeBound = environmentValue(environment, 'MPX_RUNTIME_CONTEXT') !== undefined;
  if (executable === 'gh') {
    const injected = environmentValue(environment, 'MPX_RUNTIME_ROUTE_PROVIDER_GITHUB');
    if (runtimeBound && (!injected || !path.isAbsolute(injected))) {
      throw resolutionError('EINVAL', 'The exact launch-injected GitHub route is required.');
    }
    result.GH_CONFIG_DIR = runtimeBound
      ? injected!
      : path.join(appData, 'mpx', 'provider-routes', 'github', route);
  }
  if (executable === 'glab') {
    const injected = environmentValue(environment, 'MPX_RUNTIME_ROUTE_PROVIDER_GITLAB');
    if (runtimeBound && (!injected || !path.isAbsolute(injected))) {
      throw resolutionError('EINVAL', 'The exact launch-injected GitLab route is required.');
    }
    result.GLAB_CONFIG_DIR = runtimeBound
      ? injected!
      : path.join(appData, 'mpx', 'provider-routes', 'gitlab', route);
  }
  return result;
}

export class NodeProviderProcessExecutor implements ProviderProcessExecutor {
  readonly #resolutionCache = new Map<string, string>();

  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly executableResolver: ExecutableResolver = resolveBuiltInProviderExecutable,
  ) {}

  async execute(request: ProviderProcessRequest): Promise<ProviderProcessResult> {
    const [executable, ...args] = request.argv;
    if (!builtInProviderExecutables.has(executable)) {
      throw resolutionError('EINVAL', 'The provider executable is not a trusted built-in.');
    }
    const childEnvironment = routeBoundEnvironment(this.environment, executable, request.route);
    const operationCwd = request.cwd ?? process.cwd();
    const canonicalOperationCwd = await realpath(operationCwd);
    const cacheKey = JSON.stringify([
      executable,
      canonicalOperationCwd,
      environmentValue(this.environment, 'PATH') ?? '',
      environmentValue(this.environment, 'PATHEXT') ?? '',
    ]);
    let resolvedExecutable = this.#resolutionCache.get(cacheKey);
    if (resolvedExecutable === undefined) {
      resolvedExecutable = await this.executableResolver(
        executable,
        canonicalOperationCwd,
        this.environment,
      );
      if (!path.isAbsolute(resolvedExecutable)) {
        throw resolutionError(
          'EACCES',
          'The provider executable did not resolve to an absolute path.',
        );
      }
      resolvedExecutable = await realpath(resolvedExecutable);
      if (isWithin(canonicalOperationCwd, resolvedExecutable)) {
        throw resolutionError(
          'EACCES',
          'Provider executables inside the operation cwd are not trusted.',
        );
      }
      this.#resolutionCache.set(cacheKey, resolvedExecutable);
    } else {
      resolvedExecutable = await realpath(resolvedExecutable);
      if (isWithin(canonicalOperationCwd, resolvedExecutable)) {
        throw resolutionError(
          'EACCES',
          'Provider executables inside the operation cwd are not trusted.',
        );
      }
    }
    return new Promise((resolve, reject) =>
      execFile(
        resolvedExecutable,
        args,
        {
          cwd: canonicalOperationCwd,
          env: childEnvironment,
          windowsHide: true,
          timeout: request.timeoutMilliseconds ?? providerProcessTimeoutMilliseconds,
          maxBuffer: providerProcessMaxBufferBytes,
        },
        (error, stdout, stderr) => {
          try {
            resolve(
              classifyProviderProcessResult(error, stdout, stderr, request.authExitCodes ?? []),
            );
          } catch (failure) {
            reject(failure);
          }
        },
      ),
    );
  }
}

function repositorySelectorError(code: string, message: string): MpxError {
  return new MpxError({ code, message, retryable: false });
}

function validRepositorySegment(value: string): boolean {
  return value !== '.' && value !== '..' && safeRepositorySegment.test(value);
}

export function parseForgeRepositoryUrl(value: string): string {
  if (value.length === 0 || value !== value.trim() || /[\\\0]/u.test(value)) {
    throw repositorySelectorError(
      'REPOSITORY_REMOTE_INVALID',
      'The configured repository remote URL is invalid.',
    );
  }
  let host: string;
  let pathValue: string;
  const scp = /^(?:([^@/:?#]+)@)?([^@/:?#]+):([^?#]+)$/u.exec(value);
  if (scp && !value.includes('://')) {
    const user = scp[1];
    if (user !== undefined && user !== 'git') {
      throw repositorySelectorError(
        'REPOSITORY_REMOTE_INVALID',
        'The configured repository remote URL has untrusted credentials.',
      );
    }
    host = scp[2]!.toLowerCase();
    pathValue = scp[3]!;
  } else {
    let remote: URL;
    try {
      remote = new URL(value);
    } catch {
      throw repositorySelectorError(
        'REPOSITORY_REMOTE_INVALID',
        'The configured repository remote URL is invalid.',
      );
    }
    if (remote.protocol !== 'https:' && remote.protocol !== 'ssh:') {
      throw repositorySelectorError(
        'REPOSITORY_REMOTE_INVALID',
        'The configured repository remote URL scheme is unsupported.',
      );
    }
    if ((remote.username !== '' && remote.username !== 'git') || remote.password !== '') {
      throw repositorySelectorError(
        'REPOSITORY_REMOTE_INVALID',
        'The configured repository remote URL has untrusted credentials.',
      );
    }
    if (remote.search !== '' || remote.hash !== '' || remote.port !== '') {
      throw repositorySelectorError(
        'REPOSITORY_REMOTE_INVALID',
        'The configured repository remote URL contains unsupported components.',
      );
    }
    host = remote.hostname.toLowerCase();
    pathValue = remote.pathname.startsWith('/') ? remote.pathname.slice(1) : remote.pathname;
  }
  if (!validRepositorySegment(host) || pathValue.includes('%')) {
    throw repositorySelectorError(
      'REPOSITORY_REMOTE_INVALID',
      'The configured repository remote URL is unsafe.',
    );
  }
  const segments = pathValue.split('/');
  if (segments.length !== 2) {
    throw repositorySelectorError(
      'REPOSITORY_REMOTE_INVALID',
      'The configured repository remote URL must identify one owner and repository.',
    );
  }
  const owner = segments[0]!;
  const repository = segments[1]!.endsWith('.git') ? segments[1]!.slice(0, -4) : segments[1]!;
  if (!validRepositorySegment(owner) || !validRepositorySegment(repository)) {
    throw repositorySelectorError(
      'REPOSITORY_REMOTE_INVALID',
      'The configured repository remote URL contains unsafe path segments.',
    );
  }
  return `${host}/${owner}/${repository}`;
}

export class NodeRepositorySelectorResolver implements NodeRepositorySelectorResolverContract {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async resolve(request: { root: string; remote: string }): Promise<string> {
    if (
      !path.isAbsolute(request.root) ||
      !safeRemoteName.test(request.remote) ||
      request.remote === '.' ||
      request.remote === '..'
    ) {
      throw repositorySelectorError(
        'REPOSITORY_REMOTE_INVALID',
        'The configured repository remote is invalid.',
      );
    }
    let gitExecutable: string;
    try {
      gitExecutable = await resolveTrustedExecutableOnPath('git', request.root, this.environment);
    } catch {
      throw repositorySelectorError(
        'REPOSITORY_SELECTOR_UNAVAILABLE',
        'A trusted Git executable is required to resolve the configured repository remote.',
      );
    }
    const output = await new Promise<string>((resolve, reject) =>
      execFile(
        gitExecutable,
        ['-C', request.root, 'config', '--get', `remote.${request.remote}.url`],
        {
          cwd: request.root,
          env: { ...this.environment, GIT_TERMINAL_PROMPT: '0' },
          encoding: 'utf8',
          windowsHide: true,
          timeout: providerProcessTimeoutMilliseconds,
          maxBuffer: providerProcessMaxBufferBytes,
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      ),
    ).catch(() => {
      throw repositorySelectorError(
        'REPOSITORY_REMOTE_UNAVAILABLE',
        'The configured repository remote URL is missing or unavailable.',
      );
    });
    const lines = output.split(/\r?\n/u).filter((line) => line.length > 0);
    if (lines.length !== 1) {
      throw repositorySelectorError(
        'REPOSITORY_REMOTE_INVALID',
        'The configured repository remote URL is malformed.',
      );
    }
    return parseForgeRepositoryUrl(lines[0]!);
  }
}

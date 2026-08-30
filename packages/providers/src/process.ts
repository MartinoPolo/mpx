import { ProviderError } from './registry.js';

export interface ProviderProcessRequest {
  readonly argv: readonly [string, ...string[]];
  readonly route?: string;
  readonly cwd?: string;
  readonly timeoutMilliseconds?: number;
  readonly authExitCodes?: readonly number[];
}

export interface ProviderProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly failure?: 'auth';
}

export interface ProviderProcessExecutor {
  execute(request: ProviderProcessRequest): Promise<ProviderProcessResult>;
}

export interface ProviderCommandRequest extends ProviderProcessRequest {
  readonly providerId: string;
  readonly acceptedExitCodes?: readonly number[];
  /** True only when command dispatch may have changed remote state. */
  readonly mutation?: boolean;
}

const providerDetails = (providerId: string, data: Readonly<Record<string, number>> = {}) => ({
  providerData: { [providerId]: data },
});

const MUTATION_CAPABILITIES = new Set([
  'issue.create',
  'issue.edit',
  'issue.comment',
  'issue.label',
  'issue.move',
  'issue.finish',
  'review.create',
  'review.update',
  'review.comment',
  'review.ready',
  'review.merge',
  'ci.retry',
]);
export const isMutationCapability = (capability: string): boolean =>
  MUTATION_CAPABILITIES.has(capability);

export async function runProviderCommand<T = string>(
  request: ProviderCommandRequest,
  executor: ProviderProcessExecutor,
  parse: (stdout: string) => T = (stdout) => stdout as T,
): Promise<T> {
  let result: ProviderProcessResult;
  try {
    result = await executor.execute({
      argv: [...request.argv] as [string, ...string[]],
      ...(request.route === undefined ? {} : { route: request.route }),
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      ...(request.timeoutMilliseconds === undefined
        ? {}
        : { timeoutMilliseconds: request.timeoutMilliseconds }),
      ...(request.authExitCodes === undefined ? {} : { authExitCodes: [...request.authExitCodes] }),
    });
  } catch (error) {
    const missing =
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
    const ambiguousMutation = request.mutation === true && !missing;
    throw new ProviderError(
      missing
        ? 'EXECUTABLE_MISSING'
        : ambiguousMutation
          ? 'MUTATION_OUTCOME_UNKNOWN'
          : 'COMMAND_FAILURE',
      missing
        ? 'The provider executable is unavailable.'
        : ambiguousMutation
          ? 'The provider mutation outcome is unknown.'
          : 'The provider command could not be started.',
      {
        retryable: !missing && !ambiguousMutation,
        remediation: missing
          ? 'Install the trusted provider executable and verify the selected route.'
          : ambiguousMutation
            ? 'Inspect remote state before attempting the mutation again.'
            : 'Verify the provider route and retry.',
        details: providerDetails(request.providerId),
      },
    );
  }
  if (result.exitCode !== 0 && !request.acceptedExitCodes?.includes(result.exitCode)) {
    const auth = result.failure === 'auth';
    const ambiguousMutation = request.mutation === true && !auth;
    throw new ProviderError(
      auth ? 'AUTH_FAILURE' : ambiguousMutation ? 'MUTATION_OUTCOME_UNKNOWN' : 'COMMAND_FAILURE',
      auth
        ? 'Provider authentication failed.'
        : ambiguousMutation
          ? 'The provider mutation outcome is unknown.'
          : 'The provider command failed.',
      {
        retryable: !auth && !ambiguousMutation,
        remediation: auth
          ? 'Authenticate the selected provider route and relaunch.'
          : ambiguousMutation
            ? 'Inspect remote state before attempting the mutation again.'
            : 'Inspect the provider command outside MPX for additional diagnostics.',
        details: providerDetails(request.providerId, { exitCode: result.exitCode }),
      },
    );
  }
  try {
    return parse(result.stdout);
  } catch {
    const ambiguousMutation = request.mutation === true;
    throw new ProviderError(
      ambiguousMutation ? 'MUTATION_OUTCOME_UNKNOWN' : 'INVALID_RESPONSE',
      ambiguousMutation
        ? 'The provider mutation outcome is unknown.'
        : 'The provider returned an invalid response.',
      {
        retryable: false,
        ...(ambiguousMutation
          ? { remediation: 'Inspect remote state before attempting the mutation again.' }
          : {}),
        details: providerDetails(request.providerId, {
          outputBytes: Buffer.byteLength(result.stdout),
        }),
      },
    );
  }
}

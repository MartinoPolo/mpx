import type { Runtime } from './types.js';

export interface RuntimeModelSelectionV1 {
  readonly schemaVersion: 1;
  readonly runtime: Runtime;
  readonly provider: string;
  readonly defaultModel: string;
  readonly enabledModels: readonly string[];
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function freeze<T extends RuntimeModelSelectionV1>(value: T): T {
  Object.freeze(value.enabledModels);
  return Object.freeze(value);
}

/** Validates the process-local, provider-neutral model selection passed to a runtime adapter. */
export function parseRuntimeModelSelectionV1(value: unknown): RuntimeModelSelectionV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('runtime model selection must be an object');
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).sort().join(',') !==
    ['defaultModel', 'enabledModels', 'provider', 'runtime', 'schemaVersion'].sort().join(',')
  ) {
    throw new TypeError('runtime model selection has invalid fields');
  }
  if (input.schemaVersion !== 1 || (input.runtime !== 'pi' && input.runtime !== 'claude')) {
    throw new TypeError('runtime model selection schemaVersion/runtime is invalid');
  }
  if (
    typeof input.provider !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.provider)
  ) {
    throw new TypeError('runtime model selection provider is invalid');
  }
  if (
    typeof input.defaultModel !== 'string' ||
    !MODEL_ID.test(input.defaultModel) ||
    !input.defaultModel.startsWith(`${input.provider}/`)
  ) {
    throw new TypeError('runtime model selection defaultModel is invalid');
  }
  if (
    !Array.isArray(input.enabledModels) ||
    input.enabledModels.length < 1 ||
    input.enabledModels.length > 64 ||
    input.enabledModels.some(
      (model) =>
        typeof model !== 'string' ||
        !MODEL_ID.test(model) ||
        !model.startsWith(`${input.provider}/`),
    ) ||
    new Set(input.enabledModels).size !== input.enabledModels.length ||
    !input.enabledModels.includes(input.defaultModel)
  ) {
    throw new TypeError('runtime model selection enabledModels/defaultModel is invalid');
  }
  return freeze({
    schemaVersion: 1,
    runtime: input.runtime,
    provider: input.provider,
    defaultModel: input.defaultModel,
    enabledModels: [...input.enabledModels] as string[],
  });
}

/** Current built-in selection. It is code-owned and is not a user-config schema input. */
export function defaultRuntimeModelSelectionV1(
  runtime: 'pi',
): RuntimeModelSelectionV1 & { readonly runtime: 'pi' };
export function defaultRuntimeModelSelectionV1(
  runtime: 'claude',
): RuntimeModelSelectionV1 & { readonly runtime: 'claude' };
export function defaultRuntimeModelSelectionV1(runtime: Runtime): RuntimeModelSelectionV1 {
  return parseRuntimeModelSelectionV1(
    runtime === 'pi'
      ? {
          schemaVersion: 1,
          runtime,
          provider: 'openai-codex',
          defaultModel: 'openai-codex/gpt-5.6-sol',
          enabledModels: [
            'openai-codex/gpt-5.6-luna',
            'openai-codex/gpt-5.6-sol',
            'openai-codex/gpt-5.6-terra',
          ],
        }
      : {
          schemaVersion: 1,
          runtime,
          provider: 'anthropic',
          defaultModel: 'anthropic/opus',
          enabledModels: ['anthropic/haiku', 'anthropic/opus', 'anthropic/sonnet'],
        },
  );
}

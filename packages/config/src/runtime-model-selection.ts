import type { Runtime } from './types.js';

export interface RuntimeModelSelectionV1 {
  readonly schemaVersion: 1;
  readonly runtime: Runtime;
  readonly provider: string;
  readonly defaultModel: string;
  readonly enabledModels: readonly string[];
}

export type RuntimeAgentModelClassV1 = 'luna' | 'sol' | 'terra';

export interface RuntimeAgentModelMappingsV1 {
  readonly schemaVersion: 1;
  readonly runtime: Runtime;
  readonly models: Readonly<Record<RuntimeAgentModelClassV1, string>>;
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

function freezeAgentModelMappings(value: RuntimeAgentModelMappingsV1): RuntimeAgentModelMappingsV1 {
  Object.freeze(value.models);
  return Object.freeze(value);
}

/** Validates provider/harness model identifiers supplied to runtime agent translators. */
export function parseRuntimeAgentModelMappingsV1(value: unknown): RuntimeAgentModelMappingsV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('runtime agent model mappings must be an object');
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).sort().join(',') !== ['models', 'runtime', 'schemaVersion'].join(',') ||
    input.schemaVersion !== 1 ||
    (input.runtime !== 'pi' && input.runtime !== 'claude') ||
    typeof input.models !== 'object' ||
    input.models === null ||
    Array.isArray(input.models)
  ) {
    throw new TypeError('runtime agent model mappings have invalid fields');
  }
  const models = input.models as Record<string, unknown>;
  if (
    Object.keys(models).sort().join(',') !== ['luna', 'sol', 'terra'].join(',') ||
    Object.values(models).some(
      (model) => typeof model !== 'string' || model.length === 0 || model.trim() !== model,
    )
  ) {
    throw new TypeError('runtime agent model mappings models are invalid');
  }
  return freezeAgentModelMappings({
    schemaVersion: 1,
    runtime: input.runtime,
    models: {
      luna: models.luna as string,
      sol: models.sol as string,
      terra: models.terra as string,
    },
  });
}

/** Current built-in mappings. They are code-owned and are not user-config schema inputs. */
export function defaultRuntimeAgentModelMappingsV1(
  runtime: 'pi',
): RuntimeAgentModelMappingsV1 & { readonly runtime: 'pi' };
export function defaultRuntimeAgentModelMappingsV1(
  runtime: 'claude',
): RuntimeAgentModelMappingsV1 & { readonly runtime: 'claude' };
export function defaultRuntimeAgentModelMappingsV1(runtime: Runtime): RuntimeAgentModelMappingsV1;
export function defaultRuntimeAgentModelMappingsV1(runtime: Runtime): RuntimeAgentModelMappingsV1 {
  return parseRuntimeAgentModelMappingsV1({
    schemaVersion: 1,
    runtime,
    models:
      runtime === 'pi'
        ? {
            luna: 'openai-codex/gpt-5.6-luna',
            sol: 'openai-codex/gpt-5.6-sol',
            terra: 'openai-codex/gpt-5.6-terra',
          }
        : { luna: 'haiku', sol: 'opus', terra: 'sonnet' },
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
  const mappings = defaultRuntimeAgentModelMappingsV1(runtime);
  return parseRuntimeModelSelectionV1({
    schemaVersion: 1,
    runtime,
    provider: runtime === 'pi' ? 'openai-codex' : 'anthropic',
    defaultModel: runtime === 'pi' ? mappings.models.sol : `anthropic/${mappings.models.sol}`,
    enabledModels: (['luna', 'sol', 'terra'] as const).map((modelClass) =>
      runtime === 'pi' ? mappings.models[modelClass] : `anthropic/${mappings.models[modelClass]}`,
    ),
  });
}

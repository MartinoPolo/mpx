import assert from 'node:assert/strict';
import { test } from 'vitest';
import { getResolvedModelName, withResolvedModelName } from '../../../subagents/invocation-config.js';
import { type ModelEntry, type ModelRegistry, resolveEffectiveModel } from '../../../subagents/model-resolver.js';

const parentModel: ModelEntry = { provider: 'parent', id: 'parent-model', name: 'Parent Model' };
const configuredModel: ModelEntry = {
  provider: 'configured',
  id: 'pinned-model',
  name: 'Pinned Model',
};
const explicitModel: ModelEntry = {
  provider: 'explicit',
  id: 'explicit-model',
  name: 'Explicit Model',
};

function registry(available: ModelEntry[]): ModelRegistry {
  const models: ModelEntry[] = [parentModel, configuredModel, explicitModel];
  return {
    find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
    getAll: () => models,
    getAvailable: () => available,
  };
}

test('resolved model IDs are preserved for display', () => {
  assert.equal(
    getResolvedModelName({ provider: 'anthropic', id: 'claude-sonnet-4-5' }),
    'claude-sonnet-4-5',
  );
  assert.equal(
    getResolvedModelName({ provider: 'openai-codex', id: 'gpt-5.6-sol' }),
    'gpt-5.6-sol',
  );
  assert.equal(getResolvedModelName(undefined), undefined);
});

test('every invocation snapshot includes its actual resolved model', () => {
  assert.deepEqual(
    withResolvedModelName(
      { thinking: 'high', runInBackground: true },
      { provider: 'openai-codex', id: 'gpt-5.6-sol' },
    ),
    {
      modelName: 'gpt-5.6-sol',
      thinking: 'high',
      runInBackground: true,
    },
  );
});

test('explicit model wins over configured and parent models', () => {
  assert.equal(
    resolveEffectiveModel(
      explicitModel,
      parentModel,
      registry([configuredModel]),
      'configured/pinned-model',
    ),
    explicitModel,
  );
});

test('available configured provider/model pin wins over the parent', () => {
  const resolved = resolveEffectiveModel(
    undefined,
    parentModel,
    registry([configuredModel]),
    'configured/pinned-model',
  );
  assert.equal(resolved, configuredModel);
  assert.equal(withResolvedModelName(undefined, resolved).modelName, 'pinned-model');
});

test('configured model pins use the shared fuzzy resolver', () => {
  assert.equal(
    resolveEffectiveModel(undefined, parentModel, registry([configuredModel]), 'pinned.model'),
    configuredModel,
  );
});

test('unavailable configured pin falls back to the parent', () => {
  assert.equal(
    resolveEffectiveModel(undefined, parentModel, registry([]), 'configured/pinned-model'),
    parentModel,
  );
});

test('inherited or missing configuration resolves and displays the parent', () => {
  const models = registry([configuredModel]);
  const inherited = resolveEffectiveModel(undefined, parentModel, models);
  assert.equal(inherited, parentModel);
  assert.equal(withResolvedModelName(undefined, inherited).modelName, 'parent-model');
  assert.equal(
    resolveEffectiveModel(undefined, parentModel, models, 'does-not-exist'),
    parentModel,
  );
});

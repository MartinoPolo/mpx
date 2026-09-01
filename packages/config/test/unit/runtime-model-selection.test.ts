import { describe, expect, it } from 'vitest';
import {
  defaultRuntimeAgentModelMappingsV1,
  defaultRuntimeModelSelectionV1,
  parseRuntimeAgentModelMappingsV1,
  parseRuntimeModelSelectionV1,
} from '../../src/index.js';

describe('runtime model selection', () => {
  it('owns and validates immutable runtime agent model mappings', () => {
    const claude = defaultRuntimeAgentModelMappingsV1('claude');
    const pi = defaultRuntimeAgentModelMappingsV1('pi');
    expect(claude).toEqual({
      schemaVersion: 1,
      runtime: 'claude',
      models: { luna: 'haiku', sol: 'opus', terra: 'sonnet' },
    });
    expect(pi).toEqual({
      schemaVersion: 1,
      runtime: 'pi',
      models: {
        luna: 'openai-codex/gpt-5.6-luna',
        sol: 'openai-codex/gpt-5.6-sol',
        terra: 'openai-codex/gpt-5.6-terra',
      },
    });
    expect(Object.isFrozen(pi)).toBe(true);
    expect(Object.isFrozen(pi.models)).toBe(true);
    expect(parseRuntimeAgentModelMappingsV1(pi)).toEqual(pi);
    for (const invalid of [
      { ...pi, models: { ...pi.models, luna: '' } },
      { ...pi, models: { luna: pi.models.luna, sol: pi.models.sol } },
      { ...pi, models: { ...pi.models, extra: 'model' } },
    ]) {
      expect(() => parseRuntimeAgentModelMappingsV1(invalid)).toThrow(/model mappings/);
    }
  });

  it('owns and validates the immutable current Pi model catalog', () => {
    const selection = defaultRuntimeModelSelectionV1('pi');
    expect(selection).toEqual({
      schemaVersion: 1,
      runtime: 'pi',
      provider: 'openai-codex',
      defaultModel: 'openai-codex/gpt-5.6-sol',
      enabledModels: [
        'openai-codex/gpt-5.6-luna',
        'openai-codex/gpt-5.6-sol',
        'openai-codex/gpt-5.6-terra',
      ],
    });
    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(selection.enabledModels)).toBe(true);
    expect(parseRuntimeModelSelectionV1(selection)).toEqual(selection);
    expect(() => parseRuntimeModelSelectionV1({ ...selection, provider: 'other' })).toThrow(
      /defaultModel/,
    );
  });
});

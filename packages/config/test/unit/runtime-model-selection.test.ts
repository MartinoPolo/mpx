import { describe, expect, it } from 'vitest';
import { defaultRuntimeModelSelectionV1, parseRuntimeModelSelectionV1 } from '../../src/index.js';

describe('runtime model selection', () => {
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

import { expect, it } from 'vitest';
import {
  createPiRuntimeProfileV1,
  parsePiRuntimeProfileV1,
  PiRuntimeProfileError,
} from '../../src/profile.js';

function validProfileInput() {
  return {
    schemaVersion: 1,
    provider: 'openai-codex',
    model: 'gpt-5.6-sol',
    models: ['openai-codex/gpt-5.6-luna', 'openai-codex/gpt-5.6-sol'],
    thinking: 'medium',
    theme: 'dark',
    tuiMode: 'fullscreen',
    terminalProgress: false,
    trust: 'ask',
    capabilityIds: ['model-search'],
  };
}

it('rejects malformed runtime profiles with a stable Pi diagnostic', () => {
  const malformed = [
    { ...validProfileInput(), schemaVersion: 2 },
    { ...validProfileInput(), provider: '' },
    { ...validProfileInput(), model: '' },
    { ...validProfileInput(), models: ['anthropic/gpt-5.6-sol'] },
    {
      ...validProfileInput(),
      models: ['openai-codex/', 'openai-codex/gpt-5.6-sol'],
    },
    {
      ...validProfileInput(),
      models: ['openai-codex/gpt-5.6-sol', 'openai-codex/gpt-5.6-sol'],
    },
    { ...validProfileInput(), models: ['openai-codex/gpt-5.6-luna'] },
    { ...validProfileInput(), capabilityIds: [''] },
    { ...validProfileInput(), capabilityIds: ['model-search', 'model-search'] },
  ];

  for (const value of malformed) {
    expect(() => parsePiRuntimeProfileV1(value)).toThrowError(
      expect.objectContaining({
        constructor: PiRuntimeProfileError,
        code: 'PI_RUNTIME_PROFILE_INVALID',
        message: 'Pi runtime profile is invalid.',
      }),
    );
  }
});

it('returns an immutable copy that cannot be changed through mutable input aliases', () => {
  const input = validProfileInput();
  const parsed = parsePiRuntimeProfileV1(input);
  input.models[0] = 'openai-codex/changed';
  input.capabilityIds[0] = 'changed';

  expect(parsed.models[0]).toBe('openai-codex/gpt-5.6-luna');
  expect(parsed.capabilityIds[0]).toBe('model-search');
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.models)).toBe(true);
  expect(Object.isFrozen(parsed.capabilityIds)).toBe(true);
});

it('parses a valid serialized profile without changing its value', () => {
  const input = validProfileInput();
  expect(parsePiRuntimeProfileV1(JSON.parse(JSON.stringify(input)))).toEqual(input);
});

it('translates supplied model selection into an immutable account-safe profile', () => {
  const profile = createPiRuntimeProfileV1(
    {
      schemaVersion: 1,
      runtime: 'pi',
      provider: 'openai-codex',
      defaultModel: 'openai-codex/gpt-5.6-sol',
      enabledModels: [
        'openai-codex/gpt-5.6-luna',
        'openai-codex/gpt-5.6-sol',
        'openai-codex/gpt-5.6-terra',
      ],
    },
    [],
  );
  expect(profile).toMatchObject({
    schemaVersion: 1,
    provider: 'openai-codex',
    model: 'gpt-5.6-sol',
    thinking: 'medium',
    theme: 'dark',
    tuiMode: 'fullscreen',
    terminalProgress: false,
    trust: 'ask',
  });
  expect(profile.models).toEqual([
    'openai-codex/gpt-5.6-luna',
    'openai-codex/gpt-5.6-sol',
    'openai-codex/gpt-5.6-terra',
  ]);
  expect(profile.capabilityIds).toEqual([]);
  expect(Object.hasOwn(profile, 'nativeState')).toBe(false);
  expect(JSON.stringify(profile)).not.toMatch(/auth|credential|sessionDir|accountRoot|jwt/iu);
  expect(Object.isFrozen(profile)).toBe(true);
});

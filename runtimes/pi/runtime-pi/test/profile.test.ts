import { expect, it } from 'vitest';
import { createPiRuntimeProfileV1 } from '../src/profile.js';

it('publishes an immutable account-safe Sol profile without native state', () => {
  const profile = createPiRuntimeProfileV1();
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
  expect(profile.nativeState).toBeUndefined();
  expect(JSON.stringify(profile)).not.toMatch(/auth|credential|sessionDir|accountRoot|jwt/iu);
  expect(Object.isFrozen(profile)).toBe(true);
  expect(() => {
    (profile.keybindings as Record<string, unknown>)['x'] = 'y';
  }).toThrow();
});

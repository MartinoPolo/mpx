import { describe, expect, it } from 'vitest';
import { MpxError, serializePublicError } from './errors.js';

describe('public errors', () => {
  it('serializes declared safe fields', () => {
    const error = new MpxError({
      code: 'NO_TOOL',
      message: 'Unavailable',
      retryable: true,
      capability: 'git',
      remediation: 'Install it',
      details: { attempt: 1 },
    });
    expect(serializePublicError(error)).toEqual({
      code: 'NO_TOOL',
      message: 'Unavailable',
      retryable: true,
      capability: 'git',
      remediation: 'Install it',
      details: { attempt: 1 },
    });
    expect(serializePublicError(error)).not.toHaveProperty('stack');
  });
  it.each([new Error('secret'), 'secret', { message: 'secret', stack: 'secret stack' }, null])(
    'never leaks unknown thrown values',
    (error) => {
      const serialized = serializePublicError(error);
      expect(serialized).toEqual({
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred.',
        retryable: false,
      });
      expect(JSON.stringify(serialized)).not.toContain('secret');
    },
  );
});

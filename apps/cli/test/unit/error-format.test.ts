import { describe, expect, it } from 'vitest';
import type { PublicError } from '@mpx/core';
import { formatHumanError } from '../../src/error-format.js';

function publicError(overrides: Partial<PublicError> = {}): PublicError {
  return {
    code: 'UNKNOWN_FAILURE',
    message: 'Something failed.',
    retryable: false,
    ...overrides,
  };
}

describe('human CLI error formatting', () => {
  it('preserves the error and remediation while providing fallback guidance', () => {
    const error = publicError({ remediation: 'Operation-specific recovery instruction.' });
    const output = formatHumanError(error);

    expect(output).toContain(`ERROR [${error.code}] - ${error.message}`);
    expect(output).toContain('POSSIBLE SOLUTIONS/WORKAROUNDS');
    expect(output).toContain(error.remediation);
    expect(output).toContain('mpx help --all');
  });

  it('removes terminal control characters from error fields', () => {
    const output = formatHumanError(
      publicError({
        code: 'BAD\u001b[31m_CODE',
        message: 'Bad\u001b[31m\nreason\u009b31m',
        remediation: 'Try\r\nthis\u0007 now',
      }),
    );

    expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
    expect(output).toContain('Try this now');
  });

  it('preserves supplied usage help without duplicating it as the reason', () => {
    const usage = 'Usage: example command\nExample options';
    const output = formatHumanError(
      publicError({ code: 'USAGE_ERROR', message: usage }),
      `${usage}\n`,
    );

    expect(output.split(usage)).toHaveLength(2);
  });
});

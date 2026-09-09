import { describe, expect, it, vi } from 'vitest';
import { ContentCompilerError } from '@mpx/content-compiler';
import type { PublicError } from '@mpx/core';
import { formatHumanError } from '../../src/error-format.js';
import { captureIo } from '../../src/io.js';
import { run } from '../../src/main.js';

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

  it('renders only structured configuration pointer and reason details safely', () => {
    const output = formatHumanError(
      publicError({
        code: 'CONFIG_INVALID',
        details: {
          errors: [
            {
              pointer: '/locations/work\u001b[31m/roots/0',
              keyword: 'semantic',
              reason: 'requires unavailable\n environment root MPX_WORK',
              value: 'C:/private/SECRET_VALUE',
            },
          ],
          arbitrary: 'DO_NOT_RENDER',
        },
      }),
    );

    expect(output).toContain(
      '/locations/work/roots/0: requires unavailable environment root MPX_WORK',
    );
    expect(output).not.toContain('SECRET_VALUE');
    expect(output).not.toContain('DO_NOT_RENDER');
    expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
  });

  it('styles only commands when terminal color is enabled', () => {
    const output = formatHumanError(publicError({ code: 'PROJECT_REQUIRED' }), undefined, {
      color: true,
    });

    expect(output).toContain('\u001b[1;36m--mode developer\u001b[0m - Append to the original');
    expect(output).toContain('\u001b[1;36mmpx init\u001b[0m - Preview project initialization');
    expect(output).toContain('\u001b[1;36mmpx init --confirm\u001b[0m - Only if you choose');
    expect(output).toContain('\u001b[1;36m--cwd <project-root>\u001b[0m - Append to the original');
    expect(output).not.toContain('\u001b[1;36mAppend to the original');
  });

  it('preserves supplied usage help without duplicating it as the reason', () => {
    const usage = 'Usage: example command\nExample options';
    const output = formatHumanError(
      publicError({ code: 'USAGE_ERROR', message: usage }),
      `${usage}\n`,
    );

    expect(output.split(usage)).toHaveLength(2);
  });

  it('reports compiler failures with a stable public code and sanitized guidance', async () => {
    const io = captureIo();
    const onInternalError = vi.fn();
    const execute = vi.fn(async () => {
      throw new ContentCompilerError(
        'unresolved canonical reference C:\\private\\catalog\\skills\\broken.md\nfrom selected pack',
      );
    });

    expect(
      await run(['setup'], io, {
        env: {},
        onInternalError,
        setupService: { execute },
      } as never),
    ).toBe(1);

    const output = io.err.join('');
    expect(output).toContain(
      'ERROR [CONTENT_COMPILATION_FAILED] - unresolved canonical reference [path] from selected pack',
    );
    expect(output).toContain('Fix the canonical content reference or selected pack dependency');
    expect(output).toContain(
      'rebuild or reinstall the managed release, then retry the original MPX launcher',
    );
    expect(output).not.toContain('COMMAND_FAILED');
    expect(output).not.toContain('C:\\private');
    expect(onInternalError).not.toHaveBeenCalled();
  });
});

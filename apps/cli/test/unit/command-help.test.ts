import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { run } from '../../src/main.js';
import { captureIo } from '../../src/io.js';
import {
  commandRegistry,
  renderBasicReference,
  renderCompleteReference,
  renderRootHelp,
} from '../../src/command-metadata.js';

describe('CLI help', () => {
  it('prints concise root help successfully when invoked without arguments', async () => {
    const io = captureIo();

    expect(await run([], io, { env: {} })).toBe(0);
    expect(io.err).toEqual([]);
    expect(io.out.join('')).toContain('Usage: mpx [options] <command>');
    expect(io.out.join('')).toContain('Common commands:');
  });

  it.each([['--help'], ['-h']])('prints root help successfully for %s', async (...args) => {
    const io = captureIo();

    expect(await run(args, io, { env: {} })).toBe(0);
    expect(io.err).toEqual([]);
    expect(io.out.join('')).toContain('Common commands:');
  });

  it('prints focused help with at most ten actions for an incomplete command group', async () => {
    const io = captureIo();

    expect(await run(['session'], io, { env: {} })).toBe(0);
    const output = io.out.join('');
    expect(output).toContain('Usage: mpx session <action> [options]');
    const actionLines = output
      .split('\n')
      .filter((line) => /^  \S/u.test(line) && !line.includes("Run '"));
    expect(actionLines.length).toBeLessThanOrEqual(10);
  });

  it('prints focused group help successfully for bare config', async () => {
    const io = captureIo();

    expect(await run(['config'], io, { env: {} })).toBe(0);
    expect(io.err).toEqual([]);
    expect(io.out.join('')).toContain('Usage: mpx config <action> [options]');
    expect(io.out.join('')).toContain('Common actions:');
  });

  it('validates scoped options on an incomplete command group instead of rendering help', async () => {
    const io = captureIo();

    expect(await run(['config', '--runtime-arg=--print'], io, { env: {} })).toBe(1);
    expect(io.out).toEqual([]);
    expect(io.err.join('')).toContain('RUNTIME_ARGS_SCOPE_INVALID');
    expect(io.err.join('')).not.toContain('Usage: mpx config');
  });

  it.each(commandRegistry.filter((group) => group.defaultOperation))(
    'keeps the bare $name operation unambiguous',
    (group) => {
      expect(group.actions).toEqual([]);
    },
  );

  it('marks exactly the implemented bare commands as default operations', () => {
    expect(
      commandRegistry.filter((group) => group.defaultOperation).map((group) => group.name),
    ).toEqual(['init', 'status', 'doctor', 'setup', 'help']);
  });

  it('prints bare setup usage without suggesting an action', async () => {
    const io = captureIo();

    expect(await run(['setup', '--help'], io, { env: {} })).toBe(0);
    const output = io.out.join('');
    expect(output).toContain('Usage: mpx setup');
    expect(output).not.toContain('<action>');
  });

  it('prints the complete terminal inventory for help --all', async () => {
    const io = captureIo();

    expect(await run(['help', '--all'], io, { env: {} })).toBe(0);
    expect(io.out.join('')).toContain('All commands:');
    expect(io.out.join('')).toContain('migration rollback-drill');
  });

  it('prints command-specific help for a recognized leaf command', async () => {
    const io = captureIo();

    expect(await run(['issue', 'view', '--help'], io, { env: {} })).toBe(0);
    expect(io.out.join('')).toContain('Usage: mpx issue view --id <id>');
  });

  it('gives missing leaf operands concise command-specific guidance', async () => {
    const io = captureIo();

    expect(await run(['provider', 'explain'], io, { env: {} })).toBe(2);
    expect(io.err.join('')).toContain('provider explain requires repository or issues');
    expect(io.err.join('')).toContain('Usage: mpx provider explain <repository|issues>');
    expect(io.err.join('')).not.toContain('Common commands:');
  });

  it('keeps unknown commands as structured JSON usage errors', async () => {
    const io = captureIo();

    expect(await run(['--json', 'unknown'], io, { env: {} })).toBe(2);
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      ok: false,
      error: { code: 'USAGE_ERROR', message: 'Unknown command: unknown' },
    });
  });

  it('bounds rendered root progressive disclosure and advertises active content inspection', () => {
    const rootCommandLines = renderRootHelp()
      .split('\n')
      .filter((line) => /^  [a-z][a-z-]*\s{2,}/u.test(line));

    expect(rootCommandLines.length).toBeLessThan(30);
    expect(rootCommandLines.some((line) => line.trimStart().startsWith('content '))).toBe(true);
  });

  it('includes a concise set of registered examples in the basic generated reference', () => {
    const reference = renderBasicReference();
    for (const example of [
      'mpx launch explain --identity work',
      'mpx session resume abc123',
      'mpx issue view --id 123',
    ]) {
      expect(reference).toContain(`- \`${example}\``);
    }
    const examplesSection = reference.split('## Examples\n\n')[1]!.split('\n\n')[0]!;
    expect(examplesSection.split('\n')).toHaveLength(3);
  });

  it('keeps both generated CLI references synchronized with the typed registry', async () => {
    const shared = fileURLToPath(
      new URL('../../../../content/instructions/shared/', import.meta.url),
    );

    await expect(readFile(`${shared}/MPX_CLI_BASIC.md`, 'utf8')).resolves.toBe(
      renderBasicReference(),
    );
    await expect(readFile(`${shared}/MPX_CLI_REFERENCE.md`, 'utf8')).resolves.toBe(
      renderCompleteReference(),
    );
  });
});

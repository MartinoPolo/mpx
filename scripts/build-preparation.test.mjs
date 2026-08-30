import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { commandSelectorBytes } from './windows-command.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readPackage = async (relativePath) =>
  JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));
const executeFile = promisify(execFile);

describe('CLI build preparation', () => {
  it('keeps the CLI package as the only workspace selected by --filter mpx', async () => {
    const [workspace, cli] = await Promise.all([
      readPackage('package.json'),
      readPackage('apps/cli/package.json'),
    ]);

    expect(cli.name).toBe('mpx');
    expect(workspace.name).not.toBe(cli.name);
  });

  it('builds CLI workspace dependencies before compiling the CLI', async () => {
    const cli = await readPackage('apps/cli/package.json');

    expect(cli.scripts.prebuild).toBe('node ../../scripts/prepare-cli-build.mjs');
  });

  it('uses exact pinned workspace tooling to emit a release-contained CLI bundle', async () => {
    const [workspace, cli] = await Promise.all([
      readPackage('package.json'),
      readPackage('apps/cli/package.json'),
    ]);

    expect(workspace.devDependencies.esbuild).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(cli.scripts.build).toContain('bundle-cli.mjs');
  });

  it('enforces repository-local LF text and CRLF command attributes regardless of global conversion', async () => {
    const { stdout } = await executeFile(
      'git',
      [
        '-c',
        'core.autocrlf=true',
        'check-attr',
        'text',
        'eol',
        '--',
        'README.md',
        'bin/mpx.cmd',
        'fixture.png',
        'fixture.exe',
        'fixture.woff2',
      ],
      { cwd: root },
    );
    expect(stdout.replaceAll('\\', '/').trim().split(/\r?\n/u)).toEqual([
      'README.md: text: auto',
      'README.md: eol: lf',
      'bin/mpx.cmd: text: set',
      'bin/mpx.cmd: eol: crlf',
      'fixture.png: text: unset',
      'fixture.png: eol: unspecified',
      'fixture.exe: text: unset',
      'fixture.exe: eol: unspecified',
      'fixture.woff2: text: unset',
      'fixture.woff2: eol: unspecified',
    ]);
  });

  it('matches EditorConfig line endings and emits CRLF-only command bytes without a BOM', async () => {
    const editorConfig = await readFile(path.join(root, '.editorconfig'), 'utf8');
    expect(editorConfig).toMatch(/end_of_line = lf/u);
    expect(editorConfig).toMatch(/\[\*\.\{bat,cmd\}\][\s\S]*end_of_line = crlf/u);
    const bytes = await readFile(path.join(root, 'bin', 'mpx.cmd'));
    expect(bytes).toEqual(commandSelectorBytes());
    expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.toString('utf8');
    expect(text).not.toMatch(/(^|[^\r])\n/u);
    expect(text).toContain('\r\n');
  });
});

import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { inventoryCanonical } from '../../src/index.js';

const root = path.resolve(import.meta.dirname, '../../../../content/skills');

async function personalIdentities(): Promise<string[]> {
  return (await inventoryCanonical(root))
    .filter(({ skillPacks }) => skillPacks.includes('personal'))
    .map(({ identity }) => identity);
}

async function files(identity: string): Promise<string[]> {
  return (await readdir(path.join(root, identity), { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe('personal skill safety', () => {
  it('keeps PowerShell, Node, and Python support files syntactically valid', async () => {
    const failures: string[] = [];
    for (const identity of await personalIdentities()) {
      for (const file of await files(identity)) {
        let result;
        if (/\.(?:m?js)$/u.test(file)) {
          result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
        } else if (file.endsWith('.py')) {
          result = spawnSync('python', ['-m', 'py_compile', file], {
            encoding: 'utf8',
            env: { ...process.env, PYTHONPYCACHEPREFIX: path.join(tmpdir(), 'mpx-c6-pycache') },
          });
        } else if (file.endsWith('.ps1')) {
          result = spawnSync(
            'powershell',
            [
              '-NoProfile',
              '-Command',
              `$errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file.replaceAll("'", "''")}', [ref]$null, [ref]$errors); if ($errors.Count) { exit 1 }`,
            ],
            { encoding: 'utf8' },
          );
        }
        if (result && result.status !== 0) failures.push(path.relative(root, file));
      }
    }
    expect(failures).toEqual([]);
  }, 30_000);

  it('contains no personal absolute paths, usernames, embedded secrets, or legacy root fallbacks', async () => {
    const violations: string[] = [];
    const forbidden: Array<[string, RegExp]> = [
      [
        'absolute personal path',
        /(?:\b[A-Za-z]:[\\/](?:Users|_MP_projects|_MP_work|_MP_apps)[\\/]|\/(?:Users|home|_MP_projects|_MP_work|_MP_apps)\/)/iu,
      ],
      ['personal username', /\bsnapy\b/iu],
      ['native runtime state', /(?:~[\\/]|[\\/])\.(?:claude|runtime|pi)[\\/]/iu],
      [
        'embedded secret',
        /(?:passphrase|password|api[_-]?key|token)\s*[=:]\s*["'](?!<)[^"']{4,}["']/iu,
      ],
      ['legacy AI root fallback', /process\.env\.TUTORIALS_ROOT/iu],
    ];
    for (const identity of await personalIdentities()) {
      for (const file of await files(identity)) {
        const content = await readFile(file, 'utf8');
        for (const [kind, pattern] of forbidden) {
          if (pattern.test(content)) violations.push(`${path.relative(root, file)}: ${kind}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

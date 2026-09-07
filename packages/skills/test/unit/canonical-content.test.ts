import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { inventoryCanonical } from '../../src/index.js';

const canonicalRoot = path.resolve(import.meta.dirname, '../../../../content/skills');

async function files(identity: string): Promise<string[]> {
  return (
    await readdir(path.join(canonicalRoot, identity), { recursive: true, withFileTypes: true })
  )
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe('canonical content safety', () => {
  it('contains no personal absolute paths, usernames, or embedded secrets', async () => {
    const violations: string[] = [];
    const forbidden: Array<[string, RegExp]> = [
      [
        'absolute personal path',
        /(?:\b[A-Za-z]:[\\/](?:Users|_MP_projects|_MP_work|_MP_apps)[\\/]|\/(?:Users|home|_MP_projects|_MP_work|_MP_apps)\/)/iu,
      ],
      ['personal username', /\bsnapy\b/iu],
      [
        'embedded secret',
        /(?:passphrase|password|api[_-]?key|token)\s*[=:]\s*["'](?!<)[^"']{4,}["']/iu,
      ],
    ];
    for (const { identity } of await inventoryCanonical(canonicalRoot)) {
      for (const file of await files(identity)) {
        const content = await readFile(file, 'utf8');
        for (const [kind, pattern] of forbidden) {
          if (pattern.test(content))
            violations.push(`${path.relative(canonicalRoot, file)}: ${kind}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

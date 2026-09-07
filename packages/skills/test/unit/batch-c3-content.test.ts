import { describe, expect, it } from 'vitest';
import { readFile, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { inventoryCanonical } from '../../src/index.js';

const root = path.resolve(import.meta.dirname, '../../../../content/skills');
const instructions = path.resolve(import.meta.dirname, '../../../../content/instructions');

async function files(identity: string): Promise<string[]> {
  const directory = path.join(root, identity);
  return (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

async function identities(): Promise<string[]> {
  return (await inventoryCanonical(root)).map(({ identity }) => identity);
}

function projectedReference(file: string, reference: string): string | undefined {
  const sourceRelative = path.relative(root, file).split(path.sep).join('/');
  const normalized = path.posix.normalize(
    path.posix.join(path.posix.dirname(sourceRelative), reference.replaceAll('\\', '/')),
  );
  if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    return undefined;
  }
  if (normalized.startsWith('shared/')) {
    return path.join(instructions, normalized);
  }
  return path.join(root, ...normalized.split('/'));
}

describe('canonical support assets', () => {
  it('keeps every JavaScript support script syntactically valid', async () => {
    for (const identity of await identities()) {
      for (const file of await files(identity)) {
        if (!/\.(?:m?js)$/u.test(file)) {
          continue;
        }
        const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
        expect(result.status, `${path.relative(root, file)}: ${result.stderr}`).toBe(0);
      }
    }
  });

  it('closes relative Markdown references without allowing path escape', async () => {
    const violations: string[] = [];
    for (const identity of await identities()) {
      for (const file of await files(identity)) {
        if (!file.endsWith('.md')) {
          continue;
        }
        const content = await readFile(file, 'utf8');
        for (const match of content.matchAll(
          /\[[^\]]*\]\((?!https?:|file:|#)([^)#]+)(?:#[^)]+)?\)/gu,
        )) {
          const reference = match[1];
          if (!reference) {
            continue;
          }
          const candidate = projectedReference(file, reference);
          if (!candidate) {
            violations.push(`${path.relative(root, file)} -> ${reference}: path escape`);
            continue;
          }
          try {
            await stat(candidate);
          } catch {
            violations.push(`${path.relative(root, file)} -> ${reference}: missing`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

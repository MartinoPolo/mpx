import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repositoryFiles } from '../../../scripts/validate-generated.mjs';

describe('generated gateway validation', () => {
  it('gives the tracked generated gateway artifact the generated-bundle read bound', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-generated-gateway-limit-'));
    await mkdir(path.join(root, 'bin'));
    const oversized = Buffer.alloc(1024 * 1024 + 1, 97);
    await writeFile(path.join(root, 'bin', 'claude-gateway.js'), oversized);
    try {
      const values = await repositoryFiles(root, ['bin/claude-gateway.js'], {
        trackedFiles: ['bin/claude-gateway.js'],
      });
      expect(values.get('bin/claude-gateway.js')?.length).toBe(oversized.length);
      expect([...values.diagnostics]).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

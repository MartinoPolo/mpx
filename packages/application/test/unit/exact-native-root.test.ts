import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExactNativeRootVerifier } from '../../src/node/exact-native-root.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

async function fixture(): Promise<string> {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'mpx-native-root-'));
  roots.push(parent);
  const root = path.join(parent, 'root');
  await mkdir(root);
  return root;
}

describe('ExactNativeRootVerifier', () => {
  it('accepts an exact configured real directory without returning persisted authority', async () => {
    const root = await fixture();
    await expect(new ExactNativeRootVerifier().verify(root)).resolves.toBeUndefined();
  });

  it('rejects symlink indirection', async () => {
    const root = await fixture();
    const linked = path.join(path.dirname(root), 'linked');
    await symlink(root, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(new ExactNativeRootVerifier().verify(linked)).rejects.toMatchObject({
      code: 'NATIVE_ROOT_INVALID',
    });
  });

  it('fails closed when the configured path drifts during verification', async () => {
    const root = await fixture();
    const realpath = vi.fn().mockResolvedValueOnce(root).mockResolvedValueOnce(`${root}-changed`);
    await expect(new ExactNativeRootVerifier({ realpath }).verify(root)).rejects.toMatchObject({
      code: 'NATIVE_ROOT_INVALID',
    });
    expect(realpath).toHaveBeenCalledTimes(2);
  });
});

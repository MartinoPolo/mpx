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

  it('rejects a symlink or reparse point that appears late in verification', async () => {
    const root = await fixture();
    const actual = await import('node:fs/promises').then((fs) => fs.lstat(root));
    const linked = Object.create(actual) as typeof actual;
    linked.isSymbolicLink = () => true;
    const lstat = vi
      .fn()
      .mockResolvedValueOnce(actual)
      .mockResolvedValueOnce(actual)
      .mockResolvedValueOnce(actual)
      .mockResolvedValueOnce(linked);

    await expect(new ExactNativeRootVerifier({ lstat }).verify(root)).rejects.toMatchObject({
      code: 'NATIVE_ROOT_INVALID',
    });
    expect(lstat).toHaveBeenCalledTimes(4);
  });

  it('rejects device or inode identity drift during verification', async () => {
    const root = await fixture();
    const actual = await import('node:fs/promises').then((fs) => fs.lstat(root));
    const changed = Object.create(actual) as typeof actual;
    Object.defineProperties(changed, {
      dev: { value: Number(actual.dev) + 1 },
      ino: { value: Number(actual.ino) + 1 },
    });
    const lstat = vi
      .fn()
      .mockResolvedValueOnce(actual)
      .mockResolvedValueOnce(actual)
      .mockResolvedValueOnce(changed)
      .mockResolvedValueOnce(changed);

    await expect(new ExactNativeRootVerifier({ lstat }).verify(root)).rejects.toMatchObject({
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

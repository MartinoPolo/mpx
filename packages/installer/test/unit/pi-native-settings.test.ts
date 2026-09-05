import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { EnvironmentPiPrivateRootResolver, NodePiNativeSettingsPort } from '../../src/index.js';

it('atomically writes and removes settings through the native port', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mpx-pi-native-port-'));
  try {
    const target = path.join(temporary, 'settings.json');
    const port = new NodePiNativeSettingsPort();
    await port.atomicWrite(target, Buffer.from('{"packages":[]}\n'));
    expect(await readFile(target, 'utf8')).toBe('{"packages":[]}\n');
    await port.remove(target);
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

it('exposes lock contention as ELOCKED without relabeling other lock failures', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mpx-pi-native-lock-'));
  try {
    const target = path.join(temporary, 'settings.json');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, '{}\n');
    const port = new NodePiNativeSettingsPort();
    const held = await port.lock(target);
    try {
      await expect(port.lock(target)).rejects.toMatchObject({ code: 'ELOCKED' });
      expect(held.compromisedFailure()).toBeUndefined();
    } finally {
      await held.release();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

it('resolves only explicitly configured private roots by Pi identity', async () => {
  const resolver = new EnvironmentPiPrivateRootResolver({
    MPX_PI_PERSONAL_ROOT: 'C:\\private\\pi-personal',
  });
  await expect(resolver.resolvePiNativeRoot('pi-personal')).resolves.toBe(
    'C:\\private\\pi-personal',
  );
  await expect(resolver.resolvePiNativeRoot('pi-work')).resolves.toBeUndefined();
});

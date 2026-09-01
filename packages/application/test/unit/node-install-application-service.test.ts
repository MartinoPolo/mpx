import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createNodeInstallProtocolInput } from '../../src/node/install-application-service.js';

async function temporary(name: string): Promise<string> {
  return path.join(await mkdtemp(path.join(tmpdir(), 'mpx-application-install-')), name);
}

it.each([
  ['non-file', async () => path.dirname(await temporary('unused'))],
  [
    'oversize file',
    async () => {
      const file = await temporary('large.json');
      await writeFile(file, Buffer.alloc(1024 * 1024 + 1));
      return file;
    },
  ],
  ['unreadable file', async () => temporary('missing.json')],
] as const)('translates an unsafe or unreadable %s', async (_name, source) => {
  await expect(createNodeInstallProtocolInput().evidence(await source())).rejects.toMatchObject({
    code: 'INSTALL_INPUT_UNREADABLE',
    message: 'Install protocol input is unreadable.',
  });
});

it('rejects symbolic-link protocol files', async () => {
  const target = await temporary('target.json');
  const link = `${target}.link`;
  await writeFile(target, '{}');
  await symlink(target, link, 'file');
  await expect(createNodeInstallProtocolInput().evidence(link)).rejects.toMatchObject({
    code: 'INSTALL_INPUT_UNREADABLE',
  });
});

it('uses strict JSON parsing for protocol files', async () => {
  const file = await temporary('duplicate.json');
  await writeFile(file, '{"value":1,"value":2}');
  await expect(createNodeInstallProtocolInput().evidence(file)).rejects.toMatchObject({
    code: 'INSTALL_INPUT_UNREADABLE',
    message: 'Install protocol input is unreadable.',
  });
});

it('treats only trimmed object JSON as inline and bounds the original UTF-8 bytes', async () => {
  const input = createNodeInstallProtocolInput();
  await expect(input.request('  {"kind":"request"}')).resolves.toEqual({ kind: 'request' });
  await expect(input.request(`  {"value":"${'x'.repeat(1024 * 1024)}"}`)).rejects.toMatchObject({
    code: 'INSTALL_USAGE_ERROR',
    message: '--request JSON exceeds the 1 MiB protocol bound',
  });
});

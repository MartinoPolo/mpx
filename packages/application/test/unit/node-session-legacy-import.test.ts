import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeSessionLegacyImport } from '@mpx/application/node';
import { SessionStore } from '@mpx/sessions';

const identity = { domain: 'personal', name: 'me' } as const;
const temporaryRoots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-node-legacy-import-'));
  temporaryRoots.push(root);
  const store = new SessionStore(path.join(root, 'state'));
  const now = new Date().toISOString();
  await store.saveNativeBinding({
    schemaVersion: 1,
    ref: 'claude-binding',
    identity,
    runtime: 'claude',
    recordedRootDigest: 'a'.repeat(64),
    accountBindingRef: null,
    createdAt: now,
    updatedAt: now,
  });
  const adapter = createNodeSessionLegacyImport({
    store,
    resolveIdentity: async () => identity,
  });
  const request = (source: string) => ({
    sources: [source],
    accountMappings: [{ source: 'legacy-account', identity: 'me' }],
    piRootMappings: [],
  });
  return { root, adapter, request };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('createNodeSessionLegacyImport filesystem safety', () => {
  it('rejects a symlink source', async () => {
    const { root, adapter, request } = await fixture();
    const target = path.join(root, 'legacy-target.json');
    const linked = path.join(root, 'legacy-linked.json');
    await writeFile(target, JSON.stringify({ schemaVersion: 2, savedAt: null, sessions: [] }));
    await symlink(target, linked, 'file');

    await expect(adapter.plan(request(linked))).rejects.toMatchObject({
      code: 'LEGACY_SOURCE_UNSAFE',
    });
  });

  it('rejects a .json directory entry that is not a regular file', async () => {
    const { root, adapter, request } = await fixture();
    const source = path.join(root, 'registry');
    await mkdir(path.join(source, 'nested.json'), { recursive: true });

    await expect(adapter.plan(request(source))).rejects.toMatchObject({
      code: 'LEGACY_SOURCE_UNSAFE',
    });
  });

  it('rejects a directory over the allowed entry bound', async () => {
    const { root, adapter, request } = await fixture();
    const source = path.join(root, 'registry');
    await mkdir(source);
    await Promise.all(
      Array.from({ length: 129 }, (_, index) =>
        writeFile(path.join(source, `${index.toString().padStart(3, '0')}.json`), '{}'),
      ),
    );

    await expect(adapter.plan(request(source))).rejects.toMatchObject({
      code: 'LEGACY_SOURCE_LIMIT',
    });
  });
});

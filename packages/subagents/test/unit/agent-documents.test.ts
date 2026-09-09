import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentCatalogError } from '../../src/index.js';
import {
  AgentDocumentError,
  loadCanonicalAgentProjectionInputs,
  renderCanonicalAgentDocument,
} from '@mpx/subagents/documents';

const metadata = (identities: string[]) =>
  JSON.stringify({
    schemaVersion: 1,
    agents: Object.fromEntries(
      identities.map((identity) => [
        identity,
        {
          modelClass: 'standard',
          thinking: 'low',
          capabilities: ['read'],
          nesting: [],
          outputSchema: 'text',
        },
      ]),
    ),
  });
async function fixture(document: string | Uint8Array, identity = 'mpx-alpha') {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-documents-'));
  await writeFile(path.join(root, `${identity}.md`), document);
  await writeFile(path.join(root, 'metadata.json'), metadata([identity]));
  return root;
}
async function supportsSymlinkType(type: 'file' | 'junction'): Promise<boolean> {
  const root = await mkdtemp(path.join(tmpdir(), `agent-documents-${type}-probe-`));
  const target = path.join(root, 'target');
  const link = path.join(root, 'link');
  try {
    if (type === 'file') {
      await writeFile(target, 'probe');
    } else {
      await mkdir(target);
    }
    await symlink(target, link, type);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
      return false;
    }
    throw error;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const supportsFileSymlink = await supportsSymlinkType('file');
const supportsJunction = await supportsSymlinkType('junction');

describe('canonical agent documents', () => {
  it.each([
    ['LF', '---\nname: mpx-alpha\ndescription: café 漢字\n---\nbody\0bytes'],
    ['CRLF', '---\r\nname: mpx-alpha\r\ndescription: café 漢字\r\n---\r\nbody'],
  ])('parses %s without normalizing canonical bytes', async (_label, source) => {
    const loaded = await loadCanonicalAgentProjectionInputs(await fixture(source));
    const rendered = renderCanonicalAgentDocument(loaded.entries[0]!.document, {
      name: 'Alias',
      fields: [{ name: 'model', value: 'sonnet' }],
    });
    expect(Buffer.from(rendered).toString()).toBe(
      source
        .replace('mpx-alpha', 'Alias')
        .replace(/(\r?\n)---(\r?\n)/u, '$1model: sonnet$1$1---$2'),
    );
  });

  it('allows an empty canonical agent directory without metadata when explicitly requested', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-documents-empty-'));

    await expect(
      loadCanonicalAgentProjectionInputs(root, { allowMissingMetadata: true }),
    ).resolves.toEqual({ schemaVersion: 1, entries: [], supportFiles: [] });
  });

  it('reports structured missing identities when metadata is optional but agents exist', async () => {
    const root = await fixture('---\nname: mpx-alpha\n---\n');
    await rm(path.join(root, 'metadata.json'));

    await expect(
      loadCanonicalAgentProjectionInputs(root, { allowMissingMetadata: true }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AgentCatalogError>>({
        code: 'AGENT_CATALOG_COVERAGE_INVALID',
        missingIdentities: ['mpx-alpha'],
        unexpectedIdentities: [],
      }),
    );
  });

  it('reports a metadata directory with a structured file error and exact path', async () => {
    const root = await fixture('---\nname: mpx-alpha\n---\n');
    const metadataPath = path.join(root, 'metadata.json');
    await rm(metadataPath);
    await mkdir(metadataPath);

    await expect(loadCanonicalAgentProjectionInputs(root)).rejects.toMatchObject({
      name: 'AgentDocumentError',
      code: 'AGENT_METADATA_FILE_INVALID',
      path: metadataPath,
      message: 'metadata must be a regular non-symlink file',
    });
  });

  it.skipIf(!supportsFileSymlink)(
    'reports a metadata symlink with a structured file error and exact path',
    async () => {
      const root = await fixture('---\nname: mpx-alpha\n---\n');
      const metadataPath = path.join(root, 'metadata.json');
      const target = path.join(root, 'metadata-target.json');
      await rm(metadataPath);
      await writeFile(target, metadata(['mpx-alpha']));
      await symlink(target, metadataPath, 'file');

      await expect(loadCanonicalAgentProjectionInputs(root)).rejects.toMatchObject({
        name: 'AgentDocumentError',
        code: 'AGENT_METADATA_FILE_INVALID',
        path: metadataPath,
        message: 'metadata must be a regular non-symlink file',
      });
    },
  );

  it.skipIf(!supportsJunction)(
    'reports a metadata junction with a structured file error and exact path',
    async () => {
      const root = await fixture('---\nname: mpx-alpha\n---\n');
      const metadataPath = path.join(root, 'metadata.json');
      const target = path.join(root, 'metadata-target');
      await rm(metadataPath);
      await mkdir(target);
      await symlink(target, metadataPath, 'junction');

      await expect(loadCanonicalAgentProjectionInputs(root)).rejects.toMatchObject({
        name: 'AgentDocumentError',
        code: 'AGENT_METADATA_FILE_INVALID',
        path: metadataPath,
        message: 'metadata must be a regular non-symlink file',
      });
    },
  );

  it.each([
    ['missing delimiter', 'name: mpx-alpha\n---\nbody'],
    ['missing name', '---\ndescription: x\n---\nbody'],
    ['duplicate name', '---\nname: mpx-alpha\nname: mpx-alpha\n---\n'],
    ['mismatched name', '---\nname: mpx-other\n---\n'],
  ])('rejects malformed frontmatter: %s', async (_label, source) => {
    await expect(loadCanonicalAgentProjectionInputs(await fixture(source))).rejects.toBeInstanceOf(
      AgentDocumentError,
    );
  });

  it('rejects forged documents and keeps deterministic bytewise inventory ordering', async () => {
    expect(() =>
      renderCanonicalAgentDocument({ schemaVersion: 1, identity: 'mpx-alpha' } as never, {
        name: 'x',
        fields: [],
      }),
    ).toThrow(/verified/u);
    const root = await mkdtemp(path.join(tmpdir(), 'agent-order-'));
    for (const identity of ['mpx-z', 'mpx-a']) {
      await writeFile(path.join(root, `${identity}.md`), `---\nname: ${identity}\n---\n`);
    }
    await writeFile(path.join(root, 'metadata.json'), metadata(['mpx-z', 'mpx-a']));
    expect((await loadCanonicalAgentProjectionInputs(root)).entries.map((x) => x.identity)).toEqual(
      ['mpx-a', 'mpx-z'],
    );
  });

  it('loads support files as exact bytes', async () => {
    const root = await fixture('---\nname: mpx-alpha\n---\n');
    await mkdir(path.join(root, 'references'));
    await writeFile(path.join(root, 'references', 'raw.bin'), Buffer.from([0, 255, 13, 10]));
    const loaded = await loadCanonicalAgentProjectionInputs(root);
    expect(loaded.supportFiles[0]!.relativePath).toBe('references/raw.bin');
    expect([...loaded.supportFiles[0]!.bytes]).toEqual([0, 255, 13, 10]);
  });
});

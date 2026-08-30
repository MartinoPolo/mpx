import { describe, expect, it, vi } from 'vitest';
import {
  inventoryProjectSkills,
  SkillCatalogError,
  type ProjectSkillDirectoryEntry,
  type ProjectSkillFileSystem,
} from '../src/index.js';

function failure(code: 'EACCES' | 'EIO' | 'ENOENT' | 'ENOTDIR'): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function streamed(entries: readonly ProjectSkillDirectoryEntry[]) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* entries;
    },
  };
}

describe('project skill inventory filesystem failures', () => {
  it.each(['EACCES', 'EIO'] as const)(
    'surfaces %s structurally and performs no later filesystem access',
    async (code) => {
      const filesystem: ProjectSkillFileSystem = {
        opendir: vi.fn(async () => {
          throw failure(code);
        }),
        realpath: vi.fn(),
        readFile: vi.fn(),
      };
      await expect(inventoryProjectSkills('C:/repo', [], filesystem)).rejects.toMatchObject({
        name: SkillCatalogError.name,
        diagnostics: [
          { code: 'PROJECT_SKILL_INVENTORY_FAILED', path: expect.stringContaining('.agents') },
        ],
      });
      expect(filesystem.realpath).not.toHaveBeenCalled();
      expect(filesystem.readFile).not.toHaveBeenCalled();
    },
  );

  it.each(['EACCES', 'EIO'] as const)(
    'fails structurally when reading skill content returns %s',
    async (code) => {
      const filesystem: ProjectSkillFileSystem = {
        opendir: vi.fn(async () => streamed([{ name: 'review', isDirectory: () => true }])),
        realpath: vi.fn(async (file) => file),
        readFile: vi.fn(async () => {
          throw failure(code);
        }),
      };
      await expect(inventoryProjectSkills('C:/repo', [], filesystem)).rejects.toMatchObject({
        diagnostics: [{ code: 'PROJECT_SKILL_INVENTORY_FAILED' }],
      });
    },
  );

  it('fails structurally when traversal hits an I/O error before reading skill content', async () => {
    const filesystem: ProjectSkillFileSystem = {
      opendir: vi.fn(async () => streamed([{ name: 'review', isDirectory: () => true }])),
      realpath: vi.fn(async () => {
        throw failure('EIO');
      }),
      readFile: vi.fn(),
    };
    await expect(inventoryProjectSkills('C:/repo', [], filesystem)).rejects.toMatchObject({
      diagnostics: [{ code: 'PROJECT_SKILL_INVENTORY_FAILED' }],
    });
    expect(filesystem.readFile).not.toHaveBeenCalled();
  });

  it.each(['ENOENT', 'ENOTDIR'] as const)('treats only %s as an absent inventory', async (code) => {
    const filesystem: ProjectSkillFileSystem = {
      opendir: vi.fn(async () => {
        throw failure(code);
      }),
      realpath: vi.fn(),
      readFile: vi.fn(),
    };
    await expect(inventoryProjectSkills('C:/repo', [], filesystem)).resolves.toEqual({
      skills: [],
      diagnostics: [],
    });
  });
});

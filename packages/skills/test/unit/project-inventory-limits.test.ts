import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  inventoryProjectSkills,
  MAX_PROJECT_SKILL_CANDIDATES,
  MAX_PROJECT_SKILL_DIRECTORY_ENTRIES,
  MAX_PROJECT_SKILL_INVENTORY_BYTES,
  SkillCatalogError,
  type ProjectSkillDirectoryEntry,
  type ProjectSkillFileSystem,
} from '../../src/index.js';

function directories(count: number): ProjectSkillDirectoryEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `skill-${index.toString().padStart(4, '0')}`,
    isDirectory: () => true,
  }));
}

function streamed(entries: readonly ProjectSkillDirectoryEntry[]) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* entries;
    },
  };
}

function skillBytes(name: string, size: number): Buffer {
  const prefix = `---\nname: ${name}\ndescription: test\ndisable-model-invocation: true\nmetadata:\n  mpx:\n    projectExposure: explicit-only\n---\n`;
  return Buffer.from(prefix + 'x'.repeat(size - prefix.length));
}

function fakeDirectory(
  entryCount: number,
  errorAt?: number,
  isDirectory: boolean | ((index: number) => boolean) = true,
) {
  let consumed = 0;
  const close = vi.fn(async () => ({ done: true as const, value: undefined }));
  const iterator: AsyncIterator<ProjectSkillDirectoryEntry> = {
    async next() {
      if (consumed === errorAt) {
        throw Object.assign(new Error('stream failed'), { code: 'EIO' });
      }
      if (consumed === entryCount) {
        return { done: true, value: undefined };
      }
      const index = consumed;
      const value = {
        name: `entry-${index.toString().padStart(4, '0')}`,
        isDirectory: () => (typeof isDirectory === 'function' ? isDirectory(index) : isDirectory),
      };
      consumed += 1;
      return { done: false, value };
    },
    return: close,
  };
  return {
    directory: { [Symbol.asyncIterator]: () => iterator },
    close,
    consumed: () => consumed,
  };
}

describe('project skill inventory root streaming', () => {
  it('bounds total entries examined and closes without reading candidates after overflow', async () => {
    const stream = fakeDirectory(100_000, undefined, (index) => index === 0);
    const filesystem: ProjectSkillFileSystem = {
      opendir: vi.fn(async () => stream.directory),
      realpath: vi.fn(),
      readFile: vi.fn(),
      enumerateDirectory: vi.fn(),
    };

    await expect(inventoryProjectSkills('C:/repo', [], filesystem)).rejects.toMatchObject({
      diagnostics: [{ code: 'PROJECT_SKILL_INVENTORY_LIMIT' }],
    });
    expect(stream.consumed()).toBe(MAX_PROJECT_SKILL_DIRECTORY_ENTRIES + 1);
    expect(stream.close).toHaveBeenCalledOnce();
    expect(filesystem.realpath).not.toHaveBeenCalled();
    expect(filesystem.readFile).not.toHaveBeenCalled();
    expect(filesystem.enumerateDirectory).not.toHaveBeenCalled();
  });

  it('accepts mixed entry types at the exact total-entry boundary', async () => {
    const entries: ProjectSkillDirectoryEntry[] = Array.from(
      { length: MAX_PROJECT_SKILL_DIRECTORY_ENTRIES },
      (_, index) => ({
        name: `file-${index.toString().padStart(4, '0')}`,
        isDirectory: () => false,
      }),
    );
    entries[17] = { name: 'zulu', isDirectory: () => true };
    entries[MAX_PROJECT_SKILL_DIRECTORY_ENTRIES - 3] = { name: 'alpha', isDirectory: () => true };
    const filesystem: ProjectSkillFileSystem = {
      opendir: vi.fn(async () => streamed(entries)),
      realpath: vi.fn(async (file) => file),
      readFile: vi.fn(async (file) =>
        skillBytes(path.basename(path.dirname(file)), 512).toString('utf8'),
      ),
      enumerateDirectory: vi.fn(async (directory) => [
        { relativePath: 'SKILL.md', bytes: skillBytes(path.basename(directory), 512) },
      ]),
    };

    const result = await inventoryProjectSkills('C:/repo', [], filesystem);

    expect(result.diagnostics).toEqual([]);
    expect(result.skills.map((skill) => skill.identity)).toEqual(['alpha', 'zulu']);
  });

  it('consumes at most the candidate limit plus one and performs no candidate reads after overflow', async () => {
    const stream = fakeDirectory(100_000);
    const filesystem: ProjectSkillFileSystem = {
      opendir: vi.fn(async () => stream.directory),
      realpath: vi.fn(async (file: string) => file),
      readFile: vi.fn(),
      enumerateDirectory: vi.fn(),
    };

    await expect(inventoryProjectSkills('C:/repo', [], filesystem)).rejects.toMatchObject({
      diagnostics: [{ code: 'PROJECT_SKILL_INVENTORY_LIMIT' }],
    });
    expect(stream.consumed()).toBe(MAX_PROJECT_SKILL_CANDIDATES + 1);
    expect(filesystem.realpath).not.toHaveBeenCalled();
    expect(filesystem.readFile).not.toHaveBeenCalled();
    expect(filesystem.enumerateDirectory).not.toHaveBeenCalled();
  });

  it('closes the root iterator immediately on candidate overflow', async () => {
    const stream = fakeDirectory(MAX_PROJECT_SKILL_CANDIDATES + 1);
    const filesystem: ProjectSkillFileSystem = {
      opendir: vi.fn(async () => stream.directory),
      realpath: vi.fn(),
      readFile: vi.fn(),
    };

    await expect(inventoryProjectSkills('C:/repo', [], filesystem)).rejects.toBeInstanceOf(
      SkillCatalogError,
    );
    expect(stream.close).toHaveBeenCalledOnce();
  });

  it('closes the root iterator when iteration fails', async () => {
    const stream = fakeDirectory(100_000, 3);
    const filesystem: ProjectSkillFileSystem = {
      opendir: vi.fn(async () => stream.directory),
      realpath: vi.fn(),
      readFile: vi.fn(),
    };

    await expect(inventoryProjectSkills('C:/repo', [], filesystem)).rejects.toMatchObject({
      diagnostics: [{ code: 'PROJECT_SKILL_INVENTORY_FAILED' }],
    });
    expect(stream.close).toHaveBeenCalledOnce();
  });
});

describe('project skill inventory aggregate limits', () => {
  it('rejects candidate-count overflow before resolving or reading candidates', async () => {
    const filesystem: ProjectSkillFileSystem = {
      opendir: vi.fn(async () => streamed(directories(MAX_PROJECT_SKILL_CANDIDATES + 1))),
      realpath: vi.fn(async (file) => file),
      readFile: vi.fn(),
    };

    await expect(inventoryProjectSkills('C:/repo', [], filesystem)).rejects.toMatchObject({
      diagnostics: [{ code: 'PROJECT_SKILL_INVENTORY_LIMIT' }],
    });
    expect(filesystem.realpath).not.toHaveBeenCalled();
    expect(filesystem.readFile).not.toHaveBeenCalled();
  });

  it('rejects aggregate overflow across many individually bounded skill directories', async () => {
    const count = 129;
    const bytesPerSkill = MAX_PROJECT_SKILL_INVENTORY_BYTES / 128;
    const filesystem: ProjectSkillFileSystem = {
      opendir: vi.fn(async () => streamed(directories(count))),
      realpath: vi.fn(async (file) => file),
      readFile: vi.fn(async (file) =>
        skillBytes(path.basename(path.dirname(file)), bytesPerSkill).toString('utf8'),
      ),
      enumerateDirectory: vi.fn(async (directory) => [
        { relativePath: 'SKILL.md', bytes: skillBytes(path.basename(directory), bytesPerSkill) },
      ]),
    };

    await expect(inventoryProjectSkills('C:/repo', [], filesystem)).rejects.toMatchObject({
      diagnostics: [{ code: 'PROJECT_SKILL_INVENTORY_LIMIT' }],
    });
  });

  it('stops at aggregate overflow without duplicate or later candidate reads', async () => {
    const bytesPerSkill = MAX_PROJECT_SKILL_INVENTORY_BYTES / 128;
    const enumerateDirectory = vi.fn(async (directory: string, _bytesRemaining: number) => [
      { relativePath: 'SKILL.md', bytes: skillBytes(path.basename(directory), bytesPerSkill) },
    ]);
    const filesystem: ProjectSkillFileSystem = {
      opendir: vi.fn(async () => streamed(directories(130))),
      realpath: vi.fn(async (file) => file),
      readFile: vi.fn(async (file) =>
        skillBytes(path.basename(path.dirname(file)), bytesPerSkill).toString('utf8'),
      ),
      enumerateDirectory,
    };

    await expect(inventoryProjectSkills('C:/repo', [], filesystem)).rejects.toMatchObject({
      diagnostics: [{ code: 'PROJECT_SKILL_INVENTORY_LIMIT' }],
    });
    expect(filesystem.readFile).toHaveBeenCalledTimes(129);
    expect(enumerateDirectory).toHaveBeenCalledTimes(128);
    expect(enumerateDirectory.mock.calls.at(-1)?.[0]).toContain('skill-0127');
  });

  it('accepts the exact aggregate boundary in deterministic identity order', async () => {
    const bytesPerSkill = MAX_PROJECT_SKILL_INVENTORY_BYTES / 128;
    const enumerateDirectory = vi.fn(async (directory: string, _bytesRemaining: number) => [
      { relativePath: 'SKILL.md', bytes: skillBytes(path.basename(directory), bytesPerSkill) },
    ]);
    const filesystem: ProjectSkillFileSystem = {
      opendir: vi.fn(async () => streamed(directories(128).reverse())),
      realpath: vi.fn(async (file) => file),
      readFile: vi.fn(async (file) =>
        skillBytes(path.basename(path.dirname(file)), bytesPerSkill).toString('utf8'),
      ),
      enumerateDirectory,
    };

    const result = await inventoryProjectSkills('C:/repo', [], filesystem);

    expect(result.diagnostics).toEqual([]);
    expect(result.skills.map((skill) => skill.identity)).toEqual(
      directories(128).map((entry) => entry.name),
    );
    expect(enumerateDirectory.mock.calls[0]?.[1]).toBe(MAX_PROJECT_SKILL_INVENTORY_BYTES);
    expect(enumerateDirectory.mock.calls.at(-1)?.[1]).toBe(bytesPerSkill);
  });

  it('detects a duplicate in a large list without scanning accepted skills', async () => {
    const duplicate = directories(1)[0];
    if (!duplicate) {
      throw new Error('directory fixture did not produce a duplicate');
    }
    const entries = [...directories(MAX_PROJECT_SKILL_CANDIDATES - 1), duplicate];
    const filesystem: ProjectSkillFileSystem = {
      opendir: vi.fn(async () => streamed(entries.reverse())),
      realpath: vi.fn(async (file) => file),
      readFile: vi.fn(async (file) =>
        skillBytes(path.basename(path.dirname(file)), 512).toString('utf8'),
      ),
      enumerateDirectory: vi.fn(async (directory) => {
        const name = path.basename(directory);
        return [{ relativePath: 'SKILL.md', bytes: skillBytes(name, 512) }];
      }),
    };
    const some = vi.spyOn(Array.prototype, 'some');
    try {
      const result = await inventoryProjectSkills('C:/repo', [], filesystem);
      const acceptedSkillScans = some.mock.instances.filter(
        (value) =>
          Array.isArray(value) &&
          value.length > 0 &&
          typeof value[0] === 'object' &&
          value[0] !== null &&
          'sourcePath' in value[0],
      );

      expect(acceptedSkillScans).toHaveLength(0);
      expect(result.skills).toHaveLength(MAX_PROJECT_SKILL_CANDIDATES - 1);
      expect(result.skills.map((skill) => skill.identity)).toEqual(
        directories(MAX_PROJECT_SKILL_CANDIDATES - 1).map((entry) => entry.name),
      );
      expect(result.diagnostics).toMatchObject([
        {
          code: 'PROJECT_SKILL_COLLISION',
          message: expect.stringContaining("duplicates /skill:skill-0000 from '"),
        },
      ]);
    } finally {
      some.mockRestore();
    }
  });
});

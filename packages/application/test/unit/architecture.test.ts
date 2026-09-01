import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

async function sourceText(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? sourceText(path.join(root, entry.name))
          : entry.name.endsWith('.ts')
            ? readFile(path.join(root, entry.name), 'utf8')
            : '',
      ),
    )
  ).join('\n');
}

async function rootSourceText(root: string): Promise<string> {
  const files = (await readdir(root, { withFileTypes: true })).filter(
    (entry) => entry.isFile() && entry.name.endsWith('.ts'),
  );
  return (
    await Promise.all(files.map((file) => readFile(path.join(root, file.name), 'utf8')))
  ).join('\n');
}

describe('@mpx/application architecture', () => {
  it('imports no concrete provider, runtime adapter, Windows, or CLI modules', async () => {
    const source = await rootSourceText(path.resolve(import.meta.dirname, '../../src'));
    expect(source).not.toMatch(/@mpx\/(?:provider-|runtime-(?:claude|pi)|windows)|apps\/cli/u);
  });

  it('keeps Node imports and NodeJS types out of the provider-neutral root', async () => {
    const source = await rootSourceText(path.resolve(import.meta.dirname, '../../src'));
    expect(source).not.toMatch(/from ['"]node:|\bNodeJS\./u);
  });

  it('recursively excludes concrete providers, runtimes, and CLI internals', async () => {
    const source = await sourceText(path.resolve(import.meta.dirname, '../../src'));
    expect(source).not.toMatch(/@mpx\/(?:provider-|runtime-(?:claude|pi))|apps\/cli/u);
  });

  it('exposes provider-neutral operation facades from the importable package root', async () => {
    const application = await import('../../src/index.js');
    expect(application).toMatchObject({
      LifecycleApplicationService: expect.any(Function),
      createProjectApplicationService: expect.any(Function),
      createProviderApplicationService: expect.any(Function),
      createSkillApplicationService: expect.any(Function),
    });
  });

  it('keeps generic application operation contracts out of provider-specific services', async () => {
    const contracts = await readFile(
      path.resolve(import.meta.dirname, '../../src/contracts.ts'),
      'utf8',
    );
    const providerService = await readFile(
      path.resolve(import.meta.dirname, '../../src/provider-application-service.ts'),
      'utf8',
    );
    expect(contracts).toContain('export interface ApplicationOperationResult<T>');
    expect(providerService).not.toContain('interface ApplicationOperationResult');
  });
});

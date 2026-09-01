import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

async function sourceText(root: string): Promise<string> {
  const files = (await readdir(root)).filter((file) => file.endsWith('.ts'));
  return (await Promise.all(files.map((file) => readFile(path.join(root, file), 'utf8')))).join(
    '\n',
  );
}

describe('@mpx/application architecture', () => {
  it('imports no concrete provider, runtime, Windows, or CLI modules', async () => {
    const source = await sourceText(path.resolve(import.meta.dirname, '../../src'));
    expect(source).not.toMatch(/@mpx\/(?:provider-|runtime-|windows)|apps\/cli/u);
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

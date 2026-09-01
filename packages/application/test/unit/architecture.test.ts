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

  it('exposes shared contracts and provider-neutral operation facades from the package root', async () => {
    const index = await readFile(path.resolve(import.meta.dirname, '../../src/index.ts'), 'utf8');
    expect(index).toBe(
      "export * from './contracts.js';\n" +
        "export * from './project-application-service.js';\n" +
        "export * from './provider-application-service.js';\n" +
        "export * from './skill-application-service.js';\n",
    );
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

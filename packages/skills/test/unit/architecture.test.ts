import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import * as ts from 'typescript';
import { expect, it } from 'vitest';

const sourceRoot = path.resolve(import.meta.dirname, '../../src');
const requiredModules = [
  'artifact.ts',
  'contracts.ts',
  'frontmatter.ts',
  'index.ts',
  'inventory.ts',
  'loader.ts',
  'manifest.ts',
  'policy.ts',
  'projection.ts',
  'search-ranking.ts',
  'search.ts',
];

function moduleReferences(source: ts.SourceFile): string[] {
  return source.statements.flatMap((statement) => {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      return [statement.moduleSpecifier.text];
    }
    return [];
  });
}

function findCycles(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  const complete = new Set<string>();
  const active = new Map<string, number>();
  const trail: string[] = [];
  const cycles: string[][] = [];

  const visit = (module: string): void => {
    if (complete.has(module)) {
      return;
    }
    const cycleStart = active.get(module);
    if (cycleStart !== undefined) {
      cycles.push([...trail.slice(cycleStart), module]);
      return;
    }
    active.set(module, trail.length);
    trail.push(module);
    for (const dependency of graph.get(module) ?? []) {
      visit(dependency);
    }
    trail.pop();
    active.delete(module);
    complete.add(module);
  };

  for (const module of graph.keys()) {
    visit(module);
  }
  return cycles;
}

it('keeps skills internals separated behind an acyclic explicit public facade', async () => {
  const modules = (await readdir(sourceRoot, { recursive: true }))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => name.split(path.sep).join('/'))
    .sort();
  expect(modules).toEqual(expect.arrayContaining(requiredModules));

  const sources = new Map(
    await Promise.all(
      modules.map(async (name) => {
        const text = await readFile(path.join(sourceRoot, name), 'utf8');
        return [name, ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true)] as const;
      }),
    ),
  );
  const facade = sources.get('index.ts')!;
  expect(facade.statements.length).toBeGreaterThan(0);
  for (const statement of facade.statements) {
    expect(ts.isExportDeclaration(statement), statement.getText(facade)).toBe(true);
    if (ts.isExportDeclaration(statement)) {
      expect(statement.exportClause, 'facade wildcard export').toBeDefined();
      expect(ts.isNamedExports(statement.exportClause!), 'facade explicit named export').toBe(true);
    }
  }

  const moduleIds = new Set(modules.map((name) => name.replace(/\.ts$/u, '')));
  const graph = new Map<string, string[]>();
  const forbiddenOutwardImport =
    /@mpx\/(?:skills|config|runtime-(?:claude|pi))|packages\/(?:cli|providers?)/u;

  for (const [name, source] of sources) {
    const moduleId = name.replace(/\.ts$/u, '');
    const dependencies: string[] = [];
    for (const reference of moduleReferences(source)) {
      expect(reference, `${name} imports outward`).not.toMatch(forbiddenOutwardImport);
      if (!reference.startsWith('.')) {
        continue;
      }
      const dependency = path.posix
        .normalize(path.posix.join(path.posix.dirname(moduleId), reference))
        .replace(/\.(?:js|ts)$/u, '');
      if (moduleId !== 'index') {
        expect(dependency, `${name} imports the root facade`).not.toBe('index');
      }
      if (moduleIds.has(dependency)) {
        dependencies.push(dependency);
      }
    }
    graph.set(moduleId, dependencies);
  }
  expect(findCycles(graph)).toEqual([]);

  const packageJson = JSON.parse(
    await readFile(path.resolve(sourceRoot, '../package.json'), 'utf8'),
  ) as { exports: Record<string, unknown> };
  expect(Object.keys(packageJson.exports).sort()).toEqual(['.', './contracts']);
});

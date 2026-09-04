import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { test } from 'vitest';

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
const sourceExtensions = new Set(['.ts', '.js', '.mjs', '.cjs']);
const forbiddenActiveLiterals = [
  /mpx-(?:pi|claude-code)/i,
  /_MP_/i,
  /\.codex(?:[\\/]|$)/i,
  /(?:^|[^A-Za-z])[A-Za-z]:[\\/]/,
  /credentials?\.json/i,
  /(?:credential|session)[-_ ]root/i,
];

function filesUnder(directory: string, include: (file: string) => boolean): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === 'test') return [];
    const target = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(target, include);
    return include(target) ? [target] : [];
  });
}

function packageFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'dist' || entry.name === 'node_modules') return [];
    const target = join(directory, entry.name);
    return entry.isDirectory() ? packageFiles(target) : [target];
  });
}

function sourceFile(fileName: string, contents: string): ts.SourceFile {
  const scriptKind = fileName.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  return ts.createSourceFile(fileName, contents, ts.ScriptTarget.Latest, true, scriptKind);
}

function importedSpecifiers(source: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0]!) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      specifiers.push(node.arguments[0]!.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

function activeLiterals(source: ts.SourceFile): string[] {
  const literals: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteralLike(node) ||
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail
    ) {
      literals.push((node as ts.StringLiteralLike).text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return literals;
}

test('import audit recognizes static, side-effect, dynamic, and require forms', () => {
  const source = sourceFile(
    'fixture.ts',
    [
      "import value from 'static-package';",
      "import 'side-effect-package';",
      "export { value as exported } from 'export-package';",
      "const dynamic = import('dynamic-package');",
      "const required = require('required-package');",
      "import alias = require('import-equals-package');",
    ].join('\n'),
  );

  assert.deepEqual(importedSpecifiers(source), [
    'static-package',
    'side-effect-package',
    'export-package',
    'dynamic-package',
    'required-package',
    'import-equals-package',
  ]);
});

test('active TypeScript and JavaScript sources contain no retired or machine-local literals', () => {
  for (const file of filesUnder(packageRoot, (candidate) =>
    sourceExtensions.has(extname(candidate)),
  )) {
    const parsed = sourceFile(file, readFileSync(file, 'utf8'));
    const relativeFile = relative(packageRoot, file);
    for (const literal of activeLiterals(parsed)) {
      for (const forbidden of forbiddenActiveLiterals) {
        assert.doesNotMatch(literal, forbidden, `${relativeFile} contains ${forbidden}`);
      }
    }
    for (const specifier of importedSpecifiers(parsed)) {
      for (const forbidden of forbiddenActiveLiterals) {
        assert.doesNotMatch(specifier, forbidden, `${relativeFile} imports ${specifier}`);
      }
    }
  }
});

test('only the package root owns a package manifest', () => {
  const manifests = packageFiles(packageRoot)
    .filter((file) => file.endsWith('package.json'))
    .map((file) => relative(packageRoot, file).replaceAll('\\', '/'));

  assert.deepEqual(manifests, ['package.json']);
});

test('retired and generated resources are excluded', () => {
  const names = packageFiles(packageRoot).map((file) =>
    relative(packageRoot, file).replaceAll('\\', '/'),
  );
  const forbiddenNames = [
    'mp-namespace-commands.ts',
    'kf-namespace-commands.ts',
    'package-lock.json',
    'credentials.json',
    'nul',
  ];

  for (const name of forbiddenNames) {
    assert.equal(
      names.some((candidate) => candidate.endsWith(name)),
      false,
      name,
    );
  }
});

test('composition entry point does not discover extensions dynamically', () => {
  const entryPoint = readFileSync(join(packageRoot, 'index.ts'), 'utf8');
  assert.doesNotMatch(entryPoint, /readdir|glob|import\s*\(/);
});

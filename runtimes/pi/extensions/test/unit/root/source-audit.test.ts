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
    if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === 'test') {
      return [];
    }
    const target = join(directory, entry.name);
    if (entry.isDirectory()) {
      return filesUnder(target, include);
    }
    return include(target) ? [target] : [];
  });
}

function packageFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'dist' || entry.name === 'node_modules') {
      return [];
    }
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

function childProcessViolations(source: ts.SourceFile): string[] {
  const violations: string[] = [];
  const shellCommandFunctions = new Set(['exec', 'execSync']);
  const childProcessFunctions = new Set([
    ...shellCommandFunctions,
    'execFile',
    'execFileSync',
    'spawn',
    'spawnSync',
  ]);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const functionName = node.expression.text;
      if (childProcessFunctions.has(functionName)) {
        for (const argument of node.arguments) {
          if (!ts.isObjectLiteralExpression(argument)) {
            continue;
          }
          for (const property of argument.properties) {
            if (
              ts.isPropertyAssignment(property) &&
              ((ts.isIdentifier(property.name) && property.name.text === 'shell') ||
                (ts.isStringLiteralLike(property.name) && property.name.text === 'shell')) &&
              property.initializer.kind === ts.SyntaxKind.TrueKeyword
            ) {
              violations.push(`${functionName} enables shell:true`);
            }
          }
        }
      }
      if (shellCommandFunctions.has(functionName)) {
        const command = node.arguments[0];
        if (
          command &&
          !ts.isStringLiteralLike(command) &&
          !ts.isNoSubstitutionTemplateLiteral(command)
        ) {
          violations.push(`${functionName} receives a constructed command`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
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

test('child-process audit rejects shells and constructed shell commands without flagging fixed commands', () => {
  const unsafe = sourceFile(
    'unsafe.mjs',
    ['execSync(`formatter "${filePath}"`);', "spawn('tool', [filePath], { shell: true });"].join(
      '\n',
    ),
  );
  const safe = sourceFile(
    'safe.mjs',
    [
      "execSync('gh pr view --json url');",
      "execFileSync('git', ['diff', '--', filePath], { shell: false });",
      'spawn(binaryPath, [filePath], { shell: false });',
    ].join('\n'),
  );

  assert.deepEqual(childProcessViolations(unsafe), [
    'execSync receives a constructed command',
    'spawn enables shell:true',
  ]);
  assert.deepEqual(childProcessViolations(safe), []);
});

test('active sources do not enable shells or construct shell commands', () => {
  for (const file of filesUnder(packageRoot, (candidate) =>
    sourceExtensions.has(extname(candidate)),
  )) {
    const parsed = sourceFile(file, readFileSync(file, 'utf8'));
    assert.deepEqual(childProcessViolations(parsed), [], relative(packageRoot, file));
  }
});

test('active TypeScript and JavaScript sources contain no retired or machine-local literals', () => {
  for (const file of filesUnder(packageRoot, (candidate) =>
    sourceExtensions.has(extname(candidate)),
  )) {
    const parsed = sourceFile(file, readFileSync(file, 'utf8'));
    const relativeFile = relative(packageRoot, file);
    for (const literal of activeLiterals(parsed)) {
      if (relativeFile === 'footer.ts' && literal === 'mpx-pi') {
        continue;
      }
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

test('compiled agent discovery is environment-owned and imports no mutation primitives', () => {
  const customAgents = readFileSync(join(packageRoot, 'subagents', 'custom-agents.ts'), 'utf8');
  const configuredSource = customAgents.match(/process\.env\.MPX_COMPILED_AGENTS_DIR/g) ?? [];

  assert.equal(configuredSource.length, 1);
  assert.doesNotMatch(
    customAgents,
    /\b(?:mkdir|writeFile|open|truncate|unlink|rename|rm)(?:Sync)?\b/,
  );
});

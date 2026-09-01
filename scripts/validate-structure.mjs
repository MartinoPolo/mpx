import { execFileSync } from 'node:child_process';
import { readFile as nodeReadFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const normalized = (value) => value.replaceAll('\\', '/');
const sourceExtension = /\.(?:[cm]?[jt]sx?)$/u;
const testLike = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/u;
const fixturePath = /(?:^|\/)(?:fixture|fixtures|__fixtures__|test-fixtures)(?:\/|$)/u;
const requiredTestExcludes = ['src/**/*.test.ts', 'src/**/*.spec.ts'];

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') {
          return [];
        }
        const target = path.join(directory, entry.name);
        return entry.isDirectory() ? filesBelow(target) : [target];
      }),
    )
  ).flat();
}

function validateExportTarget(value) {
  if (typeof value === 'string') {
    if (!value.startsWith('./')) {
      throw new Error('export target must be workspace-relative');
    }
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('export target must be a string or condition object');
  }
  for (const target of Object.values(value)) {
    validateExportTarget(target);
  }
}

function exportKeys(value) {
  if (value === undefined) {
    return new Set();
  }
  if (typeof value === 'string') {
    validateExportTarget(value);
    return new Set(['.']);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('exports must be a string or object');
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key.startsWith('.'))) {
    if (!keys.every((key) => key === '.' || key.startsWith('./'))) {
      throw new Error('exports mixes malformed subpaths');
    }
    for (const target of Object.values(value)) {
      validateExportTarget(target);
    }
    return new Set(keys);
  }
  if (!keys.every((key) => ['types', 'import', 'default', 'require', 'node'].includes(key))) {
    throw new Error('exports has malformed conditions');
  }
  validateExportTarget(value);
  return new Set(['.']);
}

function specifiers(source, file) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    /\.[cm]?tsx$/u.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const values = [];
  const addLiteral = (node) => {
    if (node && ts.isStringLiteralLike(node)) {
      values.push(node.text);
    }
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addLiteral(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      addLiteral(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const requireCall = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (dynamicImport || requireCall) {
        addLiteral(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return values;
}

function stringLiterals(source, file) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const values = [];
  const visit = (node) => {
    if (ts.isStringLiteralLike(node)) {
      values.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return values;
}

function discoverWorkspaces(root) {
  const listed = JSON.parse(
    execFileSync('pnpm', ['--recursive', 'list', '--depth', '-1', '--json'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    }),
  );
  if (!Array.isArray(listed)) {
    throw new Error('workspace list is not an array');
  }
  return listed
    .map((item) => item?.path)
    .filter(
      (directory) =>
        typeof directory === 'string' && path.resolve(directory) !== path.resolve(root),
    );
}

export async function validateStructure(root, options = {}) {
  const diagnostics = [];
  const readFile = options.readFile ?? nodeReadFile;
  let directories;
  try {
    directories = options.workspaceDirectories ?? discoverWorkspaces(root);
  } catch (failure) {
    return [
      {
        code: 'WORKSPACE_DISCOVERY_INVALID',
        file: 'pnpm-workspace.yaml',
        message: failure.message,
      },
    ];
  }
  const workspaces = [];
  for (const directoryValue of directories) {
    const directory = path.resolve(directoryValue);
    const relative = normalized(path.relative(root, directory));
    try {
      const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      if (typeof manifest.name !== 'string' || !manifest.name.trim()) {
        throw new Error('manifest name is required');
      }
      workspaces.push({
        directory,
        relative,
        name: manifest.name,
        exports: exportKeys(manifest.exports),
      });
    } catch (failure) {
      diagnostics.push({
        code: 'WORKSPACE_EXPORTS_INVALID',
        file: `${relative}/package.json`,
        message: failure.message,
      });
      continue;
    }
    try {
      const config = JSON.parse(await readFile(path.join(directory, 'tsconfig.json'), 'utf8'));
      const excludes = Array.isArray(config.exclude) ? config.exclude : [];
      if (!requiredTestExcludes.every((pattern) => excludes.includes(pattern))) {
        throw new Error(`exclude must contain ${requiredTestExcludes.join(' and ')}`);
      }
    } catch (failure) {
      diagnostics.push({
        code: 'WORKSPACE_TSCONFIG_TEST_EXCLUDES',
        file: `${relative}/tsconfig.json`,
        message: failure.message,
      });
    }
  }
  try {
    const shared = await readFile(path.join(root, 'vitest.shared.ts'), 'utf8');
    if (
      stringLiterals(shared, 'vitest.shared.ts').some((value) =>
        value.replace(/^\.\//u, '').startsWith('tests/unit/'),
      )
    ) {
      diagnostics.push({
        code: 'ROOT_UNIT_DISCOVERY_TRANSITIONAL',
        file: 'vitest.shared.ts',
        message: 'root tests/unit discovery is transitional and forbidden',
      });
    }
  } catch (failure) {
    diagnostics.push({
      code: 'VITEST_SHARED_INVALID',
      file: 'vitest.shared.ts',
      message: failure.message,
    });
  }
  const ownerOf = (absolute) =>
    workspaces.find(
      (workspace) =>
        absolute === workspace.directory ||
        absolute.startsWith(`${workspace.directory}${path.sep}`),
    );
  const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  const allFiles = await filesBelow(root);
  for (const absolute of allFiles) {
    const file = normalized(path.relative(root, absolute));
    const owner = ownerOf(path.resolve(absolute));
    if (
      owner &&
      file.startsWith(`${owner.relative}/src/`) &&
      (testLike.test(file) || fixturePath.test(file))
    ) {
      diagnostics.push({
        code: 'WORKSPACE_SRC_TEST_ASSET',
        file,
        message: 'workspace src cannot contain tests, specs, or fixtures',
      });
    }
  }
  for (const absolute of allFiles.filter((file) => sourceExtension.test(file))) {
    const file = normalized(path.relative(root, absolute));
    const owner = ownerOf(path.resolve(absolute));
    let source;
    try {
      source = await readFile(absolute, 'utf8');
    } catch (failure) {
      diagnostics.push({ code: 'SOURCE_UNREADABLE', file, message: failure.message });
      continue;
    }
    for (const specifier of specifiers(source, file)) {
      if (/^[A-Za-z]:[\\/]|^\//u.test(specifier)) {
        diagnostics.push({
          code: 'ABSOLUTE_IMPORT',
          file,
          message: `absolute import is forbidden: ${specifier}`,
        });
        continue;
      }
      if (specifier.startsWith('.')) {
        const target = path.resolve(path.dirname(absolute), specifier);
        const targetOwner = ownerOf(target);
        if (targetOwner && owner !== targetOwner) {
          diagnostics.push({
            code: 'CROSS_WORKSPACE_IMPORT',
            file,
            message: `relative cross-workspace import is forbidden: ${specifier}`,
          });
        }
        continue;
      }
      if (!specifier.startsWith('@mpx/')) {
        continue;
      }
      if (/\/(?:src|dist)(?:\/|$)/u.test(specifier)) {
        diagnostics.push({
          code: 'WORKSPACE_DEEP_IMPORT',
          file,
          message: `workspace src/dist deep import is forbidden: ${specifier}`,
        });
        continue;
      }
      const parts = specifier.split('/');
      const name = parts.slice(0, 2).join('/');
      const workspace = byName.get(name);
      if (!workspace) {
        continue;
      }
      const subpath = parts.length === 2 ? '.' : `./${parts.slice(2).join('/')}`;
      if (!workspace.exports.has(subpath)) {
        diagnostics.push({
          code: 'WORKSPACE_EXPORT_UNDECLARED',
          file,
          message: `undeclared workspace export: ${specifier}`,
        });
      }
    }
  }
  return diagnostics.sort((a, b) => a.file.localeCompare(b.file) || a.code.localeCompare(b.code));
}

async function run() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const diagnostics = await validateStructure(root);
  if (diagnostics.length) {
    diagnostics.forEach((item) => console.error(`${item.code}: ${item.file}: ${item.message}`));
    process.exitCode = 1;
  } else {
    console.log('Repository workspace structure is valid.');
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run();
}

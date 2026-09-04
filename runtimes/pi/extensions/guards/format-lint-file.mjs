/**
 * PostToolUse hook (matcher: Edit|Write)
 * Auto-formats and lints the edited file using detected project tools.
 * Always exits 0.
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdin, findProjectRoot, detectToolchain } from './shared.mjs';

const PRETTIER_CONFIGS = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.yml',
  '.prettierrc.yaml',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
];

const ESLINT_CONFIGS = [
  '.eslintrc',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
  '.eslintrc.js',
  '.eslintrc.cjs',
  'eslint.config.js',
  'eslint.config.cjs',
  'eslint.config.mjs',
  'eslint.config.ts',
];

const JS_EXTENSIONS = new Set([
  'js',
  'jsx',
  'ts',
  'tsx',
  'mjs',
  'cjs',
  'mts',
  'cts',
  'svelte',
  'vue',
]);
const PRETTIER_ONLY_EXTENSIONS = new Set(['css', 'scss', 'less', 'html', 'md', 'yaml', 'yml']);

function hasConfig(directory, configs) {
  return configs.some((config) => fs.existsSync(path.join(directory, config)));
}

function packageRootFromEntry(entryPath, packageName) {
  let directory = path.dirname(entryPath);
  for (;;) {
    const manifestPath = path.join(directory, 'package.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.name === packageName) return { directory, manifest };
    } catch {
      // Continue toward the package root.
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function resolveProjectPackageRoot(projectRoot, packageName) {
  const projectRequire = createRequire(path.join(projectRoot, 'package.json'));
  try {
    const manifestPath = projectRequire.resolve(`${packageName}/package.json`);
    return {
      directory: path.dirname(manifestPath),
      manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
    };
  } catch {
    return packageRootFromEntry(projectRequire.resolve(packageName), packageName);
  }
}

export function resolveProjectPackageBinary(projectRoot, packageName, binaryName) {
  try {
    const packageRoot = resolveProjectPackageRoot(projectRoot, packageName);
    if (!packageRoot) return undefined;

    const binary = packageRoot.manifest.bin;
    const relativeBinary = typeof binary === 'string' ? binary : binary?.[binaryName];
    if (typeof relativeBinary !== 'string') return undefined;
    const resolvedBinary = path.resolve(packageRoot.directory, relativeBinary);
    return fs.existsSync(resolvedBinary) ? resolvedBinary : undefined;
  } catch {
    return undefined;
  }
}

export function resolveBiomeBinary(projectRoot) {
  const libc =
    process.platform === 'linux' && !process.report?.getReport?.().header?.glibcVersionRuntime
      ? '-musl'
      : '';
  const nativePackage = `@biomejs/cli-${process.platform}-${process.arch}${libc}`;
  try {
    const biomePackage = resolveProjectPackageRoot(projectRoot, '@biomejs/biome');
    if (!biomePackage?.manifest.optionalDependencies?.[nativePackage]) return undefined;
    const biomeRequire = createRequire(path.join(biomePackage.directory, 'package.json'));
    const resolvedBinary = biomeRequire.resolve(nativePackage);
    return fs.existsSync(resolvedBinary) ? resolvedBinary : undefined;
  } catch {
    return undefined;
  }
}

export function resolveExecutable(executable) {
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32' ? ['.EXE', '.COM'] : [''];
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${executable}${extension}`);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return undefined;
}

function executeBestEffort(executable, args, projectRoot, silent, execute) {
  if (!executable) return;
  try {
    execute(executable, args, {
      cwd: projectRoot,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    });
  } catch (error) {
    if (!silent) {
      const output = (error.stdout?.toString() || error.stderr?.toString() || '').trim();
      if (output) process.stdout.write(`${output}\n`);
    }
  }
}

export function formatAndLintFile(filePath, projectRoot, dependencies = {}) {
  const execute = dependencies.execFileSync ?? execFileSync;
  const resolveNodeBinary = dependencies.resolveProjectPackageBinary ?? resolveProjectPackageBinary;
  const resolveNativeBiome = dependencies.resolveBiomeBinary ?? resolveBiomeBinary;
  const resolveNativeExecutable = dependencies.resolveExecutable ?? resolveExecutable;
  const toolchain = dependencies.detectToolchain?.(projectRoot) ?? detectToolchain(projectRoot);
  const extension = path.extname(filePath).slice(1);

  const runNodeCli = (packageName, binaryName, args, silent = false) => {
    const scriptPath = resolveNodeBinary(projectRoot, packageName, binaryName);
    if (scriptPath) {
      executeBestEffort(process.execPath, [scriptPath, ...args], projectRoot, silent, execute);
    }
  };
  const runBiome = (args, silent = false) => {
    executeBestEffort(resolveNativeBiome(projectRoot), args, projectRoot, silent, execute);
  };
  const runVitePlusFormat = () => runNodeCli('vite-plus', 'vp', ['fmt', filePath], true);

  if (JS_EXTENSIONS.has(extension)) {
    if (toolchain === 'vite-plus') {
      runVitePlusFormat();
      runNodeCli('vite-plus', 'vp', ['lint', '--fix', filePath]);
      if (hasConfig(projectRoot, ESLINT_CONFIGS)) {
        runNodeCli('eslint', 'eslint', ['--fix', filePath]);
      }
    } else if (toolchain === 'biome') {
      runBiome(['format', '--write', filePath], true);
      runBiome(['lint', '--fix', filePath]);
    } else {
      if (hasConfig(projectRoot, PRETTIER_CONFIGS)) {
        runNodeCli('prettier', 'prettier', ['--write', filePath], true);
      }
      if (hasConfig(projectRoot, ESLINT_CONFIGS)) {
        runNodeCli('eslint', 'eslint', ['--fix', filePath]);
      }
    }
  } else if (extension === 'py') {
    let hasRuff =
      fs.existsSync(path.join(projectRoot, 'ruff.toml')) ||
      fs.existsSync(path.join(projectRoot, '.ruff.toml'));
    if (!hasRuff) {
      try {
        hasRuff = fs
          .readFileSync(path.join(projectRoot, 'pyproject.toml'), 'utf8')
          .includes('[tool.ruff');
      } catch {
        // No pyproject configuration.
      }
    }
    if (hasRuff) {
      const ruff = resolveNativeExecutable('ruff');
      executeBestEffort(ruff, ['format', filePath], projectRoot, true, execute);
      executeBestEffort(ruff, ['check', '--fix', filePath], projectRoot, false, execute);
    }
  } else if (extension === 'json' || extension === 'jsonc') {
    if (toolchain === 'vite-plus') runVitePlusFormat();
    else if (toolchain === 'biome') runBiome(['format', '--write', filePath], true);
    else if (hasConfig(projectRoot, PRETTIER_CONFIGS)) {
      runNodeCli('prettier', 'prettier', ['--write', filePath], true);
    }
  } else if (PRETTIER_ONLY_EXTENSIONS.has(extension)) {
    if (toolchain === 'vite-plus') runVitePlusFormat();
    else if (hasConfig(projectRoot, PRETTIER_CONFIGS)) {
      runNodeCli('prettier', 'prettier', ['--write', filePath], true);
    }
    if (extension === 'css' && toolchain === 'biome') {
      runBiome(['format', '--write', filePath], true);
    }
  }
}

async function main() {
  const input = await readStdin();
  const filePath = input.tool_input?.file_path;
  if (!filePath || !fs.existsSync(filePath)) return;

  const projectRoot = findProjectRoot(path.dirname(filePath), ['package.json', 'pyproject.toml']);
  if (projectRoot) formatAndLintFile(filePath, projectRoot);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => process.exit(0));
}

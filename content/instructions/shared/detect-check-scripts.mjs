#!/usr/bin/env node

// Usage: node detect-check-scripts.mjs [repository-root] [package-manager] [config-json-file]
// The optional config file supplies resolved machine-local overrides without modifying the repository.

import { existsSync, globSync, readFileSync } from 'node:fs';
import path from 'node:path';

const repositoryRoot = path.resolve(process.argv[2] ?? '.');
const packageManagerArgument = process.argv[3] || undefined;
const explicitConfigPath = process.argv[4] ? path.resolve(process.argv[4]) : undefined;
const result = { fast_checks: [], full_checks: [], unresolved: [] };
const supportedPackageManagers = new Set(['pnpm', 'npm', 'yarn', 'bun']);

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    result.unresolved.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function relativeDirectory(file) {
  const relative = path.relative(repositoryRoot, path.dirname(file)).split(path.sep).join('/');
  return relative || '.';
}

function configuredChecks(config, key, label) {
  if (!Object.hasOwn(config, key)) return undefined;
  if (!Array.isArray(config[key])) {
    result.unresolved.push(`${label} ${key} must be an array`);
    return undefined;
  }
  const checks = [];
  for (const [index, value] of config[key].entries()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.command !== 'string' || value.command.trim() === ''
      || typeof value.cwd !== 'string' || value.cwd.trim() === ''
      || /^[A-Za-z]:/.test(value.cwd) || path.isAbsolute(value.cwd) || value.cwd.split(/[\\/]/).includes('..')) {
      result.unresolved.push(`${label} ${key}[${index}] is invalid`);
      continue;
    }
    checks.push({ command: value.command, cwd: value.cwd });
  }
  return checks;
}

function managerName(value, source) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    result.unresolved.push(`${source} packageManager must be a string`);
    return undefined;
  }
  const manager = value.match(/^(pnpm|npm|yarn|bun)(?:@|$)/)?.[1];
  if (!manager || !supportedPackageManagers.has(manager)) result.unresolved.push(`Unsupported ${source} packageManager: ${value}`);
  return manager;
}

function packageManager(rootPackage, config) {
  const argument = managerName(packageManagerArgument, 'CLI');
  const configured = managerName(config?.packageManager, 'config');
  const declared = managerName(rootPackage?.packageManager, 'package.json');
  const declarations = [['CLI', argument], ['config', configured], ['package.json', declared]].filter(([, manager]) => manager !== undefined);
  if (new Set(declarations.map(([, manager]) => manager)).size > 1) {
    result.unresolved.push(`Contradictory packageManager declarations: ${declarations.map(([source, manager]) => `${source} ${manager}`).join(', ')}`);
  }
  const locks = [
    ['pnpm', 'pnpm-lock.yaml'], ['yarn', 'yarn.lock'], ['npm', 'package-lock.json'],
    ['npm', 'npm-shrinkwrap.json'], ['bun', 'bun.lock'], ['bun', 'bun.lockb'],
  ].filter(([, file]) => existsSync(path.join(repositoryRoot, file))).map(([manager]) => manager);
  const uniqueLocks = [...new Set(locks)];
  if (uniqueLocks.length > 1) result.unresolved.push(`Ambiguous package manager lockfiles: ${uniqueLocks.join(', ')}`);
  const selected = argument ?? configured ?? declared ?? uniqueLocks[0];
  if (selected && uniqueLocks.some(manager => manager !== selected)) {
    result.unresolved.push(`packageManager ${selected} conflicts with ${uniqueLocks.filter(manager => manager !== selected).join(', ')} lockfile`);
  }
  if (!selected) result.unresolved.push('Package manager could not be determined');
  return selected;
}

function workspacePatterns(rootPackage) {
  const workspaces = rootPackage?.workspaces;
  let configured = [];
  if (workspaces !== undefined) {
    const arrayShape = Array.isArray(workspaces);
    const objectShape = workspaces && typeof workspaces === 'object' && Array.isArray(workspaces.packages);
    const patterns = arrayShape ? workspaces : objectShape ? workspaces.packages : undefined;
    if (patterns === undefined) {
      result.unresolved.push('package.json workspaces must be an array of strings or an object with a packages array of strings');
    } else {
      const label = arrayShape ? 'package.json workspaces' : 'package.json workspaces.packages';
      for (const [index, pattern] of patterns.entries()) {
        if (typeof pattern === 'string') configured.push(pattern);
        else result.unresolved.push(`${label}[${index}] must be a string`);
      }
    }
  }
  const workspaceFile = path.join(repositoryRoot, 'pnpm-workspace.yaml');
  if (!existsSync(workspaceFile)) return configured;
  let contents;
  try {
    contents = readFileSync(workspaceFile, 'utf8');
  } catch (error) {
    result.unresolved.push(`pnpm-workspace.yaml: ${error instanceof Error ? error.message : String(error)}`);
    return configured;
  }
  const lines = contents.split(/\r?\n/);
  if (!lines.some(line => /^packages\s*:/.test(line))) return configured;
  const packagesLine = lines.findIndex(line => /^packages:\s*$/.test(line));
  if (packagesLine === -1) {
    result.unresolved.push('pnpm-workspace.yaml uses unsupported or commented packages syntax');
    return configured;
  }
  const parsed = [];
  for (const line of lines.slice(packagesLine + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line)) break;
    const value = line.match(/^\s+-\s+(?:'([^']+)'|"([^"]+)"|([^#'"\s][^#]*?))\s*$/);
    const pattern = (value?.[1] ?? value?.[2] ?? value?.[3])?.trim();
    if (!pattern) {
      result.unresolved.push('pnpm-workspace.yaml uses unsupported or commented packages syntax');
      return configured;
    }
    parsed.push(pattern);
  }
  return parsed;
}

function packageFiles(rootPackagePath, rootPackage) {
  const patterns = workspacePatterns(rootPackage);
  const included = new Set([rootPackagePath]);
  const excluded = new Set();
  for (const pattern of patterns) {
    const unsigned = pattern.startsWith('!') ? pattern.slice(1) : pattern;
    if (!unsigned || /^[A-Za-z]:/.test(unsigned) || path.isAbsolute(unsigned) || unsigned.split(/[\\/]/).includes('..')) {
      result.unresolved.push(`Unsafe workspace pattern: ${pattern}`);
      continue;
    }
    const target = `${unsigned.replace(/\/$/, '')}/package.json`;
    const destination = pattern.startsWith('!') ? excluded : included;
    for (const file of globSync(target, { cwd: repositoryRoot, exclude: ['**/node_modules/**', '**/.git/**'] })) {
      const absolute = path.resolve(repositoryRoot, file);
      if (absolute.startsWith(`${repositoryRoot}${path.sep}`)) destination.add(absolute);
    }
  }
  return [...included].filter(file => !excluded.has(file)).sort((left, right) => relativeDirectory(left).localeCompare(relativeDirectory(right)));
}

function scriptsReachingAliasCycles(scripts) {
  const aliases = new Map();
  for (const [name, script] of Object.entries(scripts)) {
    if (typeof script !== 'string') continue;
    const target = script.trim().match(/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(\S+)$/)?.[1];
    if (target !== undefined) aliases.set(name, target);
  }

  const status = new Map();
  function reachesCycle(name, visiting) {
    const known = status.get(name);
    if (known !== undefined) return known;
    if (visiting.has(name)) return true;
    const target = aliases.get(name);
    if (target === undefined || !Object.hasOwn(scripts, target)) {
      status.set(name, false);
      return false;
    }
    visiting.add(name);
    const cyclic = reachesCycle(target, visiting);
    visiting.delete(name);
    status.set(name, cyclic);
    return cyclic;
  }

  return new Set([...aliases.keys()].filter(name => reachesCycle(name, new Set())));
}

function category(name, script) {
  if (/^(?:dev|start|serve|watch)(?::|$)/.test(name)) return undefined;
  const command = script.trim();
  const recognizedName = /^(?:format|format:check|fmt|prettier|eslint|oxlint|fallow|lint(?::[\w-]+)?|typecheck|type-check|tsc|check(?::[\w-]+)?|test|unit|test:unit|test-unit|unit-test|unit:test)$/.test(name);
  const fullName = /^(?:build|check:all|check-all|e2e|test:e2e|test-e2e|test:browser|test:integration)$/.test(name);
  if (!recognizedName && !fullName) return undefined;

  const startsServer = /^(?:vite(?:\s|$)(?!.*\bbuild\b)|webpack\s+serve\b)/.test(command)
    || /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|watch)(?::|\s|$)/.test(command);
  const mutatingOrPersistentName = /^lint(?::[\w-]*(?:fix|watch|serve)[\w-]*)$/i.test(name);
  if (mutatingOrPersistentName || /(?:^|\s)--(?:watch(?:All)?|fix|serve|ui)\b/i.test(command) || startsServer) return 'unsafe';
  if (fullName) return 'full';
  if (/(&&|\|\||;)|^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?[\w:-]+/.test(command)) return 'full';
  if (/^(?:eslint|playwright|cypress|vite\s+build|tsc\s+-b|webpack|rollup)\b/.test(command)) return 'full';
  if (/^(?:prettier|biome\s+(?:format|check)|dprint(?:\s+(?:fmt|check))?|tsc|svelte-check|vitest\s+run\b|jest|mocha|ava|tap|oxlint|fallow|node\s+--test|tsx\s+--test)\b/.test(command)) return 'fast';
  return 'full';
}

const repositoryConfigPath = path.join(repositoryRoot, 'mpxconfig.json');
const configPath = explicitConfigPath ?? repositoryConfigPath;
const configLabel = explicitConfigPath ? 'config JSON file' : 'mpxconfig.json';
let config;
if (existsSync(configPath)) config = readJson(configPath, configLabel);
else if (explicitConfigPath) result.unresolved.push(`No config JSON file found at ${configPath}`);
else config = {};
const fastOverride = config ? configuredChecks(config, 'fast_checks', configLabel) : undefined;
const fullOverride = config ? configuredChecks(config, 'full_checks', configLabel) : undefined;
if (fastOverride !== undefined && fullOverride !== undefined) {
  result.fast_checks = fastOverride;
  result.full_checks = fullOverride;
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}
const rootPackagePath = path.join(repositoryRoot, 'package.json');

if (!existsSync(rootPackagePath)) {
  if (fastOverride !== undefined) result.fast_checks = fastOverride;
  if (fullOverride !== undefined) result.full_checks = fullOverride;
  if (fastOverride === undefined || fullOverride === undefined) result.unresolved.push(`No package.json found at ${rootPackagePath}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}

const rootPackage = readJson(rootPackagePath, 'package.json');
const manager = packageManager(rootPackage, config);
if (rootPackage && manager && (fastOverride === undefined || fullOverride === undefined)) {
  for (const packageFile of packageFiles(rootPackagePath, rootPackage)) {
    const packageJson = packageFile === rootPackagePath ? rootPackage : readJson(packageFile, relativeDirectory(packageFile));
    if (!packageJson || !packageJson.scripts || typeof packageJson.scripts !== 'object') continue;
    const entries = Object.entries(packageJson.scripts);
    const cyclicAliases = scriptsReachingAliasCycles(packageJson.scripts);
    for (const [name, script] of entries) {
      if (typeof script !== 'string') continue;
      const classified = category(name, script);
      if (!classified) continue;
      if (cyclicAliases.has(name)) {
        result.unresolved.push(`Cyclic check script ${relativeDirectory(packageFile)}:${name}`);
        continue;
      }
      if (classified === 'unsafe') {
        result.unresolved.push(`Unsafe or unknown check script ${relativeDirectory(packageFile)}:${name}`);
        continue;
      }
      const check = { command: `${manager} run ${name}`, cwd: relativeDirectory(packageFile) };
      if (classified === 'fast' && fastOverride === undefined) result.fast_checks.push(check);
      if (classified === 'full' && fullOverride === undefined) result.full_checks.push(check);
    }
  }
}
if (fastOverride === undefined) {
  result.fast_checks.sort((left, right) => Number(!/\srun\s+(?:format|fmt|prettier)$/.test(left.command)) - Number(!/\srun\s+(?:format|fmt|prettier)$/.test(right.command)));
} else result.fast_checks = fastOverride;
if (fullOverride !== undefined) result.full_checks = fullOverride;
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

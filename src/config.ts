import { execFile } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const TRUSTED_GIT_CWD = path.dirname(fileURLToPath(import.meta.url));
import type {
  Account,
  Harness,
  PackSelection,
  ProjectSelection,
  RepositoryConfig,
  UserConfig,
} from './contracts.js';

const execFileAsync = promisify(execFile);
const PACK_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const REPOSITORY_PROVIDERS = new Set(['github', 'gitlab', 'gerrit']);
const ISSUE_PROVIDERS = new Set(['github', 'kanbanflow']);
const PACKAGE_MANAGERS = new Set(['pnpm', 'npm', 'yarn', 'bun']);
const APPROVED_ENVIRONMENT = new Set([
  'MPX_PROJECTS',
  'MPX_WORK',
  'MPX_CLONED',
  'MPX_APPS',
  'MPX_ONEDRIVE',
  'MPX_AI_GENERATED',
  'MPX_OBSIDIAN_VAULT',
  'MPX_PI_EXECUTABLE',
  'MPX_CLAUDE_EXECUTABLE',
]);

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonemptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function allowedKeys(source: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extra = Object.keys(source).find((key) => !allowed.includes(key));
  if (extra !== undefined) throw new Error(`${label} contains unsupported field ${extra}`);
}

function packNames(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const result = value.map((entry, index) => {
    const name = nonemptyString(entry, `${label}[${index}]`);
    if (!PACK_NAME.test(name)) {
      throw new Error(`${label}[${index}] must be a safe lowercase bare pack name`);
    }
    return name;
  });
  if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicate packs`);
  return result;
}

export function parseRepositoryConfig(value: unknown): RepositoryConfig {
  const source = object(value, 'repository config');
  allowedKeys(source, ['projectId', 'repository', 'issues', 'packageManager', 'packs'], 'repository config');
  const projectId = nonemptyString(source.projectId, 'projectId');

  const repositorySource = object(source.repository, 'repository');
  allowedKeys(repositorySource, ['provider', 'remote'], 'repository');
  const repositoryProvider = nonemptyString(repositorySource.provider, 'repository provider');
  if (!REPOSITORY_PROVIDERS.has(repositoryProvider)) {
    throw new Error(`unsupported repository provider: ${repositoryProvider}`);
  }
  const remote = nonemptyString(repositorySource.remote, 'repository remote');

  const issuesSource = object(source.issues, 'issues');
  allowedKeys(issuesSource, ['provider', 'metadata'], 'issues');
  const issueProvider = nonemptyString(issuesSource.provider, 'issue provider');
  if (issueProvider === 'local') throw new Error('local issues are unsupported');
  if (!ISSUE_PROVIDERS.has(issueProvider)) throw new Error(`unsupported issue provider: ${issueProvider}`);
  let metadata: Record<string, unknown> | undefined;
  if (issuesSource.metadata !== undefined) metadata = object(issuesSource.metadata, 'issues.metadata');

  let packageManager: RepositoryConfig['packageManager'];
  if (source.packageManager !== undefined) {
    const manager = nonemptyString(source.packageManager, 'packageManager');
    if (!PACKAGE_MANAGERS.has(manager)) throw new Error(`unsupported packageManager: ${manager}`);
    packageManager = manager as RepositoryConfig['packageManager'];
  }

  const result: RepositoryConfig = {
    projectId,
    repository: {
      provider: repositoryProvider as RepositoryConfig['repository']['provider'],
      remote,
    },
    issues: {
      provider: issueProvider as RepositoryConfig['issues']['provider'],
      ...(metadata === undefined ? {} : { metadata }),
    },
  };
  if (packageManager !== undefined) result.packageManager = packageManager;
  if (source.packs !== undefined) result.packs = packNames(source.packs, 'packs');
  return result;
}

function expandPath(value: unknown, label: string, env: NodeJS.ProcessEnv): string {
  const input = nonemptyString(value, label);
  const expanded = input.replace(/\$\{([^}]+)\}/g, (_match, name: string) => {
    if (!APPROVED_ENVIRONMENT.has(name)) throw new Error(`${label} uses unsupported environment variable ${name}`);
    const replacement = env[name];
    if (!replacement) throw new Error(`${label} requires ${name}, but it is not set`);
    return replacement;
  });
  if (expanded.includes('${')) throw new Error(`${label} contains malformed environment expansion`);
  if (!path.isAbsolute(expanded)) throw new Error(`${label} must be an absolute path`);
  return path.normalize(expanded);
}

async function comparablePath(value: string): Promise<string> {
  try {
    return normalizeForComparison(await realpath(value));
  } catch {
    return normalizeForComparison(path.resolve(value));
  }
}

function normalizeForComparison(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export async function readUserConfig(
  file: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UserConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read user config ${path.normalize(file)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const source = object(parsed, 'user config');
  allowedKeys(source, ['accounts', 'domains', 'defaultPacks', 'executables', 'piTitle'], 'user config');
  const accountsSource = object(source.accounts, 'accounts');
  const domainsSource = object(source.domains, 'domains');
  allowedKeys(accountsSource, ['personal', 'work'], 'accounts');
  allowedKeys(domainsSource, ['personal', 'work'], 'domains');
  const accounts = {} as UserConfig['accounts'];
  const domains = {} as UserConfig['domains'];

  for (const account of ['personal', 'work'] as const) {
    const accountSource = object(accountsSource[account], `accounts.${account}`);
    allowedKeys(accountSource, ['pi', 'claude'], `accounts.${account}`);
    accounts[account] = {
      pi: expandPath(accountSource.pi, `accounts.${account}.pi`, env),
      claude: expandPath(accountSource.claude, `accounts.${account}.claude`, env),
    };
    const domainSource = domainsSource[account];
    if (!Array.isArray(domainSource)) throw new Error(`domains.${account} must be an array`);
    domains[account] = domainSource.map((entry, index) =>
      expandPath(entry, `domains.${account}[${index}]`, env));
  }

  for (const harness of ['pi', 'claude'] as const) {
    if (await comparablePath(accounts.personal[harness]) === await comparablePath(accounts.work[harness])) {
      throw new Error(`personal and work ${harness} account roots resolve to the same path`);
    }
  }

  const personalDomains = await Promise.all(domains.personal.map(comparablePath));
  const workDomains = new Set(await Promise.all(domains.work.map(comparablePath)));
  if (personalDomains.some((domain) => workDomains.has(domain))) {
    throw new Error('ambiguous personal/work domain root is configured for both accounts');
  }

  const result: UserConfig = { accounts, domains };
  if (source.defaultPacks !== undefined) {
    const defaultsSource = object(source.defaultPacks, 'defaultPacks');
    allowedKeys(defaultsSource, ['personal', 'work'], 'defaultPacks');
    const defaults: NonNullable<UserConfig['defaultPacks']> = {};
    for (const account of ['personal', 'work'] as const) {
      if (defaultsSource[account] !== undefined) {
        defaults[account] = packNames(defaultsSource[account], `defaultPacks.${account}`);
      }
    }
    result.defaultPacks = defaults;
  }
  if (source.executables !== undefined) {
    const executablesSource = object(source.executables, 'executables');
    allowedKeys(executablesSource, ['pi', 'claude'], 'executables');
    const executables: NonNullable<UserConfig['executables']> = {};
    for (const harness of ['pi', 'claude'] as const) {
      if (executablesSource[harness] !== undefined) {
        executables[harness] = expandPath(executablesSource[harness], `executables.${harness}`, env);
      }
    }
    result.executables = executables;
  }
  if (source.piTitle !== undefined) {
    const title = object(source.piTitle, 'piTitle');
    allowedKeys(title, ['provider', 'model', 'thinking'], 'piTitle');
    const thinking = nonemptyString(title.thinking, 'piTitle.thinking');
    if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking)) throw new Error('Invalid title thinking level.');
    result.piTitle = { provider: nonemptyString(title.provider, 'piTitle.provider'), model: nonemptyString(title.model, 'piTitle.model'), thinking: thinking as NonNullable<UserConfig['piTitle']>['thinking'] };
  }
  return result;
}

export async function resolveProject(cwd: string): Promise<ProjectSelection> {
  let firstWorktree: string[];
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', cwd, 'worktree', 'list', '--porcelain', '-z'],
      { cwd: TRUSTED_GIT_CWD, encoding: 'utf8', windowsHide: true, timeout: 3000 },
    );
    const firstRecord = stdout.split('\0\0', 1)[0];
    firstWorktree = firstRecord?.split('\0').filter(Boolean) ?? [];
  } catch {
    return { warnings: [] };
  }
  if (firstWorktree.includes('bare')) return { warnings: [] };
  const worktreeField = firstWorktree.find((field) => field.startsWith('worktree '));
  if (worktreeField === undefined) return { warnings: [] };

  let checkoutCandidate = worktreeField.slice('worktree '.length);
  try {
    const { stdout: commonOutput } = await execFileAsync(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: TRUSTED_GIT_CWD, encoding: 'utf8', windowsHide: true, timeout: 3000 },
    );
    const commonDirectory = path.resolve(commonOutput.trim());
    if (normalizeForComparison(checkoutCandidate) === normalizeForComparison(commonDirectory)) {
      try {
        const { stdout: worktreeOutput } = await execFileAsync(
          'git',
          ['-C', cwd, 'config', '--path', '--get', 'core.worktree'],
          { cwd: TRUSTED_GIT_CWD, encoding: 'utf8', windowsHide: true, timeout: 3000 },
        );
        const configuredWorktree = worktreeOutput.trim();
        if (configuredWorktree !== '') {
          checkoutCandidate = path.isAbsolute(configuredWorktree)
            ? configuredWorktree
            : path.resolve(commonDirectory, configuredWorktree);
        }
      } catch {
        try {
          const [{ stdout: gitDirectoryOutput }, { stdout: topLevelOutput }] = await Promise.all([
            execFileAsync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-dir'], {
              cwd: TRUSTED_GIT_CWD, encoding: 'utf8', windowsHide: true, timeout: 3000,
            }),
            execFileAsync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--show-toplevel'], {
              cwd: TRUSTED_GIT_CWD, encoding: 'utf8', windowsHide: true, timeout: 3000,
            }),
          ]);
          if (normalizeForComparison(gitDirectoryOutput.trim()) === normalizeForComparison(commonDirectory)) {
            checkoutCandidate = topLevelOutput.trim();
          }
        } catch {
          // Without explicit reverse metadata, a linked worktree cannot identify an external main checkout.
        }
      }
    }
  } catch {
    return { warnings: [] };
  }

  let mainCheckout: string;
  try {
    mainCheckout = await realpath(checkoutCandidate);
  } catch {
    mainCheckout = path.resolve(checkoutCandidate);
  }
  mainCheckout = path.normalize(mainCheckout);
  const manifest = path.join(mainCheckout, 'mpxconfig.json');

  let text: string;
  try {
    text = await readFile(manifest, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { mainCheckout, warnings: [] };
    return { mainCheckout, warnings: [`mpxconfig.json is invalid: ${error instanceof Error ? error.message : String(error)}`] };
  }
  try {
    return { mainCheckout, config: parseRepositoryConfig(JSON.parse(text)), warnings: [] };
  } catch (error) {
    return {
      mainCheckout,
      warnings: [`mpxconfig.json is invalid: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

function defaultPacks(account: Account, user?: UserConfig): string[] {
  const configured = user?.defaultPacks?.[account];
  if (configured !== undefined) return [...configured];
  return account === 'personal' ? ['development', 'personal'] : ['development'];
}

function packDirectory(root: string, pack: string, harness: Harness): string {
  return harness === 'pi'
    ? path.join(root, 'dist', 'packs', pack, 'pi', 'skills')
    : path.join(root, 'dist', 'packs', pack, 'claude');
}

async function availablePaths(root: string, harness: Harness, packs: string[]): Promise<string[] | undefined> {
  const packRoot = path.resolve(root, 'dist', 'packs');
  const comparableRoot = `${normalizeForComparison(packRoot)}${path.sep}`;
  const paths: string[] = [];
  for (const pack of packs) {
    if (!PACK_NAME.test(pack)) return undefined;
    const candidate = packDirectory(root, pack, harness);
    try {
      if (!(await stat(candidate)).isDirectory()) return undefined;
      const resolved = path.normalize(await realpath(candidate));
      if (!normalizeForComparison(resolved).startsWith(comparableRoot)) return undefined;
      paths.push(resolved);
    } catch {
      return undefined;
    }
  }
  return paths;
}

export async function selectPacks(
  root: string,
  harness: Harness,
  account: Account,
  project: ProjectSelection,
  user?: UserConfig,
): Promise<PackSelection> {
  const warnings = [...project.warnings];
  const explicit = project.config?.packs;
  if (explicit !== undefined) {
    if (explicit.length === 0) return { packs: [], paths: [], warnings };
    const explicitPaths = await availablePaths(root, harness, explicit);
    if (explicitPaths !== undefined) return { packs: [...explicit], paths: explicitPaths, warnings };
    warnings.push('repository pack selection is invalid or unavailable; using account fallback defaults');
  }

  const fallback = defaultPacks(account, user);
  if (fallback.length === 0) return { packs: [], paths: [], warnings };
  const fallbackPaths = await availablePaths(root, harness, fallback);
  if (fallbackPaths === undefined) {
    warnings.push('fallback MPX pack paths are unavailable; continuing with native skills only');
    return { packs: [], paths: [], warnings };
  }
  return { packs: fallback, paths: fallbackPaths, warnings };
}

import { execFile } from 'node:child_process';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const TRUSTED_GIT_CWD = path.dirname(fileURLToPath(import.meta.url));
import type {
  Account,
  Harness,
  PackSelection,
  ProjectOverride,
  ProjectSelection,
  RepositoryConfig,
  UserConfig,
} from './contracts.js';
import { LAUNCH_WARNING_CODE, sortLaunchWarnings, WARNING_SEVERITY } from './contracts.js';

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

  let repository: RepositoryConfig['repository'];
  if (source.repository !== undefined) {
    const repositorySource = object(source.repository, 'repository');
    allowedKeys(repositorySource, ['provider', 'remote'], 'repository');
    const repositoryProvider = nonemptyString(repositorySource.provider, 'repository provider');
    if (!REPOSITORY_PROVIDERS.has(repositoryProvider)) {
      throw new Error(`unsupported repository provider: ${repositoryProvider}`);
    }
    repository = {
      provider: repositoryProvider as NonNullable<RepositoryConfig['repository']>['provider'],
      remote: nonemptyString(repositorySource.remote, 'repository remote'),
    };
  }

  let issues: RepositoryConfig['issues'];
  if (source.issues !== undefined) {
    const issuesSource = object(source.issues, 'issues');
    allowedKeys(issuesSource, ['provider', 'metadata'], 'issues');
    const issueProvider = nonemptyString(issuesSource.provider, 'issue provider');
    if (issueProvider === 'local') throw new Error('local issues are unsupported');
    if (!ISSUE_PROVIDERS.has(issueProvider)) throw new Error(`unsupported issue provider: ${issueProvider}`);
    const metadata = issuesSource.metadata === undefined ? undefined : object(issuesSource.metadata, 'issues.metadata');
    issues = {
      provider: issueProvider as NonNullable<RepositoryConfig['issues']>['provider'],
      ...(metadata === undefined ? {} : { metadata }),
    };
  }

  let packageManager: RepositoryConfig['packageManager'];
  if (source.packageManager !== undefined) {
    const manager = nonemptyString(source.packageManager, 'packageManager');
    if (!PACKAGE_MANAGERS.has(manager)) throw new Error(`unsupported packageManager: ${manager}`);
    packageManager = manager as RepositoryConfig['packageManager'];
  }

  const result: RepositoryConfig = { projectId };
  if (repository !== undefined) result.repository = repository;
  if (issues !== undefined) result.issues = issues;
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
  allowedKeys(source, ['accounts', 'domains', 'projectOverrides', 'defaultPacks', 'executables', 'piTitle'], 'user config');
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
  if (source.projectOverrides !== undefined) {
    if (!Array.isArray(source.projectOverrides)) throw new Error('projectOverrides must be an array');
    const overrides: ProjectOverride[] = [];
    const diagnostics: NonNullable<UserConfig['projectOverrideDiagnostics']> = [];
    source.projectOverrides.forEach((value, index) => {
      const label = `projectOverrides[${index}]`;
      const entry = object(value, label);
      const overridePath = expandPath(entry.path, `${label}.path`, env);
      try {
        allowedKeys(entry, ['path', 'config', 'omitConfig'], label);
        if ((entry.config === undefined) === (entry.omitConfig === undefined)) {
          throw new Error(`${label} must specify exactly one of config or omitConfig`);
        }
        if (entry.omitConfig !== undefined) {
          if (entry.omitConfig !== true) throw new Error(`${label}.omitConfig must be true`);
          overrides.push({ path: overridePath, omitConfig: true });
        } else {
          overrides.push({ path: overridePath, config: parseRepositoryConfig(entry.config) });
        }
      } catch (error) {
        diagnostics.push({ path: overridePath, message: error instanceof Error ? error.message : String(error) });
      }
    });
    result.projectOverrides = overrides;
    if (diagnostics.length > 0) result.projectOverrideDiagnostics = diagnostics;
  }
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

export interface ResolveProjectOptions {
  gitExecutable?: string;
  gitArguments?: string[];
}

type GitDiscovery =
  | { kind: 'repository'; mainCheckout?: string }
  | { kind: 'non-git' }
  | { kind: 'failure'; reason: string };

function gitFailureReason(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    if ('stderr' in error && typeof error.stderr === 'string' && error.stderr.trim() !== '') return error.stderr.trim();
    if ('message' in error && typeof error.message === 'string' && error.message.trim() !== '') return error.message.trim();
  }
  return String(error);
}

async function hasGitBoundary(cwd: string): Promise<boolean> {
  let directory = path.resolve(cwd);
  while (true) {
    try {
      await lstat(path.join(directory, '.git'));
      return true;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') return true;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

async function discoverGit(cwd: string, options: ResolveProjectOptions): Promise<GitDiscovery> {
  const executable = options.gitExecutable ?? 'git';
  const prefix = options.gitArguments ?? [];
  const run = (args: string[]) => execFileAsync(executable, [...prefix, ...args], {
    cwd: TRUSTED_GIT_CWD, encoding: 'utf8', windowsHide: true, timeout: 3000,
  });
  try {
    const { stdout } = await run(['-C', cwd, 'rev-parse', '--is-inside-work-tree', '--is-bare-repository']);
    const values = stdout.trim().split(/\r?\n/);
    if (values[1] === 'true') return { kind: 'repository' };
    if (values[0] !== 'true') return { kind: 'failure', reason: `Unexpected Git repository probe output: ${stdout.trim() || '(empty)'}` };
  } catch (error) {
    const reason = gitFailureReason(error);
    if (/^fatal: not a git repository \(or any (?:of the parent directories|parent up to mount point [^)]+)\):? /i.test(reason)
      && !(await hasGitBoundary(cwd))) return { kind: 'non-git' };
    return { kind: 'failure', reason };
  }

  let firstWorktree: string[];
  try {
    const { stdout } = await run(['-C', cwd, 'worktree', 'list', '--porcelain', '-z']);
    const firstRecord = stdout.split('\0\0', 1)[0];
    firstWorktree = firstRecord?.split('\0').filter(Boolean) ?? [];
  } catch (error) {
    return { kind: 'failure', reason: gitFailureReason(error) };
  }
  const worktreeField = firstWorktree.find(field => field.startsWith('worktree '));
  if (worktreeField === undefined) return { kind: 'failure', reason: 'Git returned no main worktree metadata.' };
  let checkoutCandidate = worktreeField.slice('worktree '.length);
  try {
    const { stdout: commonOutput } = await run(['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    const commonDirectory = path.resolve(commonOutput.trim());
    if (normalizeForComparison(checkoutCandidate) === normalizeForComparison(commonDirectory)) {
      try {
        const { stdout } = await run(['-C', cwd, 'config', '--path', '--get', 'core.worktree']);
        const configured = stdout.trim();
        if (configured !== '') checkoutCandidate = path.isAbsolute(configured) ? configured : path.resolve(commonDirectory, configured);
      } catch {
        try {
          const [{ stdout: gitDirectory }, { stdout: topLevel }] = await Promise.all([
            run(['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-dir']),
            run(['-C', cwd, 'rev-parse', '--path-format=absolute', '--show-toplevel']),
          ]);
          if (normalizeForComparison(gitDirectory.trim()) === normalizeForComparison(commonDirectory)) checkoutCandidate = topLevel.trim();
        } catch {}
      }
    }
  } catch (error) {
    return { kind: 'failure', reason: gitFailureReason(error) };
  }
  try { return { kind: 'repository', mainCheckout: path.normalize(await realpath(checkoutCandidate)) }; }
  catch { return { kind: 'repository', mainCheckout: path.normalize(path.resolve(checkoutCandidate)) }; }
}

function contains(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

type ProjectOverrideMatch = ProjectOverride | { path: string; invalidConfig: string };
async function matchingOverride(
  target: string,
  gitRepository: boolean,
  user?: UserConfig,
): Promise<ProjectOverrideMatch | undefined> {
  const targetComparable = await comparablePath(target);
  const candidates: ProjectOverrideMatch[] = [
    ...(user?.projectOverrides ?? []),
    ...(user?.projectOverrideDiagnostics ?? []).map(diagnostic => ({ path: diagnostic.path, invalidConfig: diagnostic.message })),
  ];
  const matches: { override: ProjectOverrideMatch; comparable: string }[] = [];
  for (const override of candidates) {
    const comparable = await comparablePath(override.path);
    if (gitRepository ? comparable === targetComparable : contains(targetComparable, comparable)) {
      matches.push({ override, comparable });
    }
  }
  matches.sort((left, right) => right.comparable.length - left.comparable.length);
  return matches[0]?.override;
}

export async function resolveProject(
  cwd: string,
  user?: UserConfig,
  options: ResolveProjectOptions = {},
): Promise<ProjectSelection> {
  const discovery = await discoverGit(cwd, options);
  const mainCheckout = discovery.kind === 'repository' ? discovery.mainCheckout : undefined;
  const target = mainCheckout ?? path.normalize(await realpath(cwd).catch(() => path.resolve(cwd)));
  const discoveryWarnings = discovery.kind === 'failure' ? [{
    code: LAUNCH_WARNING_CODE.projectDiscoveryFailed,
    severity: WARNING_SEVERITY.orange,
    message: `Git project discovery failed for ${path.normalize(cwd)}: ${discovery.reason}`,
  } as const] : [];
  const selection = (value: Omit<ProjectSelection, 'warnings'> & { warnings?: ProjectSelection['warnings'] }): ProjectSelection => ({
    ...value,
    warnings: sortLaunchWarnings([...discoveryWarnings, ...(value.warnings ?? [])]),
  });
  const manifest = path.join(target, 'mpxconfig.json');
  let text: string | undefined;
  try { text = await readFile(manifest, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return selection({
        ...(mainCheckout ? { mainCheckout } : {}), configPath: manifest,
        warnings: [{ code: LAUNCH_WARNING_CODE.projectConfigInvalid, severity: WARNING_SEVERITY.orange, message: `${manifest} is invalid: ${error instanceof Error ? error.message : String(error)}` }],
      });
    }
  }
  if (text !== undefined) {
    try {
      return selection({ ...(mainCheckout ? { mainCheckout } : {}), config: parseRepositoryConfig(JSON.parse(text)), configSource: 'manifest', configPath: manifest });
    } catch (error) {
      return selection({
        ...(mainCheckout ? { mainCheckout } : {}), configPath: manifest,
        warnings: [{ code: LAUNCH_WARNING_CODE.projectConfigInvalid, severity: WARNING_SEVERITY.orange, message: `${manifest} is invalid: ${error instanceof Error ? error.message : String(error)}` }],
      });
    }
  }
  const hasRepositoryBoundary = discovery.kind !== 'non-git';
  const override = await matchingOverride(target, hasRepositoryBoundary, user);
  if (override) {
    const configPath = path.normalize(await realpath(override.path).catch(() => path.resolve(override.path)));
    if ('config' in override) return selection({ ...(mainCheckout ? { mainCheckout } : {}), config: override.config, configSource: 'override', configPath });
    if ('omitConfig' in override) return selection({ ...(mainCheckout ? { mainCheckout } : {}), configPath, configOmitted: true });
    return selection({
      ...(mainCheckout ? { mainCheckout } : {}), configPath,
      warnings: [{ code: LAUNCH_WARNING_CODE.projectOverrideInvalid, severity: WARNING_SEVERITY.orange, message: `Project override is invalid: ${override.invalidConfig}` }],
    });
  }
  if (discovery.kind === 'failure') return selection({});
  return selection({
    ...(mainCheckout ? { mainCheckout } : {}),
    warnings: [{ code: LAUNCH_WARNING_CODE.projectConfigMissing, severity: WARNING_SEVERITY.yellow, message: `No project configuration applies to ${target}.` }],
  });
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
    warnings.push({ code: LAUNCH_WARNING_CODE.packFallback, severity: WARNING_SEVERITY.orange, message: 'Repository pack selection is invalid or unavailable; using account fallback defaults.' });
  }

  const fallback = defaultPacks(account, user);
  if (fallback.length === 0) return { packs: [], paths: [], warnings };
  const fallbackPaths = await availablePaths(root, harness, fallback);
  if (fallbackPaths === undefined) {
    warnings.push({ code: LAUNCH_WARNING_CODE.nativeOnly, severity: WARNING_SEVERITY.orange, message: 'Fallback MPX pack paths are unavailable; continuing with native skills only.' });
    return { packs: [], paths: [], warnings };
  }
  return { packs: fallback, paths: fallbackPaths, warnings };
}

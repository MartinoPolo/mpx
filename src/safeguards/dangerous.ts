import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const TRUSTED_GIT_CWD = path.dirname(fileURLToPath(import.meta.url));
import type { PolicyResult } from './contracts.js';
import { inspectStaticShell } from './shell.js';

interface Word {
  readonly value: string;
  readonly dynamic: boolean;
}

type Token = Word | { readonly operator: string };

const MAX_COMMAND_LENGTH = 64 * 1024;
const GIT_TIMEOUT_MS = 2_000;
const PROTECTED_BRANCHES = new Set(['main', 'master', 'dev', 'prod']);
const PROTECTED_DELETE_COMPONENTS = new Set([
  '.git',
  'src',
  'source',
  'package',
  'packages',
  'worktree',
  'worktrees',
]);
const SCRATCH_COMPONENTS = new Set(['.tmp', '.temp', '.scratch', 'tmp', 'temp', 'scratch']);
const GENERATED_COMPONENTS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.svelte-kit',
  '.nuxt',
  'coverage',
  '.cache',
  'cache',
  '.vite',
  '.tmp',
  '.temp',
  '.scratch',
  'tmp',
  'temp',
  'scratch',
  '.turbo',
  '.parcel-cache',
  '.output',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'target',
]);

function executableName(value: string): string {
  return value.split(/[\\/]/u).at(-1)?.replace(/\.(?:exe|cmd|bat)$/iu, '').toLowerCase() ?? '';
}

function isOperator(token: Token): token is { readonly operator: string } {
  return 'operator' in token;
}

/** Pure path check used by shell, edit, write, and patch transports before file creation. */
export function isWindowsNulFileTarget(target: string): boolean {
  let value = target.trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  const basename = value.split(/[\\/]/u).filter(Boolean).at(-1) ?? '';
  return /^nul(?:\..*)?$/iu.test(basename.replace(/[ .]+$/u, ''));
}

function tokenize(command: string): { tokens: Token[]; malformed: boolean } {
  const tokens: Token[] = [];
  let value = '';
  let dynamic = false;
  let quote: "'" | '"' | undefined;
  let malformed = false;

  const finishWord = (): void => {
    if (value !== '' || dynamic) tokens.push({ value, dynamic });
    value = '';
    dynamic = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? '';
    if (quote === "'") {
      if (character === "'") quote = undefined;
      else value += character;
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = undefined;
      } else if (character === '\\') {
        const next = command[index + 1];
        if (next !== undefined && ['$', '`', '"', '\\', '\n'].includes(next)) {
          value += next === '\n' ? '' : next;
          index += 1;
        } else {
          value += character;
        }
      } else {
        value += character;
        if (character === '$' || character === '`') dynamic = true;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '\\') {
      const next = command[index + 1];
      if (next === undefined) {
        malformed = true;
      } else if (/\s|[;'"|&<>\\$`]/u.test(next)) {
        value += next;
        index += 1;
      } else {
        value += character;
      }
      continue;
    }
    if (character === '#' && value === '') {
      while (index < command.length && command[index] !== '\n') index += 1;
      index -= 1;
      continue;
    }
    if (/\s/u.test(character)) {
      finishWord();
      if (character === '\n' || character === '\r') tokens.push({ operator: ';' });
      continue;
    }
    const pair = `${character}${command[index + 1] ?? ''}`;
    if (['&&', '||', '>>'].includes(pair)) {
      finishWord();
      tokens.push({ operator: pair });
      index += 1;
      continue;
    }
    if (';|&>'.includes(character)) {
      finishWord();
      tokens.push({ operator: character });
      continue;
    }
    value += character;
    if (character === '$' || character === '`') dynamic = true;
  }
  if (quote) malformed = true;
  finishWord();
  return { tokens, malformed };
}

function hasOpaqueCommandExpansion(command: string): boolean {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? '';
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = undefined;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = undefined;
      else if (character === '`' || (character === '$' && command[index + 1] === '(')) return true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '`' || ((character === '$' || character === '<' || character === '>') && command[index + 1] === '(')) {
      return true;
    }
  }
  return false;
}

function commandSegments(tokens: readonly Token[]): Word[][] {
  const segments: Word[][] = [];
  let words: Word[] = [];
  let skipRedirectTarget = false;
  for (const token of tokens) {
    if (isOperator(token)) {
      if (token.operator === '>' || token.operator === '>>') {
        if (words.at(-1)?.value.match(/^\d+$/u)) words.pop();
        skipRedirectTarget = true;
        continue;
      }
      if (words.length > 0) segments.push(words);
      words = [];
      skipRedirectTarget = false;
      continue;
    }
    if (skipRedirectTarget) {
      skipRedirectTarget = false;
      continue;
    }
    words.push(token);
  }
  if (words.length > 0) segments.push(words);
  return segments;
}

function hasNulRedirect(tokens: readonly Token[]): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || !isOperator(token) || (token.operator !== '>' && token.operator !== '>>')) continue;
    const target = tokens.slice(index + 1).find((candidate) => !isOperator(candidate));
    if (target && !isOperator(target) && isWindowsNulFileTarget(target.value)) return true;
  }
  return false;
}

function unwrap(words: readonly Word[]): readonly Word[] {
  let result = words;
  while (result.length > 0) {
    while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(result[0]?.value ?? '')) result = result.slice(1);
    const name = executableName(result[0]?.value ?? '');
    if (name === 'command' || name === 'exec' || name === 'time') {
      result = result.slice(1);
      continue;
    }
    if (name === 'sudo') {
      let index = 1;
      const operandOptions = new Set(['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from']);
      while (result[index]?.value.startsWith('-')) {
        const option = result[index]?.value ?? '';
        index += 1;
        if (operandOptions.has(option) && result[index]) index += 1;
      }
      result = result.slice(index);
      continue;
    }
    if (name === 'env') {
      let index = 1;
      while (result[index]) {
        const option = result[index]?.value ?? '';
        if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(option) || ['-i', '--ignore-environment'].includes(option)) {
          index += 1;
        } else if (['-u', '--unset', '-C', '--chdir'].includes(option)) {
          index += 2;
        } else if (option.startsWith('-')) {
          index += 1;
        } else break;
      }
      result = result.slice(index);
      continue;
    }
    break;
  }
  return result;
}

function pathComponents(value: string): string[] {
  return value.replaceAll('\\', '/').split('/').filter((component) => component !== '' && component !== '.');
}

function hasTraversal(value: string): boolean {
  return pathComponents(value).includes('..');
}

function isBroadTarget(value: string): boolean {
  const normalized = value.trim().replace(/[\\/]+$/u, '');
  return normalized === '' || ['.', '..', '/', '\\', '~', '*'].includes(value.trim()) ||
    /^[A-Za-z]:$/u.test(normalized) || /[*?\[]/u.test(value);
}

function beneathSystemTemp(resolved: string): boolean {
  const normalize = (candidate: string): string => {
    const result = path.resolve(candidate);
    return process.platform === 'win32' ? result.toLowerCase() : result;
  };
  const target = normalize(resolved);
  const root = normalize(tmpdir());
  return target !== root && target.startsWith(`${root}${path.sep}`);
}

function safeForcedDeletionTarget(target: Word, cwd: string): boolean {
  if (target.dynamic || hasTraversal(target.value) || target.value.startsWith('~')) return false;
  const components = pathComponents(target.value).map((component) => component.toLowerCase());
  const firstPattern = components.findIndex((component) => /[*?\[]/u.test(component));
  const generated = components.findIndex((component) => GENERATED_COMPONENTS.has(component));
  if (generated >= 0 && (firstPattern < 0 || generated < firstPattern)) return true;
  if (isBroadTarget(target.value)) return false;
  const cwdComponents = pathComponents(cwd).map((component) => component.toLowerCase());
  if (!path.isAbsolute(target.value) && !path.win32.isAbsolute(target.value) && cwdComponents.some((component) => GENERATED_COMPONENTS.has(component) && !SCRATCH_COMPONENTS.has(component))) return true;
  if (components.some((component) => PROTECTED_DELETE_COMPONENTS.has(component))) return false;
  const native = /^\/([A-Za-z])(?:\/(.*))?$/u.exec(target.value);
  const literal = native ? `${native[1]?.toUpperCase()}:/${native[2] ?? ''}` : target.value;
  const resolved = path.isAbsolute(literal) || path.win32.isAbsolute(literal)
    ? path.normalize(literal)
    : path.resolve(cwd, literal);
  return beneathSystemTemp(resolved);
}

function splitCommaTargets(words: readonly Word[]): Word[] {
  return words.flatMap((word) => word.value.includes(',') && !word.dynamic
    ? word.value.split(',').filter(Boolean).map((value) => ({ value, dynamic: false }))
    : [word]);
}

function rmTargets(words: readonly Word[]): { recursive: boolean; force: boolean; targets: Word[] } {
  let recursive = false;
  let force = false;
  let options = true;
  const targets: Word[] = [];
  for (const word of words.slice(1)) {
    if (options && word.value === '--') {
      options = false;
      continue;
    }
    if (options && word.value.startsWith('-')) {
      if (word.value === '--recursive' || /^-[^-]*[rR]/u.test(word.value)) recursive = true;
      if (word.value === '--force' || /^-[^-]*f/u.test(word.value)) force = true;
      continue;
    }
    targets.push(word);
  }
  return { recursive, force, targets };
}

function removeItemTargets(words: readonly Word[]): { recursive: boolean; force: boolean; targets: Word[] } {
  let recursive = false;
  let force = false;
  const targets: Word[] = [];
  const optionsWithValues = new Set(['-filter', '-include', '-exclude', '-stream']);
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    const value = word?.value.toLowerCase() ?? '';
    if (value === '-recurse' || value === '-r') recursive = true;
    else if (value === '-force' || value === '-fo') force = true;
    else if (value === '-path' || value === '-literalpath') {
      if (words[index + 1]) targets.push(words[++index] as Word);
    } else if (optionsWithValues.has(value)) index += 1;
    else if (!value.startsWith('-') && word) targets.push(word);
  }
  return { recursive, force, targets: splitCommaTargets(targets) };
}

function cmdDeletion(words: readonly Word[]): { recursive: boolean; force: boolean; targets: Word[] } {
  let recursive = false;
  let force = false;
  const targets: Word[] = [];
  for (const word of words.slice(1)) {
    const option = word.value.toLowerCase();
    if (option === '/s') recursive = true;
    else if (option === '/q' || option === '/f') force = true;
    else if (!option.startsWith('/')) targets.push(word);
  }
  return { recursive, force, targets };
}

function unsafeForcedDeletion(
  details: { recursive: boolean; force: boolean; targets: readonly Word[] },
  cwd: string,
): boolean {
  return details.recursive && details.force &&
    (details.targets.length === 0 || details.targets.some((target) => !safeForcedDeletionTarget(target, cwd)));
}

function branchName(refspec: string): string | undefined {
  let value = refspec.replace(/^\+/u, '');
  if (value.includes(':')) value = value.slice(value.lastIndexOf(':') + 1);
  value = value.replace(/^refs\/heads\//u, '').replace(/^refs\/remotes\/[^/]+\//u, '');
  if (value === '' || value === 'HEAD' || value.includes('*')) return undefined;
  return value;
}

interface GitInvocation {
  readonly subcommand?: string;
  readonly args: readonly Word[];
  readonly cwd?: string;
}

function parseGit(words: readonly Word[], cwd: string): GitInvocation {
  let index = 1;
  let gitCwd = cwd;
  let inspectable = true;
  while (words[index]?.value.startsWith('-')) {
    const option = words[index]?.value ?? '';
    if (option === '-C') {
      const target = words[index + 1];
      if (!target || target.dynamic) return { args: [], cwd: undefined };
      gitCwd = path.resolve(gitCwd, target.value);
      index += 2;
    } else if (option.startsWith('-C') && option.length > 2) {
      gitCwd = path.resolve(gitCwd, option.slice(2));
      index += 1;
    } else if (['-c', '--config-env', '--git-dir', '--work-tree', '--namespace'].includes(option)) { index += 2; inspectable = false; }
    else { if (/^(?:-c.+|--(?:config-env|git-dir|work-tree|namespace)=)/.test(option)) inspectable = false; index += 1; }
  }
  return { subcommand: words[index]?.value.toLowerCase(), args: words.slice(index + 1), cwd: inspectable ? gitCwd : undefined };
}

function gitCleanDryRun(args: readonly Word[]): boolean {
  const end = args.findIndex(word => word.value === '--');
  return (end < 0 ? args : args.slice(0, end)).some((word) => word.value === '--dry-run' || /^-[^-]*n/u.test(word.value));
}

function runGit(cwd: string, args: readonly string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { cwd: TRUSTED_GIT_CWD, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      if (!error) {
        resolve({ ok: true, stdout: stdout.trim() });
        return;
      }
      const code = (error as NodeJS.ErrnoException & { killed?: boolean }).code;
      if (typeof code === 'number') {
        resolve({ ok: false, stdout: '' });
        return;
      }
      reject(error);
    });
  });
}

async function detectedDefaultBranches(cwd: string, remote: string | undefined): Promise<Set<string>> {
  const repository = await runGit(cwd, ['rev-parse', '--git-dir']);
  if (!repository.ok) throw new Error('the effective directory is not an inspectable Git repository');
  const branches = new Set<string>();
  const remotes = [...new Set([remote, 'origin'].filter((value): value is string => Boolean(value) && !value?.includes('/')))];
  for (const candidate of remotes) {
    const result = await runGit(cwd, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${candidate}/HEAD`]);
    if (result.ok) {
      const branch = result.stdout.startsWith(`${candidate}/`) ? result.stdout.slice(candidate.length + 1) : result.stdout;
      if (branch) branches.add(branch);
    }
  }
  const configured = await runGit(cwd, ['config', '--get', 'init.defaultBranch']);
  if (configured.ok && configured.stdout) branches.add(configured.stdout);
  const hasHead = await runGit(cwd, ['rev-parse', '--verify', 'HEAD']);
  if (!hasHead.ok) {
    const unborn = await runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (unborn.ok && unborn.stdout) branches.add(unborn.stdout);
  }
  return branches;
}

interface PushDetails {
  readonly forced: boolean;
  readonly remote?: string;
  readonly branches: readonly string[];
  readonly broad: boolean;
}

function pushDetails(args: readonly Word[]): PushDetails {
  let forced = false;
  let broad = false;
  const positional: Word[] = [];
  let selectedRemote: string | undefined;
  const valueOptions = new Set(['--repo', '--receive-pack', '--exec', '-o', '--push-option']);
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    const value = word?.value ?? '';
    if (value === '--force' || value === '--mirror' || /^-[^-]*f/u.test(value) || value.startsWith('--force-with-lease')) forced = true;
    if (value === '--all' || value === '--mirror') broad = true;
    if (value === '--') {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (value.startsWith('-')) {
      const option = value.split('=', 1)[0] ?? value;
      if (option === '--repo') selectedRemote = value.includes('=') ? value.slice(value.indexOf('=') + 1) : args[index + 1]?.value;
      if (!value.includes('=') && valueOptions.has(option)) index += 1;
      continue;
    }
    positional.push(word as Word);
  }
  const remote = selectedRemote ?? (positional[0]?.dynamic ? undefined : positional[0]?.value);
  const refs = selectedRemote === undefined ? positional.slice(1) : positional;
  return {
    forced: forced || refs.some((word) => word.value.startsWith('+')),
    remote,
    branches: refs.filter((word) => !word.dynamic).map((word) => branchName(word.value)).filter((value): value is string => Boolean(value)),
    broad: broad || refs.some((word) => word.dynamic),
  };
}

async function findDeleteIsBroad(words: readonly Word[], cwd: string): Promise<boolean> {
  const deleteIndex = words.findIndex((word) => word.value.toLowerCase() === '-delete');
  if (deleteIndex < 0) return false;
  const starts = words.slice(1, deleteIndex).filter((word) => !word.value.startsWith('-'));
  if (starts.length === 0) return true;
  let repositoryRoot: string | undefined;
  for (const word of starts) {
    if (word.dynamic || isBroadTarget(word.value) || hasTraversal(word.value)) return true;
    const resolved = path.resolve(cwd, word.value);
    if (resolved === path.resolve(cwd)) return true;
    if (path.isAbsolute(word.value) || path.win32.isAbsolute(word.value)) {
      if (repositoryRoot === undefined) {
        const result = await runGit(cwd, ['rev-parse', '--show-toplevel']);
        repositoryRoot = result.ok ? path.resolve(result.stdout) : '';
      }
      if (repositoryRoot !== '' && resolved === repositoryRoot) return true;
    }
  }
  return false;
}

function destructiveSql(words: readonly Word[]): boolean {
  const executable = executableName(words[0]?.value ?? '');
  const sqlPattern = /\b(?:DROP\s+(?:TABLE|DATABASE)|TRUNCATE\s+TABLE)\b/iu;
  if (['mysql', 'mariadb'].includes(executable)) {
    return words.some((word, index) =>
      (index > 0 && ['-e', '--execute'].includes(words[index - 1]?.value ?? '') && sqlPattern.test(word.value)) ||
      /^--execute=/u.test(word.value) && sqlPattern.test(word.value.slice(word.value.indexOf('=') + 1)),
    );
  }
  if (executable === 'psql') {
    return words.some((word, index) =>
      (index > 0 && ['-c', '--command'].includes(words[index - 1]?.value ?? '') && sqlPattern.test(word.value)) ||
      /^--command=/u.test(word.value) && sqlPattern.test(word.value.slice(word.value.indexOf('=') + 1)),
    );
  }
  if (executable === 'sqlcmd') {
    return words.some((word, index) =>
      (index > 0 && /^-[Qq]$/u.test(words[index - 1]?.value ?? '') && sqlPattern.test(word.value)) ||
      /^-[Qq].+/u.test(word.value) && sqlPattern.test(word.value.slice(2)),
    );
  }
  if (['sqlite', 'sqlite3'].includes(executable)) return words.slice(1).some((word) => sqlPattern.test(word.value));
  return false;
}

function broadChmod(words: readonly Word[], cwd: string): boolean {
  if (executableName(words[0]?.value ?? '') !== 'chmod') return false;
  const recursive = words.some((word) => word.value === '--recursive' || /^-[^-]*R/u.test(word.value));
  const destructiveMode = words.some((word) => /^(?:0?00|0?777|a[+-]rwx|ugo[+-]rwx)$/iu.test(word.value));
  const targets = words.slice(1).filter((word) => !word.value.startsWith('-') && !/^(?:0?00|0?777|a[+-]rwx|ugo[+-]rwx)$/iu.test(word.value));
  return destructiveMode && targets.some((target) =>
    target.dynamic || isBroadTarget(target.value) || hasTraversal(target.value) ||
    (recursive && !safeForcedDeletionTarget(target, cwd)),
  );
}

function wrapperScript(words: readonly Word[]): { kind: string; script?: Word; opaque: boolean } | undefined {
  const name = executableName(words[0]?.value ?? '');
  if (['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(name)) {
    const index = words.findIndex((word, candidate) => candidate > 0 && /^-[A-Za-z]*c[A-Za-z]*$/u.test(word.value));
    if (index < 0) return undefined;
    return { kind: name, script: words[index + 1], opaque: !words[index + 1] || Boolean(words[index + 1]?.dynamic) };
  }
  if (name === 'powershell' || name === 'pwsh') {
    const encoded = words.some((word) => /^-(?:e|enc|encodedcommand)$/iu.test(word.value));
    const index = words.findIndex((word, candidate) => candidate > 0 && /^-(?:c|command)$/iu.test(word.value));
    if (encoded || index < 0) return encoded ? { kind: name, opaque: true } : undefined;
    return { kind: name, script: words[index + 1], opaque: !words[index + 1] || Boolean(words[index + 1]?.dynamic) };
  }
  if (name === 'cmd') {
    const index = words.findIndex((word, candidate) => candidate > 0 && /^\/(?:c|k)$/iu.test(word.value));
    if (index < 0) return undefined;
    const rest = words.slice(index + 1);
    const script = rest.length === 1 ? rest[0] : { value: rest.map(word => JSON.stringify(word.value)).join(' '), dynamic: rest.some(word => word.dynamic) };
    return { kind: name, script, opaque: !script || Boolean(script?.dynamic) || /%[^%]+%|![^!]+!/u.test(script.value) };
  }
  if (name === 'eval') {
    return { kind: name, script: words[1], opaque: !words[1] || Boolean(words[1]?.dynamic) };
  }
  if (['node', 'python', 'python3', 'py', 'ruby', 'perl'].includes(name)) {
    const inline = words.findIndex(word => ['-e', '-c', '-p', '-pe', '--eval', '--execute', '--print'].includes(word.value));
    if (inline >= 0) return { kind: name, script: words[inline + 1], opaque: true };
  }
  return undefined;
}

function block(reason: string): string {
  return `Blocked dangerous command: ${reason}.`;
}

async function inspect(command: string, cwd: string, depth: number, blocks: string[]): Promise<void> {
  if (depth > 4) {
    blocks.push(block('nested shell wrapper exceeds the inspection depth limit'));
    return;
  }
  if (command.length > MAX_COMMAND_LENGTH) {
    blocks.push(block(`command exceeds the ${MAX_COMMAND_LENGTH}-byte inspection limit`));
    return;
  }
  const parsed = tokenize(command);
  if (parsed.malformed) {
    blocks.push(block('shell quoting is malformed and cannot be inspected'));
    return;
  }
  if (hasOpaqueCommandExpansion(command)) blocks.push(block('opaque command or process substitution cannot be inspected'));
  if (hasNulRedirect(parsed.tokens)) blocks.push(block('a redirect targets Windows NUL; use /dev/null in Git Bash'));

  const unquoted = command.replace(/(['"])(?:\\.|(?!\1)[^\\])*\1/gu, '');
  if (/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:[^}]*\}/u.test(unquoted)) blocks.push(block('fork bomb'));
  if (/>\s*(?:\/dev\/(?:sd[a-z]\d*|nvme\d+n\d+(?:p\d+)?|mmcblk\d+(?:p\d+)?)|\\\\\.\\PhysicalDrive\d+)/iu.test(unquoted)) {
    blocks.push(block('a redirect targets a raw device'));
  }

  const directories = [...inspectStaticShell(command, cwd).commands];
  for (const rawWords of commandSegments(parsed.tokens)) {
    const words = unwrap(rawWords);
    if (words.length === 0) continue;
    if (words[0]?.dynamic) {
      blocks.push(block('the executable is dynamic and cannot be inspected'));
      continue;
    }
    const name = executableName(words[0]?.value ?? '');
    const match = directories.findIndex(call => call.words.map(word => word.value).join('\0') === words.map(word => word.value).join('\0'));
    const effectiveCwd = match >= 0 ? directories.splice(match, 1)[0]?.cwd : undefined;
    const deletionCwd = effectiveCwd ?? path.parse(cwd).root;
    const wrapper = wrapperScript(words);
    if (wrapper) {
      if (wrapper.opaque || !wrapper.script) blocks.push(block(`opaque ${wrapper.kind} interpreter command cannot be inspected; use a named script or directly inspectable command`));
      else await inspect(wrapper.script.value, /(?:^|[;&]\s*)\b(?:cd|pushd|popd)\b/.test(command) ? (directories[0]?.cwd ?? path.parse(cwd).root) : cwd, depth + 1, blocks);
      continue;
    }

    if (name === 'rm' && unsafeForcedDeletion(rmTargets(words), deletionCwd)) {
      blocks.push(block('forced recursive deletion is outside generated/cache or scratch/temp roots'));
    } else if (name === 'remove-item' && unsafeForcedDeletion(removeItemTargets(words), deletionCwd)) {
      blocks.push(block('PowerShell forced recursive deletion is outside generated/cache or scratch/temp roots'));
    } else if (['rmdir', 'rd', 'del', 'erase'].includes(name) && unsafeForcedDeletion(cmdDeletion(words), deletionCwd)) {
      blocks.push(block('Windows forced recursive deletion is outside generated/cache or scratch/temp roots'));
    }

    if (name === 'git') {
      const git = parseGit(words, effectiveCwd ?? cwd);
      if (git.subcommand === 'clean' && !gitCleanDryRun(git.args)) {
        blocks.push(block('mutating git clean is not allowed; use --dry-run to inspect it'));
      }
      if (git.subcommand === 'push') {
        const push = pushDetails(git.args);
        if (push.forced) {
          if (!git.cwd || !effectiveCwd) {
            blocks.push(block('force-push target cannot be inspected because the effective directory is unresolved'));
          } else {
            const explicitlyProtected = push.broad || push.branches.some((branch) => PROTECTED_BRANCHES.has(branch.toLowerCase()));
            if (explicitlyProtected) {
              blocks.push(block('force push targets a protected branch'));
            } else {
              try {
                const defaults = await detectedDefaultBranches(git.cwd, push.remote);
                let targets = [...push.branches];
                if (targets.length === 0) {
                  const current = (await runGit(git.cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout;
                  if (PROTECTED_BRANCHES.has(current.toLowerCase()) || defaults.has(current)) targets = [current];
                  else if (current) {
                    const remote = push.remote ?? ((await runGit(git.cwd, ['config', '--get', `branch.${current}.pushRemote`])).stdout || (await runGit(git.cwd, ['config', '--get', 'remote.pushDefault'])).stdout || (await runGit(git.cwd, ['config', '--get', `branch.${current}.remote`])).stdout || 'origin');
                    const destination = await runGit(git.cwd, ['-c', `branch.${current}.pushRemote=${remote}`, 'rev-parse', '--symbolic-full-name', '@{push}']);
                    const prefix = `refs/remotes/${remote}/`;
                    if (destination.ok && destination.stdout.startsWith(prefix)) targets = [destination.stdout.slice(prefix.length)];
                  }
                }
                if (targets.length === 0) blocks.push(block('force-push branch could not be determined'));
                if (targets.some((branch) => defaults.has(branch) || PROTECTED_BRANCHES.has(branch.toLowerCase()))) {
                  blocks.push(block('force push targets the detected default branch'));
                }
              } catch (error) {
                const detail = error instanceof Error && error.message ? ` (${error.message})` : '';
                blocks.push(block(`force-push inspection failed${detail}`));
              }
            }
          }
        }
      }
    }

    if (name === 'find' && await findDeleteIsBroad(words, cwd)) blocks.push(block('repository-wide find -delete is not allowed'));
    if (/^mkfs(?:\.|$)/iu.test(name) || name === 'format-volume' || (name === 'format' && words.slice(1).some((word) => /^[A-Za-z]:/u.test(word.value)))) {
      blocks.push(block('filesystem formatting is not allowed'));
    }
    if (name === 'dd' && words.slice(1).some((word) => /^of=(?:\/dev\/(?:sd|nvme|mmcblk)|\\\\\.\\PhysicalDrive)/iu.test(word.value))) {
      blocks.push(block('dd output targets a raw device'));
    }
    if (broadChmod(words, cwd)) blocks.push(block('broad destructive permission change'));
    if (destructiveSql(words)) blocks.push(block('destructive SQL in an executable database client command'));

    const joined = words.map((word) => word.value).join(' ');
    if (name === 'setx' && words.slice(1).some((word) => word.value.toLowerCase() === 'path')) {
      blocks.push(block('persistent Windows PATH mutation via setx'));
    }
    if (joined.match(/SetEnvironmentVariable\s*\(\s*PATH(?:\s|,|\))/iu)) {
      blocks.push(block('persistent Windows PATH mutation via PowerShell'));
    }
    if (name === 'reg' && words[1]?.value.toLowerCase() === 'add' && /(?:\\|^)Environment(?:\\|\s|$)/iu.test(joined) && /(?:\/v\s+PATH|\bPATH\b)/iu.test(joined)) {
      blocks.push(block('persistent Windows PATH mutation via registry'));
    }
  }
}

/** Evaluate one shell invocation without executing any command text. */
export async function evaluateDangerousCommand(command: string, cwd: string): Promise<PolicyResult> {
  const blocks: string[] = [];
  try {
    await inspect(command, path.resolve(cwd), 0, blocks);
  } catch (error) {
    const detail = error instanceof Error && error.message ? `: ${error.message}` : '';
    blocks.push(block(`dangerous-command inspection failed${detail}`));
  }
  const diagnostics = [...new Set(blocks)];
  return { decision: blocks.length > 0 ? 'block' : 'allow', diagnostics };
}

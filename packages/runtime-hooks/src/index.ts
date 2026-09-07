import { existsSync, openSync, closeSync, fstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type HookAction = 'allow' | 'block';
export interface HookDecision {
  readonly action: HookAction;
  readonly code?: string;
  readonly message?: string;
}
class RuntimeHookError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'RuntimeHookError';
  }
}

const MAX_COMMAND = 32_768;
function block(code: string, reason: string, command?: string): HookDecision {
  return {
    action: 'block',
    code,
    message:
      command === undefined
        ? reason
        : `Blocked: ${reason}.\nRun manually only after review: ${command.trim()}`,
  };
}
function boundedCommand(command: string): HookDecision | undefined {
  if (typeof command !== 'string') {
    return block('INVALID_INPUT', 'command must be a string');
  }
  if (command.length > MAX_COMMAND) {
    return block('INPUT_TOO_LARGE', `command exceeds ${MAX_COMMAND} characters`);
  }
  return undefined;
}

/**
 * The sole dangerous-command rule implementation and data. Its emitted function is
 * also used to construct the dependency-free ESM projection below.
 */
function createDangerousCommandClassifier(): (command: unknown) => HookDecision {
  const maxCommand = 32_768;
  const generatedDirectories = new Set([
    'node_modules',
    'dist',
    'build',
    'out',
    '.next',
    '.svelte-kit',
    '.nuxt',
    'coverage',
    '.cache',
    'tmp',
    '.turbo',
    '.parcel-cache',
    '.output',
    '__pycache__',
    '.pytest_cache',
    '.mypy_cache',
    'target',
  ]);
  const blocked = (code: string, reason: string, command?: string): HookDecision => ({
    action: 'block',
    code,
    message:
      command === undefined
        ? reason
        : `Blocked: ${reason}.\nRun manually only after review: ${command.trim()}`,
  });
  type ParsedToken = { value: string; dynamic: boolean; quoted: boolean };
  const parseCommand = (input: string): { segments: ParsedToken[][]; malformed: boolean } => {
    const segments: ParsedToken[][] = [];
    let tokens: ParsedToken[] = [];
    let value = '';
    let dynamic = false;
    let quoted = false;
    let started = false;
    let quote = '';
    let malformed = false;
    const finishToken = (): void => {
      if (started) {
        tokens.push({ value, dynamic, quoted });
      }
      value = '';
      dynamic = false;
      quoted = false;
      started = false;
    };
    const finishSegment = (): void => {
      finishToken();
      if (tokens.length > 0) {
        segments.push(tokens);
      }
      tokens = [];
    };
    for (let index = 0; index < input.length; index++) {
      const character = input[index] ?? '';
      if (quote === "'") {
        if (character === "'") {
          quote = '';
        } else {
          value += character;
        }
        started = true;
        quoted = true;
        continue;
      }
      if (quote === '"' && character === "'") {
        value += character;
        started = true;
        quoted = true;
        continue;
      }
      if (character === '\\' && index + 1 < input.length) {
        const next = input[index + 1] ?? '';
        const escaped =
          quote === '"'
            ? ['"', '\\', '$', '`', '\n', '\r'].includes(next)
            : /[\s"'\\$`;&|()]/u.test(next);
        if (quote === '"' && next === '"' && index + 2 === input.length) {
          value += character;
        } else if (escaped) {
          value += input[++index] ?? '';
        } else {
          value += character;
        }
        started = true;
        continue;
      }
      if (character === "'") {
        quote = character;
        started = true;
        quoted = true;
        continue;
      }
      if (character === '"') {
        quote = quote === character ? '' : character;
        started = true;
        quoted = true;
        continue;
      }
      if (
        character === '`' ||
        (character === '$' && ['(', '{'].includes(input[index + 1] ?? '')) ||
        (character === '$' && /[A-Za-z_0-9@*#?$!-]/u.test(input[index + 1] ?? ''))
      ) {
        dynamic = true;
        started = true;
        if (character === '`' || input[index + 1] === '(' || input[index + 1] === '{') {
          const closer = character === '`' ? '`' : input[index + 1] === '(' ? ')' : '}';
          let depth = closer === ')' ? 0 : 1;
          value += character;
          if (character !== '`') {
            value += input[++index] ?? '';
            depth = 1;
          }
          let closed = false;
          while (++index < input.length) {
            const nested = input[index] ?? '';
            value += nested;
            if (closer === ')' && nested === '(') {
              depth++;
            }
            if (nested === closer && (--depth === 0 || closer === '`')) {
              closed = true;
              break;
            }
          }
          if (!closed) {
            malformed = true;
          }
        } else {
          value += character;
          while (/[A-Za-z_0-9]/u.test(input[index + 1] ?? '')) {
            value += input[++index];
          }
        }
        continue;
      }
      if (!quote && (character === '\n' || character === '\r' || ';&|()'.includes(character))) {
        finishSegment();
      } else if (!quote && /\s/u.test(character)) {
        finishToken();
      } else {
        value += character;
        started = true;
      }
    }
    if (quote) {
      malformed = true;
    }
    finishSegment();
    return { segments, malformed };
  };
  const basename = (token: string): string =>
    token.replace(/\\/g, '/').replace(/\/+$/u, '').split('/').pop()?.toLowerCase() ?? '';
  const prefixes = new Set([
    '!',
    'if',
    'then',
    'elif',
    'else',
    'while',
    'until',
    'do',
    'time',
    '{',
  ]);
  const executableIndex = (tokens: ParsedToken[]): number =>
    tokens.findIndex(
      (token) => !prefixes.has(token.value) && !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token.value),
    );
  const classify = (command: unknown, wrapperDepth = 0): HookDecision => {
    if (typeof command !== 'string') {
      return blocked('INVALID_INPUT', 'command must be a string');
    }
    if (command.length > maxCommand) {
      return blocked('INPUT_TOO_LARGE', `command exceeds ${maxCommand} characters`);
    }
    const value = command.trim();
    const parsed = parseCommand(value);
    const wrapperNames = new Set([
      'sh',
      'sh.exe',
      'bash',
      'bash.exe',
      'cmd',
      'cmd.exe',
      'powershell',
      'powershell.exe',
      'pwsh',
      'pwsh.exe',
      'eval',
    ]);
    const isEnvSplitStringOption = (token: string): boolean => {
      if (/^-[iv0]*S/u.test(token)) {
        return true;
      }
      const longOption = token.split('=', 1)[0] ?? '';
      return (
        longOption.length > 2 &&
        longOption.startsWith('--') &&
        '--split-string'.startsWith(longOption)
      );
    };
    const resolveExecutable = (
      segment: ParsedToken[],
    ): { index: number; name: string; envSplitString: boolean } => {
      let index = executableIndex(segment);
      let name = index < 0 ? '' : basename(segment[index]?.value ?? '');
      let envSplitString = false;
      while (name === 'env' || name === 'command') {
        const launcher = name;
        index++;
        while (index < segment.length) {
          const token = segment[index]?.value ?? '';
          if (token === '--') {
            index++;
            break;
          }
          if (launcher === 'env' && isEnvSplitStringOption(token)) {
            envSplitString = true;
            index++;
            continue;
          }
          if (launcher === 'env' && ['-u', '--unset', '-C', '--chdir'].includes(token)) {
            index += 2;
            continue;
          }
          if (
            token.startsWith('-') ||
            (launcher === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(token))
          ) {
            index++;
            continue;
          }
          break;
        }
        name = index >= segment.length ? '' : basename(segment[index]?.value ?? '');
      }
      return { index, name, envSplitString };
    };
    if (parsed.segments.some((segment) => resolveExecutable(segment).envSplitString)) {
      return blocked(
        'OPAQUE_ENV_SPLIT_STRING',
        'GNU env split-string commands cannot be statically inspected',
        command,
      );
    }
    const containsWrapper = parsed.segments.some((segment) =>
      wrapperNames.has(resolveExecutable(segment).name),
    );
    if (parsed.malformed && containsWrapper) {
      return blocked('MALFORMED_COMMAND_WRAPPER', 'command wrapper syntax is malformed', command);
    }
    if (
      wrapperDepth > 0 &&
      parsed.segments.some((segment) => {
        const resolved = resolveExecutable(segment);
        return resolved.index >= 0 && Boolean(segment[resolved.index]?.dynamic);
      })
    ) {
      return blocked(
        'OPAQUE_COMMAND_WRAPPER',
        'cannot statically inspect a dynamic command wrapper payload',
        command,
      );
    }
    for (const segment of parsed.segments) {
      const resolved = resolveExecutable(segment);
      const { index, name } = resolved;
      if (!wrapperNames.has(name)) {
        continue;
      }
      let payloadIndex = index + 1;
      if (name !== 'eval') {
        let commandOptionIndex = -1;
        for (let optionIndex = payloadIndex; optionIndex < segment.length; optionIndex++) {
          const option = segment[optionIndex]?.value.toLowerCase() ?? '';
          const commandOption =
            name === 'cmd' || name === 'cmd.exe'
              ? option === '/c'
              : name.startsWith('power') || name.startsWith('pwsh')
                ? option === '-command' || option === '-c'
                : option === '-c' || /^-[a-z]*c[a-z]*$/u.test(option);
          if (commandOption) {
            commandOptionIndex = optionIndex;
            break;
          }
          if (!(option.startsWith('-') || option.startsWith('/'))) {
            break;
          }
        }
        if (commandOptionIndex < 0) {
          continue;
        }
        payloadIndex = commandOptionIndex + 1;
      }
      if (payloadIndex >= segment.length) {
        return blocked(
          'MALFORMED_COMMAND_WRAPPER',
          'command wrapper is malformed because its payload is missing',
          command,
        );
      }
      const payloadTokens = segment.slice(payloadIndex);
      if (payloadTokens.some((token) => token.dynamic)) {
        return blocked(
          'OPAQUE_COMMAND_WRAPPER',
          'cannot statically inspect a dynamic command wrapper payload',
          command,
        );
      }
      if (wrapperDepth >= 8) {
        return blocked(
          'WRAPPER_DEPTH_EXCEEDED',
          'command wrapper nesting exceeds the bounded depth of 8',
          command,
        );
      }
      const nested = classify(
        payloadTokens.map((token) => token.value).join(' '),
        wrapperDepth + 1,
      );
      if (nested.action === 'block') {
        return nested;
      }
    }
    for (const segment of parsed.segments) {
      const resolved = resolveExecutable(segment);
      if (resolved.index < 0) {
        continue;
      }
      const arguments_ = segment.slice(resolved.index + 1);
      if (resolved.name === 'rm') {
        const hasRecursive = arguments_.some(
          (token) => /^-[A-Za-z]*r[A-Za-z]*$/u.test(token.value) || token.value === '--recursive',
        );
        const hasForce = arguments_.some(
          (token) => /^-[A-Za-z]*f[A-Za-z]*$/u.test(token.value) || token.value === '--force',
        );
        const dynamicOption = arguments_.some(
          (token) => token.dynamic && (!token.quoted || token.value.startsWith('-')),
        );
        let separator = false;
        const targets = arguments_.filter((token) => {
          if (token.value === '--') {
            separator = true;
            return false;
          }
          return separator || !token.value.startsWith('-');
        });
        if (dynamicOption || (hasRecursive && hasForce && targets.some((token) => token.dynamic))) {
          return blocked(
            'DANGEROUS_RECURSIVE_DELETE',
            'recursive-delete safety cannot be statically established',
            command,
          );
        }
        if (!hasRecursive || !hasForce) {
          continue;
        }
        if (targets.length === 0) {
          return blocked(
            'DANGEROUS_RECURSIVE_DELETE',
            'recursive forced deletion has no constrained target',
            command,
          );
        }
        for (const target of targets) {
          const normalized = target.value
            .replace(/\\/g, '/')
            .replace(/\/+/g, '/')
            .replace(/\/+$/u, '');
          const absolute = normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized);
          const broad =
            normalized === '' ||
            ['~', '.', '..', '*'].includes(normalized) ||
            normalized.startsWith('./*') ||
            /^~[^/]*(?:\/|$)/u.test(normalized) ||
            normalized.startsWith('../') ||
            absolute;
          const single = !normalized.includes('/');
          if (broad || (single && !generatedDirectories.has(normalized))) {
            return blocked(
              'DANGEROUS_RECURSIVE_DELETE',
              'broad recursive deletion is not allowed',
              command,
            );
          }
        }
      }
      if (resolved.name === 'remove-item') {
        const recursive = arguments_.some((token) =>
          ['-r', '-recurse'].includes(token.value.toLowerCase()),
        );
        const force = arguments_.some((token) => token.value.toLowerCase() === '-force');
        if (!recursive || !force) {
          continue;
        }
        const targets = arguments_.filter((token) => !token.value.startsWith('-'));
        if (targets.length === 0 || targets.some((token) => token.dynamic)) {
          return blocked(
            'DANGEROUS_RECURSIVE_DELETE',
            'recursive-delete safety cannot be statically established',
            command,
          );
        }
        for (const target of targets) {
          const normalized = target.value.replace(/\\/g, '/').replace(/\/+$/u, '');
          const broad =
            normalized === '' ||
            ['/', '~', '.', '..', '*'].includes(normalized) ||
            /^[A-Za-z]:\/?$/u.test(normalized) ||
            normalized.startsWith('../') ||
            normalized.startsWith('~/');
          if (broad) {
            return blocked(
              'WINDOWS_RECURSIVE_DELETE',
              'broad PowerShell recursive deletion is not allowed',
              command,
            );
          }
        }
      }
      const lowerArguments = new Set(arguments_.map((token) => token.value.toLowerCase()));
      if (resolved.name === 'rmdir' && lowerArguments.has('/s')) {
        return blocked(
          'WINDOWS_RECURSIVE_DELETE',
          'Windows recursive deletion is not allowed',
          command,
        );
      }
      if (
        resolved.name === 'del' &&
        ['/f', '/q', '/s'].every((option) => lowerArguments.has(option))
      ) {
        return blocked(
          'WINDOWS_RECURSIVE_DELETE',
          'Windows forced recursive deletion is not allowed',
          command,
        );
      }
    }
    for (const segment of parsed.segments) {
      const resolved = resolveExecutable(segment);
      if (resolved.index < 0 || !segment[resolved.index]?.dynamic) {
        continue;
      }
      const arguments_ = segment.slice(resolved.index + 1).map((token) => token.value);
      const hasRecursive = arguments_.some(
        (token) => /^-[A-Za-z]*r[A-Za-z]*$/u.test(token) || token === '--recursive',
      );
      const hasForce = arguments_.some(
        (token) => /^-[A-Za-z]*f[A-Za-z]*$/u.test(token) || token === '--force',
      );
      if (!hasRecursive || !hasForce) {
        continue;
      }
      let separator = false;
      const targets = arguments_.filter((token) => {
        if (token === '--') {
          separator = true;
          return false;
        }
        return separator || !token.startsWith('-');
      });
      for (const target of targets) {
        const normalized = target.replace(/\\/g, '/').replace(/\/+$/u, '').replace(/\/+/g, '/');
        const absolute = normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized);
        const broad =
          normalized === '' ||
          ['~', '.', '..', '*', '$HOME', '${HOME}', '$PWD', '${PWD}'].includes(normalized) ||
          normalized.startsWith('./*') ||
          /^~[^/]*(?:\/|$)/u.test(normalized) ||
          normalized.startsWith('../') ||
          /^\$(?:\{(?:HOME|PWD)\}|(?:HOME|PWD))(?:\/|$)/u.test(normalized) ||
          absolute;
        if (broad) {
          return blocked(
            'DANGEROUS_RECURSIVE_DELETE',
            'broad recursive deletion is not allowed',
            command,
          );
        }
      }
    }
    if (/\bchmod\s+(?:-R\s+)?(?:777|000)\s+[/~.]/.test(value)) {
      return blocked(
        'DANGEROUS_PERMISSIONS',
        'broad permission destruction is not allowed',
        command,
      );
    }
    if (/\bmkfs(?:\.[\w-]+)?\b/.test(value)) {
      return blocked('DISK_FORMAT', 'filesystem formatting is not allowed', command);
    }
    if (
      /\bdd\b(?=[^\n]*\bif=\/dev\/(?:zero|random|urandom)\b)(?=[^\n]*\bof=\/dev\/)/.test(value) ||
      />\s*\/dev\/(?:sd[a-z]|nvme\d)/.test(value)
    ) {
      return blocked('DEVICE_OVERWRITE', 'device overwrite is not allowed', command);
    }
    if (/:\(\)\s*\{.*:\|:.*\}/.test(value)) {
      return blocked('FORK_BOMB', 'fork bombs are not allowed', command);
    }
    if (/\b(?:DROP\s+(?:TABLE|DATABASE)|TRUNCATE\s+TABLE)\b/i.test(value)) {
      return blocked('DESTRUCTIVE_SQL', 'destructive SQL is not allowed', command);
    }
    if (
      /\bgit\s+push\b(?=[^\n;&|]*(?:-f\b|--force\b))(?![^\n;&|]*--force-with-lease\b)[^\n;&|]*(?:(?:origin|upstream)\s+)?(?:main|master)\b/.test(
        value,
      )
    ) {
      return blocked(
        'PROTECTED_FORCE_PUSH',
        'force push to a protected branch is not allowed',
        command,
      );
    }
    if (/\bgit\s+clean\s+-(?=[A-Za-z]*f)(?=[A-Za-z]*d)(?=[A-Za-z]*x)[A-Za-z]+/.test(value)) {
      return blocked('DESTRUCTIVE_GIT_CLEAN', 'git clean of ignored files is not allowed', command);
    }
    if (
      /\bsetx\b[^\n]*\bPATH\b/i.test(value) ||
      /SetEnvironmentVariable\s*\(\s*["']PATH["']/i.test(value) ||
      /\breg\s+add\b[^\n]*\\Environment\b(?=[^\n]*\bPATH\b)/i.test(value)
    ) {
      return blocked(
        'PERSISTENT_PATH_CHANGE',
        'persistent PATH modification is not allowed',
        command,
      );
    }
    return { action: 'allow' };
  };
  return (command: unknown): HookDecision => classify(command);
}

/** Pure command classification. Adapters decide how a block is presented to a runtime. */
export const classifyDangerousCommand = createDangerousCommandClassifier();

/** Dependency-free ESM source for immutable runtime projections. */
export const dangerousCommandPolicyModuleSource = [
  `const createDangerousCommandClassifier = ${createDangerousCommandClassifier.toString()};`,
  'export const classifyDangerousCommand = createDangerousCommandClassifier();',
  'export default classifyDangerousCommand;',
].join('\n');

export type GuardPolicy = 'package-manager' | 'pre-commit' | 'dangerous-command' | 'fallow';
export interface GuardObservation {
  readonly policy: GuardPolicy;
  readonly decision?: HookDecision & {
    readonly warning?: string;
    readonly warnings?: readonly string[];
  };
  readonly infrastructureFailure?: string;
}
export interface GuardResolution extends HookDecision {
  readonly warnings: readonly string[];
}
const GUARD_ORDER: readonly GuardPolicy[] = [
  'package-manager',
  'pre-commit',
  'dangerous-command',
  'fallow',
];
const FAIL_CLOSED_GUARDS = new Set<GuardPolicy>(['dangerous-command']);

/** Resolve independent hook observations deterministically, regardless of harness event order. */
export function resolveGuardObservations(
  observations: readonly GuardObservation[],
): GuardResolution {
  const sorted = [...observations].sort(
    (left, right) => GUARD_ORDER.indexOf(left.policy) - GUARD_ORDER.indexOf(right.policy),
  );
  const warnings: string[] = [];
  let firstBlock: HookDecision | undefined;
  for (const observation of sorted) {
    if (observation.infrastructureFailure) {
      if (FAIL_CLOSED_GUARDS.has(observation.policy) && !firstBlock) {
        firstBlock = block(
          'GUARD_INFRASTRUCTURE_FAILURE',
          `${observation.policy}: ${observation.infrastructureFailure}`,
        );
      } else if (!FAIL_CLOSED_GUARDS.has(observation.policy)) {
        warnings.push(
          `${observation.policy}: ${observation.infrastructureFailure}; skipped (fail-open).`,
        );
      }
      continue;
    }
    const decision = observation.decision;
    if (!decision) {
      continue;
    }
    if (decision.warning) {
      warnings.push(decision.warning);
    }
    if (decision.warnings) {
      warnings.push(...decision.warnings);
    }
    if (decision.action === 'block' && !firstBlock) {
      firstBlock = decision;
    }
  }
  return firstBlock ? { ...firstBlock, warnings } : { action: 'allow', warnings };
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';
export interface PackagePolicyDecision extends HookDecision {
  readonly replacement?: string;
  readonly warnings: readonly string[];
}
function commandListExecutables(command: string): string[] {
  const segments: string[] = [];
  let segment = '';
  let quote = '';
  let escaped = false;
  for (const character of command) {
    if (escaped) {
      segment += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      segment += character;
      escaped = true;
      continue;
    }
    if (quote) {
      segment += character;
      if (character === quote) {
        quote = '';
      }
      continue;
    }
    if (character === "'" || character === '"') {
      segment += character;
      quote = character;
      continue;
    }
    if (';|&()\n\r'.includes(character)) {
      if (segment.trim()) {
        segments.push(segment.trim());
      }
      segment = '';
      continue;
    }
    segment += character;
  }
  if (segment.trim()) {
    segments.push(segment.trim());
  }
  return segments.map((item) => item.split(/\s+/u)[0]?.toLowerCase() ?? '').filter(Boolean);
}
export function evaluatePackagePolicy(
  command: string,
  manager: PackageManager | null,
): PackagePolicyDecision {
  const invalid = boundedCommand(command);
  if (invalid) {
    return { ...invalid, warnings: [] };
  }
  const warnings: string[] = [];
  const packageManagers = new Set(['npm', 'pnpm', 'yarn', 'bun']);
  const wrong = commandListExecutables(command).find(
    (executable) => packageManagers.has(executable) && executable !== manager,
  );
  if (manager && wrong) {
    return {
      action: 'block',
      code: 'WRONG_PACKAGE_MANAGER',
      message: `This project uses ${manager}; use it instead of ${wrong}.`,
      replacement: manager,
      warnings,
    };
  }
  if (manager === 'bun' && /(?:^|\s)npx\s/.test(command)) {
    return {
      action: 'block',
      code: 'WRONG_PACKAGE_RUNNER',
      message: 'This project uses bunx instead of npx.',
      replacement: 'bunx',
      warnings,
    };
  }
  if (manager && /(?:^|[;&|]\s*|\s)npx\s+tsc(?:\s|$)/.test(command)) {
    return {
      action: 'block',
      code: 'DIRECT_TSC',
      message: `Use '${manager} run typecheck' or the project's check script.`,
      replacement: `${manager} run typecheck`,
      warnings,
    };
  }
  // Pipeline commands use these tools for stream processing rather than as a
  // substitute for runtime-native file/search capabilities.
  const standalone = command.includes('|') ? '' : command.trim();
  if (/^(?:grep|rg)\s|(?:&&|;)\s*(?:grep|rg)\s/.test(standalone)) {
    warnings.push('Consider using the Grep capability instead of a shell search tool.');
  }
  if (/^(?:cat|head|tail)\s|(?:&&|;)\s*(?:cat|head|tail)\s/.test(standalone)) {
    warnings.push('Consider using the Read capability instead of a shell file reader.');
  }
  if (/^find\s|(?:&&|;)\s*find\s/.test(standalone)) {
    warnings.push('Consider using the file Glob capability instead of shell find.');
  }
  return { action: 'allow', warnings };
}

const SECRET_PATTERNS = [
  ['AWS Access Key', /AKIA[0-9A-Z]{16}/],
  ['GitHub PAT', /ghp_[a-zA-Z0-9]{36}/],
  ['GitHub OAuth', /gho_[a-zA-Z0-9]{36}/],
  ['Private Key', /-----BEGIN[A-Z ]*PRIVATE KEY-----/],
  ['Slack Token', /xox[bpors]-[a-zA-Z0-9-]+/],
  [
    'Generic Secret',
    /\b(?:password|secret|api_key|apikey|auth_token)\b\s*[:=]\s*["']?[^"'\s]{8,}["']?/i,
  ],
] as const;
export interface SecretFinding {
  readonly name: string;
  readonly file: string;
}
export function scanAddedSecrets(diff: string, filename: string): SecretFinding[] {
  if (diff.length > 1_000_000) {
    throw new RuntimeHookError('INPUT_TOO_LARGE', 'staged diff exceeds 1000000 characters');
  }
  if (filename.length > 4_096) {
    throw new RuntimeHookError('INPUT_TOO_LARGE', 'filename is too long');
  }
  const findings: SecretFinding[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      for (const [name, pattern] of SECRET_PATTERNS) {
        if (pattern.test(line)) {
          findings.push({ name, file: filename });
          break;
        }
      }
    }
  }
  return findings;
}
export function shouldScanStagedFile(filename: string): boolean {
  return ![
    /\.lock$/,
    /lock\.json$/,
    /lock\.yaml$/,
    /\.lockb$/,
    /\.env\.(?:example|sample|template)$/,
    /\.(?:test|spec)\.[jt]sx?$/,
  ].some((pattern) => pattern.test(filename));
}
export function extractCommitMessage(command: string): string | null {
  if (command.length > MAX_COMMAND) {
    return null;
  }
  const heredoc = command.match(
    /(?:\$\(cat\s+)?<<-?["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*\n([\s\S]*?)\n\1/u,
  );
  if (heredoc) {
    return (heredoc[2] ?? '').split('\n')[0]?.trim() || null;
  }
  return command.match(/-m\s+"([^"]+)"/)?.[1] ?? command.match(/-m\s+\$?'([^']+)'/)?.[1] ?? null;
}
export function validateCommitFormat(message: string): {
  readonly valid: boolean;
  readonly warnings: readonly string[];
} {
  const first = message.split('\n')[0] ?? '';
  const valid =
    /^(?:feat|fix|refactor|chore|docs|style|test|perf|ci|build|revert)(?:\(.+\))?: .+/.test(first);
  const warnings: string[] = [];
  if (!valid) {
    warnings.push(
      'Warning: commit message does not match conventional format: type(scope): description',
    );
  }
  if (first.length > 72) {
    warnings.push(
      `Warning: commit message first line is ${first.length} chars (recommended max 72)`,
    );
  }
  return { valid, warnings };
}
export type Toolchain = 'vite-plus' | 'biome' | 'classic';
export type Framework = 'svelte' | 'next' | null;
export function selectPreCommitCheck(input: {
  readonly toolchain: Toolchain;
  readonly scripts: Readonly<Record<string, string>>;
  readonly framework: Framework;
}): string | null {
  const names = input.toolchain === 'vite-plus' ? ['check:all', 'check-all'] : [];
  names.push(
    ...(input.framework === 'svelte'
      ? ['check', 'typecheck', 'type-check']
      : ['typecheck', 'type-check', 'check', 'check:types', 'tsc']),
  );
  return names.find((name) => Boolean(input.scripts[name])) ?? null;
}

export interface PreCommitCheckPlan {
  readonly executable: PackageManager;
  readonly args: readonly ['run', string];
  readonly timeoutMilliseconds: 120_000;
  readonly failure: 'block';
  readonly outputTailLines: 50;
}
export type PreCommitDecision =
  | {
      readonly action: 'allow';
      readonly warnings: readonly string[];
      readonly check?: PreCommitCheckPlan;
    }
  | {
      readonly action: 'block';
      readonly code: 'STAGED_SECRET';
      readonly message: string;
      readonly warnings: readonly string[];
      readonly findings: readonly SecretFinding[];
    };
export function evaluatePreCommit(input: {
  readonly command: string;
  readonly packageManager: PackageManager | null;
  readonly toolchain: Toolchain;
  readonly framework: Framework;
  readonly scripts: Readonly<Record<string, string>>;
  readonly staged: readonly { readonly file: string; readonly diff: string }[];
}): PreCommitDecision {
  if (!/(?:^|[\s;&|()])git\s+commit(?:\s|$)/u.test(input.command)) {
    return { action: 'allow', warnings: [] };
  }
  const findings = input.staged.flatMap(({ file, diff }) =>
    shouldScanStagedFile(file) ? scanAddedSecrets(diff, file) : [],
  );
  if (findings.length > 0) {
    return {
      action: 'block',
      code: 'STAGED_SECRET',
      message: 'Remove staged secrets before committing.',
      warnings: [],
      findings,
    };
  }
  const message = extractCommitMessage(input.command);
  const warnings = message ? [...validateCommitFormat(message).warnings] : [];
  const script = selectPreCommitCheck(input);
  if (!script) {
    return { action: 'allow', warnings };
  }
  return {
    action: 'allow',
    warnings,
    check: {
      executable: input.packageManager ?? 'npm',
      args: ['run', script],
      timeoutMilliseconds: 120_000,
      failure: 'block',
      outputTailLines: 50,
    },
  };
}

export interface FallowGateInput {
  readonly command: string;
  readonly minimumVersion: string;
  readonly runner?: { readonly description: string; readonly version: string };
  readonly audit?: { readonly status: number; readonly stdout: string; readonly stderr: string };
}
export interface FallowDecision extends HookDecision {
  readonly warning?: string;
  readonly auditOutput?: string;
}
function semverCompare(a: string, b: string): number {
  const av = a.split('.').slice(0, 3).map(Number),
    bv = b.split('.').slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) {
    const delta = (av[i] || 0) - (bv[i] || 0);
    if (delta) {
      return delta < 0 ? -1 : 1;
    }
  }
  return 0;
}
export function evaluateFallowGate(input: FallowGateInput): FallowDecision {
  const invalid = boundedCommand(input.command);
  if (invalid) {
    return invalid;
  }
  if (!/(^|[\s;|&()])git\s+(?:commit|push)(?:\s|$)/.test(input.command)) {
    return { action: 'allow' };
  }
  if (!input.runner) {
    return {
      action: 'allow',
      code: 'FALLOW_UNAVAILABLE',
      warning: 'fallow-gate: fallow binary not found; skipping.',
    };
  }
  if (
    input.minimumVersion &&
    input.runner.version &&
    semverCompare(input.runner.version, input.minimumVersion) < 0
  ) {
    return block(
      'FALLOW_VERSION_TOO_OLD',
      `${input.runner.description} is fallow ${input.runner.version}, below required ${input.minimumVersion}`,
    );
  }
  if (!input.audit) {
    return {
      action: 'allow',
      code: 'FALLOW_RUNTIME_ERROR',
      warning: 'fallow-gate: audit result unavailable; skipping.',
    };
  }
  type AuditPayload = { verdict?: unknown; error?: unknown; message?: unknown };
  let parsed: AuditPayload | null = null;
  try {
    parsed = JSON.parse(input.audit.stdout) as AuditPayload;
  } catch {
    /* visible fail-open below */
  }
  if (parsed?.verdict === 'fail') {
    return {
      action: 'block',
      code: 'FALLOW_AUDIT_FAILED',
      message: `Blocked by ${input.runner.description}.`,
      auditOutput: input.audit.stdout,
    };
  }
  if (input.audit.status === 2 || parsed?.error === true) {
    return {
      action: 'allow',
      code: 'FALLOW_RUNTIME_ERROR',
      warning: `fallow-gate: audit runtime error${typeof parsed?.message === 'string' ? ` (${parsed.message})` : ''}; skipping.`,
    };
  }
  if (input.audit.status !== 0) {
    return {
      action: 'allow',
      code: 'FALLOW_RUNTIME_ERROR',
      warning: `fallow-gate: audit exited ${input.audit.status}${input.audit.stderr ? ` (${input.audit.stderr.split('\n')[0]})` : ''}; skipping.`,
    };
  }
  return { action: 'allow' };
}

export type PostCommandAssumption =
  | {
      readonly operation: 'git-push';
      readonly exitCode: number;
      readonly pullRequest: 'exists' | 'missing' | 'unknown';
    }
  | { readonly operation: 'package-install'; readonly exitCode: number; readonly stderr?: string }
  | {
      readonly operation: 'pull-request-create';
      readonly exitCode: number;
      readonly pullRequestUrl?: string;
    };
export function extractPostCommandContext(input: PostCommandAssumption): string | null {
  if (input.operation === 'git-push') {
    return input.exitCode === 0 && input.pullRequest === 'missing'
      ? 'Pushed to remote. No pull request exists for this branch yet.'
      : null;
  }
  if (input.operation === 'package-install') {
    return /vulnerabilit(?:y|ies)/i.test((input.stderr ?? '').slice(0, 65_536))
      ? 'Package install detected vulnerabilities. Consider running the project audit policy.'
      : null;
  }
  if (input.exitCode !== 0 || !input.pullRequestUrl || input.pullRequestUrl.length > 2_048) {
    return null;
  }
  try {
    const url = new URL(input.pullRequestUrl);
    return url.protocol === 'https:' ? `Pull request created: ${url.href}` : null;
  } catch {
    return null;
  }
}

export interface QualityInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly reportFailure: boolean;
}
const ESLINT_CONFIGS = new Set([
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
]);
const PRETTIER_CONFIGS = new Set([
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
]);
export function planFileQuality(input: {
  readonly relativeFile: string;
  readonly toolchain: Toolchain;
  readonly runner: readonly [string, ...string[]];
  readonly configs: readonly string[];
}): QualityInvocation[] {
  if (
    input.relativeFile.length > 4_096 ||
    path.isAbsolute(input.relativeFile) ||
    /^[A-Za-z]:[\\/]/.test(input.relativeFile) ||
    input.relativeFile.split(/[\\/]/).includes('..')
  ) {
    throw new RuntimeHookError(
      'UNSAFE_PATH',
      'edited file must be a bounded project-relative path',
    );
  }
  const invoke = (tool: string, args: string[], reportFailure: boolean): QualityInvocation => ({
    executable: input.runner[0],
    args: [...input.runner.slice(1), tool, ...args, input.relativeFile],
    reportFailure,
  });
  const ext = path.extname(input.relativeFile).slice(1).toLowerCase();
  const result: QualityInvocation[] = [];
  const eslint = input.configs.some((item) => ESLINT_CONFIGS.has(item));
  const prettier = input.configs.some((item) => PRETTIER_CONFIGS.has(item));
  if (ext === 'py') {
    return input.configs.includes('pyproject:tool.ruff') ||
      input.configs.includes('ruff.toml') ||
      input.configs.includes('.ruff.toml')
      ? [invoke('ruff', ['format'], false), invoke('ruff', ['check', '--fix'], true)]
      : [];
  }
  const js = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts', 'svelte', 'vue']).has(
    ext,
  );
  const data = new Set(['json', 'jsonc', 'css', 'scss', 'less', 'html', 'md', 'yaml', 'yml']).has(
    ext,
  );
  if (input.toolchain === 'vite-plus' && (js || data)) {
    result.push(invoke('vp', ['fmt'], false));
    if (js) {
      result.push(invoke('vp', ['lint', '--fix'], true));
      if (eslint) {
        result.push(invoke('eslint', ['--fix'], true));
      }
    }
    return result;
  }
  if (input.toolchain === 'biome' && (js || ['json', 'jsonc', 'css'].includes(ext))) {
    result.push(invoke('biome', ['format', '--write'], false));
    if (js) {
      result.push(invoke('biome', ['lint', '--fix'], true));
    }
    return result;
  }
  if ((js || data) && prettier) {
    result.push(invoke('prettier', ['--write'], false));
  }
  if (js && eslint) {
    result.push(invoke('eslint', ['--fix'], true));
  }
  return result;
}

export interface ProjectEnvironment {
  readonly packageManager: PackageManager | null;
  readonly runner: readonly string[];
  readonly toolchain: Toolchain;
  readonly framework: Framework;
  readonly python: boolean;
}
const LOCKFILES: readonly [string, PackageManager][] = [
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
];
export function detectProjectEnvironment(startDirectory: string): ProjectEnvironment {
  let current = path.resolve(startDirectory);
  let packageManager: PackageManager | null = null;
  let toolchain: Toolchain = 'classic';
  let framework: Framework = null;
  let python = false;
  for (let depth = 0; depth < 64; depth++) {
    if (!packageManager) {
      packageManager =
        LOCKFILES.find(([name]) => existsSync(path.join(current, name)))?.[1] ?? null;
    }
    if (toolchain === 'classic') {
      const vp = path.join(current, 'node_modules', '.bin', 'vp');
      if ([vp, `${vp}.cmd`, `${vp}.ps1`].some(existsSync)) {
        toolchain = 'vite-plus';
      } else if (
        ['biome.json', 'biome.jsonc'].some((name) => existsSync(path.join(current, name)))
      ) {
        toolchain = 'biome';
      }
    }
    if (!framework) {
      if (
        ['svelte.config.js', 'svelte.config.ts'].some((name) =>
          existsSync(path.join(current, name)),
        )
      ) {
        framework = 'svelte';
      } else if (
        ['next.config.js', 'next.config.mjs', 'next.config.ts'].some((name) =>
          existsSync(path.join(current, name)),
        )
      ) {
        framework = 'next';
      }
    }
    if (existsSync(path.join(current, 'pyproject.toml'))) {
      python = true;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  const runners: Record<PackageManager, readonly string[]> = {
    bun: ['bunx'],
    pnpm: ['pnpm', 'exec'],
    yarn: ['yarn', 'exec'],
    npm: ['npx'],
  };
  return {
    packageManager,
    runner: packageManager ? runners[packageManager] : ['npx'],
    toolchain,
    framework,
    python,
  };
}
export type NotificationPlan =
  | { readonly action: 'none' }
  | { readonly action: 'flash-beep'; readonly delivery: 'background'; readonly failure: 'ignore' };

/** Adapters normalize Claude Stop and Pi agent-settled events to turn-settled. */
export function planNotification(input: {
  readonly event: 'turn-settled';
  readonly platform: NodeJS.Platform;
  readonly sessionRole: 'top-level' | 'child';
}): NotificationPlan {
  return input.platform === 'win32' && input.sessionRole === 'top-level'
    ? { action: 'flash-beep', delivery: 'background', failure: 'ignore' }
    : { action: 'none' };
}

const MACHINE_ROOTS = [
  ['MPX_PROJECTS', 'personal projects'],
  ['MPX_WORK', 'work repositories'],
  ['MPX_CLONED', 'cloned OSS repositories'],
  ['MPX_APPS', 'local apps'],
  ['MPX_ONEDRIVE', 'OneDrive root'],
  ['MPX_AI_GENERATED', 'AI-generated assets (skill deliverables)'],
  ['MPX_OBSIDIAN_VAULT', 'Obsidian vault'],
] as const;

/** Privacy-safe machine context. Only documented non-secret MPX root variables are surfaced. */
export function buildMachineContext(
  environment: Readonly<Record<string, string | undefined>>,
): string[] {
  const roots = MACHINE_ROOTS.flatMap(([name, label]) => {
    const value = environment[name]?.trim();
    return value ? [`- ${name} = ${value} - ${label}`] : [];
  });
  return roots.length === 0
    ? []
    : [
        'Machine roots (from MPX_* env vars; use these instead of guessing paths):',
        ...roots,
        'Paths outside the working directory should be resolved from these variables.',
      ];
}

export function planSessionContext(
  environment: Readonly<Record<string, string | undefined>>,
): { readonly delivery: 'before-next-model-turn'; readonly context: string } | null {
  const context = buildMachineContext(environment).join('\n');
  return context ? { delivery: 'before-next-model-turn', context } : null;
}

export function buildCompactContext(environment: ProjectEnvironment): string[] {
  const lines: string[] = [];
  const pm = environment.packageManager;
  if (pm) {
    lines.push(`This project uses ${pm}. Use '${pm}' for all package commands.`);
    lines.push(`Do not use another package manager unless '${pm}' is that tool.`);
  }
  if (environment.toolchain === 'vite-plus') {
    lines.push(
      'Toolchain: Vite Plus. Use vp check, vp fmt, vp lint, and vp test through the project runner.',
    );
  } else if (environment.toolchain === 'biome') {
    lines.push('Formatter/Linter: Biome.');
  }
  if (pm) {
    lines.push(`Run '${pm} run typecheck' or the project's check script before committing.`);
  }
  if (environment.framework === 'svelte') {
    lines.push('Framework: Svelte/SvelteKit. Use svelte-check for Svelte diagnostics.');
  } else if (environment.framework === 'next') {
    lines.push('Framework: Next.js.');
  }
  if (environment.python) {
    lines.push('Python project detected. Use ruff when configured.');
  }
  lines.push(
    'Git workflow: use conventional commit subjects: type(scope): description.',
    'Code quality: fix type and lint issues rather than suppressing them.',
    'Safety: dangerous destructive commands are blocked by policy.',
  );
  return lines;
}
export type CompactionInjectionPlan =
  | {
      readonly action: 'default';
      readonly failure: 'use-runtime-default';
      readonly postCompactContext: string;
    }
  | {
      readonly action: 'inject';
      readonly failure: 'use-runtime-default';
      readonly instructions: string;
      readonly postCompactContext: string;
    };
export function planCompactionInjection(input: {
  readonly manualInstructions?: string | null;
  readonly canonicalInstructions: string;
  readonly environment: ProjectEnvironment;
}): CompactionInjectionPlan {
  const postCompactContext = buildCompactContext(input.environment).join('\n');
  const instructions = mergeCompactionInstructions(
    input.manualInstructions,
    input.canonicalInstructions,
  );
  return instructions
    ? { action: 'inject', failure: 'use-runtime-default', instructions, postCompactContext }
    : { action: 'default', failure: 'use-runtime-default', postCompactContext };
}

/** Canonical compaction policy is required; manual runtime text keeps priority. */
export function mergeCompactionInstructions(
  manual: string | null | undefined,
  canonical: string,
  maxCharacters = 65_536,
): string | null {
  const shared = canonical.trim();
  if (!shared || shared.length > maxCharacters) {
    return null;
  }
  const runtime = manual?.trim();
  if (!runtime) {
    return shared;
  }
  const available = maxCharacters - shared.length - 2;
  return available <= 0 ? shared : `${runtime.slice(0, available)}\n\n${shared}`;
}

export function readCompactInstructions(sourcePaths: readonly string[], maxBytes = 65_536): string {
  if (sourcePaths.length > 32 || maxBytes < 1 || maxBytes > 1_048_576) {
    return '';
  }
  for (const source of sourcePaths) {
    let fd: number | undefined;
    try {
      fd = openSync(source, 'r');
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > maxBytes) {
        continue;
      }
      const text = readFileSync(fd, 'utf8').trim();
      if (text) {
        return text;
      }
    } catch {
      /* compaction must fail open */
    } finally {
      if (fd !== undefined) {
        closeSync(fd);
      }
    }
  }
  return '';
}

export interface ClaudeHookInput {
  readonly hook_event_name:
    | 'SessionStart'
    | 'UserPromptSubmit'
    | 'PreToolUse'
    | 'PostToolUse'
    | 'PostToolUseFailure'
    | 'PreCompact'
    | 'Notification'
    | 'Stop';
  readonly tool_name?: string;
  readonly tool_input?: Readonly<Record<string, unknown>>;
  readonly tool_response?: Readonly<Record<string, unknown>>;
  readonly notification_type?: string;
  readonly message?: string;
}
export interface ClaudeHookAdapterContext {
  readonly environment?: ProjectEnvironment;
  readonly machineContext?: string;
  readonly sessionContext?: string;
  readonly compactInstructions?: string;
  readonly configs?: readonly string[];
  readonly staged?: readonly { readonly file: string; readonly diff: string }[];
  readonly scripts?: Readonly<Record<string, string>>;
  readonly preCommit?: {
    readonly check: string;
    readonly exitCode: number;
    readonly output?: string;
  };
  readonly fallow?: FallowGateInput;
  readonly pullRequest?: 'exists' | 'missing' | 'unknown';
}
export interface ClaudeHookAdapterResult {
  readonly decision: 'allow' | 'deny';
  readonly code?: string;
  readonly message?: string;
  readonly additionalContext?: string;
  readonly notification?: string;
  readonly quality?: readonly QualityInvocation[];
  readonly evaluated: readonly string[];
}
function commandFrom(input: ClaudeHookInput): string {
  const value = input.tool_input?.command;
  return typeof value === 'string' ? value : '';
}
function contextResult(
  evaluated: string[],
  lines: readonly (string | undefined | null)[],
): ClaudeHookAdapterResult {
  const additionalContext = lines
    .filter((line): line is string => Boolean(line?.trim()))
    .join('\n');
  return { decision: 'allow', ...(additionalContext ? { additionalContext } : {}), evaluated };
}
/**
 * Pure Claude event adapter. The runtime shell gathers bounded observations and
 * executes returned argv; policy semantics and ordering stay provider-neutral.
 */
export function adaptClaudeHookEvent(
  input: ClaudeHookInput,
  context: ClaudeHookAdapterContext = {},
): ClaudeHookAdapterResult {
  const environment = context.environment ?? {
    packageManager: null,
    runner: ['npx'],
    toolchain: 'classic',
    framework: null,
    python: false,
  };
  if (input.hook_event_name === 'SessionStart') {
    return contextResult(
      ['machine-context', 'session-context', 'project-context'],
      [context.machineContext, context.sessionContext, buildCompactContext(environment).join('\n')],
    );
  }
  if (input.hook_event_name === 'PreCompact') {
    return contextResult(
      ['compaction-injection'],
      [context.compactInstructions, buildCompactContext(environment).join('\n')],
    );
  }
  if (input.hook_event_name === 'Notification' || input.hook_event_name === 'Stop') {
    return {
      decision: 'allow',
      notification: (input.message?.trim() || 'Claude requires attention').slice(0, 1024),
      evaluated: ['notification'],
    };
  }
  if (
    input.hook_event_name === 'PostToolUse' &&
    ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(input.tool_name ?? '')
  ) {
    const candidate = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    if (typeof candidate !== 'string') {
      return { decision: 'allow', evaluated: ['post-write-quality'] };
    }
    try {
      return {
        decision: 'allow',
        quality: planFileQuality({
          relativeFile: candidate,
          toolchain: environment.toolchain,
          runner: environment.runner as readonly [string, ...string[]],
          configs: context.configs ?? [],
        }),
        evaluated: ['post-write-quality'],
      };
    } catch (error) {
      return {
        decision: 'deny',
        code: error instanceof RuntimeHookError ? error.code : 'QUALITY_PLAN_FAILED',
        message: error instanceof Error ? error.message : String(error),
        evaluated: ['post-write-quality'],
      };
    }
  }
  if (
    (input.hook_event_name === 'PostToolUse' || input.hook_event_name === 'PostToolUseFailure') &&
    input.tool_name === 'Bash'
  ) {
    const command = commandFrom(input),
      response = input.tool_response ?? {},
      exitCode =
        typeof response.exit_code === 'number'
          ? response.exit_code
          : input.hook_event_name === 'PostToolUse'
            ? 0
            : 1;
    const assumption: PostCommandAssumption | undefined = /\bgit\s+push\b/u.test(command)
      ? { operation: 'git-push', exitCode, pullRequest: context.pullRequest ?? 'unknown' }
      : /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add)\b/u.test(command)
        ? {
            operation: 'package-install',
            exitCode,
            ...(typeof response.stderr === 'string' ? { stderr: response.stderr } : {}),
          }
        : undefined;
    return contextResult(
      ['post-command-context'],
      [assumption ? extractPostCommandContext(assumption) : null],
    );
  }
  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') {
    return { decision: 'allow', evaluated: [] };
  }
  const command = commandFrom(input),
    evaluated: string[] = [];
  evaluated.push('package-manager');
  const packageDecision = evaluatePackagePolicy(command, environment.packageManager);
  if (packageDecision.action === 'block') {
    return {
      decision: 'deny',
      ...(packageDecision.code ? { code: packageDecision.code } : {}),
      ...(packageDecision.message ? { message: packageDecision.message } : {}),
      evaluated,
    };
  }
  evaluated.push('pre-commit');
  let preCommit: PreCommitDecision;
  try {
    preCommit = evaluatePreCommit({
      command,
      packageManager: environment.packageManager,
      toolchain: environment.toolchain,
      framework: environment.framework,
      scripts: context.scripts ?? {},
      staged: context.staged ?? [],
    });
  } catch (error) {
    return {
      decision: 'deny',
      code: error instanceof RuntimeHookError ? error.code : 'PRE_COMMIT_FAILED',
      message: error instanceof Error ? error.message : String(error),
      evaluated,
    };
  }
  if (preCommit.action === 'block') {
    return { decision: 'deny', code: preCommit.code, message: preCommit.message, evaluated };
  }
  if (context.preCommit?.exitCode) {
    return {
      decision: 'deny',
      code: 'PRE_COMMIT_CHECK_FAILED',
      message: `${context.preCommit.check} failed before commit.${context.preCommit.output ? `\n${context.preCommit.output.slice(-8192)}` : ''}`,
      evaluated,
    };
  }
  evaluated.push('dangerous-command');
  const danger = classifyDangerousCommand(command);
  if (danger.action === 'block') {
    return {
      decision: 'deny',
      ...(danger.code ? { code: danger.code } : {}),
      ...(danger.message ? { message: danger.message } : {}),
      evaluated,
    };
  }
  evaluated.push('fallow');
  const fallow = evaluateFallowGate(context.fallow ?? { command, minimumVersion: '2.46.0' });
  if (fallow.action === 'block') {
    return {
      decision: 'deny',
      ...(fallow.code ? { code: fallow.code } : {}),
      ...(fallow.message ? { message: fallow.message } : {}),
      evaluated,
    };
  }
  const warnings = [...packageDecision.warnings, ...preCommit.warnings, fallow.warning].filter(
    (item): item is string => Boolean(item),
  );
  return {
    decision: 'allow',
    ...(warnings.length ? { additionalContext: warnings.join('\n') } : {}),
    evaluated,
  };
}

const DEFAULT_PROJECTED_ENVIRONMENT: ProjectEnvironment = Object.freeze({
  packageManager: 'pnpm',
  runner: Object.freeze(['pnpm', 'exec']),
  toolchain: 'classic',
  framework: null,
  python: false,
});

/**
 * Provider-neutral defaults formerly composed by the Pi projection adapter.
 * Runtime adapters only normalize native events and deliver these evaluator results.
 */
function createDefaultProjectedRuntimePolicies(
  options: {
    readonly environment?: ProjectEnvironment;
    readonly processEnvironment?: Readonly<Record<string, string | undefined>>;
    readonly platform?: NodeJS.Platform;
  } = {},
) {
  const environment = options.environment ?? DEFAULT_PROJECTED_ENVIRONMENT;
  return Object.freeze({
    session: () => planSessionContext(options.processEnvironment ?? process.env),
    toolCall(input: Record<string, unknown>) {
      const command = String(input.command ?? '');
      const packageDecision = evaluatePackagePolicy(command, environment.packageManager);
      if (packageDecision.action === 'block') {
        return packageDecision;
      }
      const precommit = evaluatePreCommit({
        command,
        packageManager: environment.packageManager,
        toolchain: environment.toolchain,
        framework: environment.framework,
        scripts: {},
        staged: Array.isArray(input.staged)
          ? (input.staged as Array<{ file: string; diff: string }>)
          : [],
      });
      if (precommit.action === 'block') {
        return precommit;
      }
      const fallow = evaluateFallowGate({
        command,
        minimumVersion: '2.46.0',
        ...(input.fallow && typeof input.fallow === 'object'
          ? {
              runner: { description: 'fallow', version: '2.46.0' },
              audit: { stdout: '', stderr: '', ...(input.fallow as { status: number }) },
            }
          : {}),
      });
      return fallow.warning
        ? { action: 'allow' as const, warning: fallow.warning }
        : { action: 'allow' as const };
    },
    postWrite: (file: string) =>
      planFileQuality({
        relativeFile: file,
        toolchain: environment.toolchain,
        runner: environment.runner as readonly [string, ...string[]],
        configs: [],
      }),
    postCommand: (command: string, stderr: string) =>
      extractPostCommandContext({
        operation: 'package-install',
        exitCode: 0,
        stderr: /(?:npm|pnpm|yarn|bun)\s+(?:install|add)/u.test(command) ? stderr : '',
      }),
    compact: (manualInstructions: string) =>
      planCompactionInjection({
        manualInstructions,
        canonicalInstructions: 'Preserve immutable launch authority.',
        environment,
      }),
    notification: () =>
      planNotification({
        event: 'turn-settled',
        platform: options.platform ?? process.platform,
        sessionRole: 'top-level',
      }),
  });
}

export const defaultProjectedRuntimePolicies = createDefaultProjectedRuntimePolicies();

export interface RuntimeCommandPolicySourcePlanV1 {
  readonly schemaVersion: 1;
  readonly packageDecision: string;
  readonly preCommitDecision: string;
  readonly fallowDecision: string;
}

/**
 * Deterministic dependency-free policy fragments inserted into immutable runtime adapters.
 *
 * CODE CONTRACT: these V1 fragments duplicate canonical evaluator behavior because projected
 * hooks cannot import workspace packages. Every intended overlap belongs in the parity matrix.
 * Historical V1 compatibility is explicit: its pre-commit fragment scans `.lockb` files while
 * `shouldScanStagedFile` skips them. Do not broaden a parity claim or change projected bytes
 * without updating that matrix and the compatibility note.
 */
export function projectRuntimeCommandPolicySourceV1(): RuntimeCommandPolicySourcePlanV1 {
  return Object.freeze({
    schemaVersion: 1,
    packageDecision: String.raw`function packageDecision(command,selected=manager()){if(!selected)return null;const primary=typeof command==="string"?command.trim().split(/\s+/u)[0]:"";if(["npm","pnpm","yarn","bun"].includes(primary)&&primary!==selected)return{code:"WRONG_PACKAGE_MANAGER",message:"This project uses "+selected+"; use it instead of "+primary+"."};if(selected==="bun"&&/(?:^|\s)npx\s/u.test(command))return{code:"WRONG_PACKAGE_RUNNER",message:"This project uses bunx instead of npx."};if(/(?:^|[;&|]\s*|\s)npx\s+tsc(?:\s|$)/u.test(command))return{code:"DIRECT_TSC",message:"Use "+selected+" run typecheck or the project check script."};return null}
`,
    preCommitDecision: String.raw`function preCommit(command){if(!/(?:^|[\s;&|()])git\s+commit(?:\s|$)/u.test(command))return null;const names=run("git",["diff","--cached","--name-only","-z"],10000);if(names.status!==0)return{warning:"pre-commit: staged files unavailable; skipped (fail-open)."};for(const file of names.stdout.split("\0").filter(Boolean).slice(0,1000)){if(/(?:\.lock$|lock\.(?:json|yaml)$|\.env\.(?:example|sample|template)$|\.(?:test|spec)\.[jt]sx?$)/u.test(file))continue;const diff=run("git",["diff","--cached","--unified=0","--",file],10000);if(diff.status!==0)continue;if(diff.stdout.split("\n").some(line=>line.startsWith("+")&&!line.startsWith("+++")&&/(?:AKIA[0-9A-Z]{16}|gh[po]_[a-zA-Z0-9]{36}|-----BEGIN[A-Z ]*PRIVATE KEY-----|xox[bpors]-[a-zA-Z0-9-]+|\b(?:password|secret|api_key|apikey|auth_token)\b\s*[:=]\s*["']?[^"'\s]{8,})/iu.test(line)))return{block:{code:"STAGED_SECRET",message:"Remove staged secrets before committing ("+file+")."}}}const check=process.env.MPX_PRECOMMIT_CHECK,selected=manager();if(check&&selected){const checked=run(selected,["run",check]);if(checked.status!==0)return{block:{code:"PRE_COMMIT_CHECK_FAILED",message:check+" failed before commit.\n"+(checked.stderr||checked.stdout).split("\n").slice(-50).join("\n")}}}const subject=command.match(/-m\s+["']([^"']+)["']/u)?.[1];if(subject&&!/^(?:feat|fix|refactor|chore|docs|style|test|perf|ci|build|revert)(?:\(.+\))?: .+/u.test(subject))return{warning:"Warning: commit message does not match conventional format: type(scope): description"};return null}
`,
    fallowDecision: String.raw`function fallow(command){if(!process.env.MPX_FALLOW_EXECUTABLE||!/(^|[\s;|&()])git\s+(?:commit|push)(?:\s|$)/u.test(command))return null;const executable=process.env.MPX_FALLOW_EXECUTABLE,version=run(executable,["--version"],5000);if(version.status!==0)return{warning:"fallow-gate: fallow binary not found; skipping."};const audit=run(executable,["audit","--json"],30000);let parsed;try{parsed=JSON.parse(audit.stdout)}catch{}if(parsed?.verdict==="fail")return{block:{code:"FALLOW_AUDIT_FAILED",message:"Blocked by fallow."}};if(audit.status!==0||parsed?.error===true)return{warning:"fallow-gate: audit runtime error; skipping."};return null}
`,
  });
}

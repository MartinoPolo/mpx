import path from 'node:path';

export interface StaticShellCommand {
  readonly words: readonly ShellWord[];
  readonly cwd: string | undefined;
}

export interface ShellWord {
  readonly value: string;
  /** True when expansion can change this word's value. */
  readonly dynamic: boolean;
}

export interface StaticShellInspection {
  readonly commands: readonly StaticShellCommand[];
  readonly diagnostics: readonly string[];
}

type Token = ShellWord | { readonly operator: string };

const MAX_COMMAND_LENGTH = 64 * 1024;

function isOperator(token: Token): token is { readonly operator: string } {
  return 'operator' in token;
}

function tokenize(input: string): { tokens: Token[]; opaqueExpansion: boolean; malformed: boolean } {
  const tokens: Token[] = [];
  let value = '';
  let dynamic = false;
  let opaqueExpansion = false;
  let quote: "'" | '"' | undefined;
  let malformed = false;

  const word = (): void => {
    if (value !== '' || dynamic) tokens.push({ value, dynamic });
    value = '';
    dynamic = false;
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] ?? '';
    if (quote === "'") {
      if (character === "'") quote = undefined;
      else value += character;
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = undefined;
      } else if (character === '\\') {
        const next = input[index + 1];
        if (next !== undefined && ['$', '`', '"', '\\', '\n'].includes(next)) {
          value += next === '\n' ? '' : next;
          index += 1;
        } else {
          value += character;
        }
      } else {
        value += character;
        if (character === '$') {
          dynamic = true;
          if (input[index + 1] === '(') opaqueExpansion = true;
        } else if (character === '`') {
          dynamic = true;
          opaqueExpansion = true;
        }
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '\\') {
      const next = input[index + 1];
      if (next !== undefined) {
        value += next;
        index += 1;
      } else {
        malformed = true;
      }
      continue;
    }
    if (character === '#' && value === '') {
      while (index < input.length && input[index] !== '\n') index += 1;
      index -= 1;
      continue;
    }
    if (/\s/u.test(character)) {
      word();
      if (character === '\n' || character === '\r') tokens.push({ operator: ';' });
      continue;
    }
    if (character === '$' && input[index + 1] === '{') {
      let depth = 1;
      let end = index + 2;
      for (; end < input.length && depth > 0; end += 1) {
        if (input[end] === '$' && input[end + 1] === '{') {
          depth += 1;
          end += 1;
        } else if (input[end] === '}') {
          depth -= 1;
        }
      }
      if (depth !== 0) {
        malformed = true;
        value += input.slice(index);
        dynamic = true;
        break;
      }
      const expansion = input.slice(index, end);
      value += expansion;
      dynamic = true;
      if (expansion.includes('$(') || expansion.includes('`')) opaqueExpansion = true;
      index = end - 1;
      continue;
    }
    const pair = `${character}${input[index + 1] ?? ''}`;
    if (pair === '&&' || pair === '||') {
      word();
      tokens.push({ operator: pair });
      index += 1;
      continue;
    }
    if (';|&(){}'.includes(character)) {
      word();
      tokens.push({ operator: character });
      continue;
    }
    value += character;
    if (character === '$') {
      dynamic = true;
      if (input[index + 1] === '(') opaqueExpansion = true;
    } else if (character === '`') {
      dynamic = true;
      opaqueExpansion = true;
    }
  }
  if (quote) malformed = true;
  word();
  return { tokens, opaqueExpansion, malformed };
}

function nativeLiteralPath(value: string): string {
  if (process.platform === 'win32') {
    const gitBash = value.match(/^\/([A-Za-z])(?:\/(.*))?$/u);
    if (gitBash) return `${gitBash[1]?.toUpperCase()}:/${gitBash[2] ?? ''}`;
  }
  return value;
}

function absoluteLiteral(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value) || /^\/[A-Za-z](?:\/|$)/u.test(value);
}

function resolveDirectory(current: string | undefined, target: ShellWord | undefined): string | undefined {
  if (!target || target.dynamic || target.value === '' || target.value === '-' || target.value.startsWith('~')) {
    return undefined;
  }
  const literal = nativeLiteralPath(target.value);
  if (absoluteLiteral(target.value)) return path.normalize(literal);
  return current === undefined ? undefined : path.resolve(current, literal);
}

interface PreparedCommand {
  readonly words: readonly ShellWord[];
  readonly envChdir?: ShellWord;
  readonly envWrapped?: boolean;
  readonly unsupportedEnvOption?: string;
}

function commandWords(segment: readonly ShellWord[]): PreparedCommand {
  let index = 0;
  while (segment[index] && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(segment[index]?.value ?? '')) index += 1;
  let words = segment.slice(index);
  while (['command', 'exec', 'time'].includes(words[0]?.value ?? '')) words = words.slice(1);
  if (words[0]?.value !== 'env') return { words };

  let envIndex = 1;
  let envChdir: ShellWord | undefined;
  while (words[envIndex]) {
    const option = words[envIndex];
    const value = option?.value ?? '';
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(value)) {
      envIndex += 1;
      continue;
    }
    if (value === '--') {
      envIndex += 1;
      break;
    }
    if (['-i', '--ignore-environment', '-0', '--null', '--debug'].includes(value)) {
      envIndex += 1;
      continue;
    }
    if (value === '-u' || value === '--unset' || value === '--argv0') {
      if (!words[envIndex + 1]) return { words: [], unsupportedEnvOption: value };
      envIndex += 2;
      continue;
    }
    if (value.startsWith('--unset=') || value.startsWith('--argv0=')) {
      envIndex += 1;
      continue;
    }
    if (value.startsWith('-u') && value.length > 2) {
      envIndex += 1;
      continue;
    }
    if (value === '-C' || value === '--chdir') {
      envChdir = words[envIndex + 1];
      if (!envChdir) return { words: [], unsupportedEnvOption: value };
      envIndex += 2;
      continue;
    }
    if (value.startsWith('--chdir=')) {
      envChdir = { value: value.slice('--chdir='.length), dynamic: option?.dynamic ?? false };
      envIndex += 1;
      continue;
    }
    if (value.startsWith('-C') && value.length > 2) {
      envChdir = { value: value.slice(2), dynamic: option?.dynamic ?? false };
      envIndex += 1;
      continue;
    }
    if (value === '-S' || value === '--split-string' || value.startsWith('--split-string=')) {
      return { words: [], unsupportedEnvOption: value };
    }
    if (value.startsWith('-')) return { words: [], unsupportedEnvOption: value };
    break;
  }
  return { words: words.slice(envIndex), envChdir, envWrapped: true };
}

function executableName(value: string): string {
  return value.split(/[\\/]/u).at(-1)?.replace(/\.(?:exe|cmd|bat)$/iu, '').toLowerCase() ?? '';
}

function inspect(input: string, initialCwd: string | undefined, depth: number): StaticShellInspection {
  const commands: StaticShellCommand[] = [];
  const diagnostics: string[] = [];
  if (input.length > MAX_COMMAND_LENGTH) {
    return {
      commands,
      diagnostics: ['Package-manager inspection skipped a shell command that exceeds the supported size limit.'],
    };
  }

  const parsed = tokenize(input);
  if (parsed.malformed) {
    return {
      commands,
      diagnostics: ['Package-manager inspection skipped unsupported malformed shell quoting.'],
    };
  }
  if (parsed.opaqueExpansion) diagnostics.push('Package-manager inspection cannot inspect command substitution in this shell command.');
  if (parsed.tokens.some((token) => isOperator(token) && (token.operator === '|' || token.operator === '&'))) {
    diagnostics.push('Package-manager inspection found an unsupported pipeline or background command; its effective directory is unresolved.');
  }
  if (parsed.tokens.some((token) => isOperator(token) && '(){}'.includes(token.operator))) {
    return {
      commands,
      diagnostics: ['Package-manager inspection skipped unsupported shell grouping.'],
    };
  }

  const segments: Array<{ words: ShellWord[]; separator: string | undefined }> = [];
  let segment: ShellWord[] = [];
  for (const token of parsed.tokens) {
    if (!isOperator(token)) {
      segment.push(token);
      continue;
    }
    if (segment.length > 0) segments.push({ words: segment, separator: token.operator });
    segment = [];
  }
  if (segment.length > 0) segments.push({ words: segment, separator: undefined });
  const controlWords = new Set([
    'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'case', 'esac', 'do', 'done', 'function',
  ]);
  if (
    segments.some((item) => {
      const prepared = commandWords(item.words);
      return controlWords.has(executableName(prepared.words[0]?.value ?? ''));
    })
  ) {
    return {
      commands,
      diagnostics: ['Package-manager inspection skipped unsupported shell control-flow grammar.'],
    };
  }

  let current = initialCwd;
  let incomingSeparator: string | undefined;
  let successChainDirectory = false;
  for (const item of segments) {
    if (successChainDirectory && incomingSeparator !== '&&') {
      current = undefined;
      successChainDirectory = false;
    }
    const pipelineOrBackground = ['|', '&'].includes(incomingSeparator ?? '') ||
      ['|', '&'].includes(item.separator ?? '');
    if (pipelineOrBackground) {
      current = undefined;
      successChainDirectory = false;
    }

    const prepared = commandWords(item.words);
    if (prepared.unsupportedEnvOption) {
      diagnostics.push(`Package-manager inspection skipped unsupported env option ${prepared.unsupportedEnvOption}.`);
      incomingSeparator = item.separator;
      continue;
    }
    const words = prepared.words;
    if (words.length === 0) {
      incomingSeparator = item.separator;
      continue;
    }
    const executable = words[0];
    const name = executableName(executable?.value ?? '');
    if (executable?.dynamic) {
      diagnostics.push('Package-manager inspection skipped a command with a dynamic executable.');
      if (item.separator !== '|' && item.separator !== '&') current = undefined;
      incomingSeparator = item.separator;
      continue;
    }
    if ((name === 'cd' || name === 'pushd') && !prepared.envWrapped) {
      let targetIndex = 1;
      while (words[targetIndex] && ['-L', '-P', '-e'].includes(words[targetIndex]?.value ?? '')) targetIndex += 1;
      if (words[targetIndex]?.value === '--') targetIndex += 1;
      const next = resolveDirectory(current, words[targetIndex]);
      if (!pipelineOrBackground && item.separator === '&&' && incomingSeparator !== '||') {
        current = next;
        successChainDirectory = true;
      } else {
        current = undefined;
        successChainDirectory = false;
      }
      incomingSeparator = item.separator;
      continue;
    }
    if (name === 'popd' && !prepared.envWrapped) {
      current = undefined;
      successChainDirectory = false;
      incomingSeparator = item.separator;
      continue;
    }
    if (['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(name)) {
      const optionIndex = words.findIndex((entry, index) => index > 0 && /^-[A-Za-z]*c[A-Za-z]*$/u.test(entry.value));
      const script = optionIndex >= 0 ? words[optionIndex + 1] : undefined;
      if (depth >= 4 || !script || script.dynamic) {
        diagnostics.push(`Package-manager inspection skipped unsupported ${name} shell wrapper.`);
      } else {
        const nested = inspect(script.value, prepared.envChdir ? resolveDirectory(current, prepared.envChdir) : current, depth + 1);
        commands.push(...nested.commands);
        diagnostics.push(...nested.diagnostics);
      }
      incomingSeparator = item.separator;
      continue;
    }
    if (['cmd', 'powershell', 'pwsh', 'eval', 'source', '.', '!'].includes(name)) {
      diagnostics.push(`Package-manager inspection skipped unsupported ${name} shell wrapper.`);
      if (['eval', 'source', '.'].includes(name) && !pipelineOrBackground) {
        current = undefined;
        successChainDirectory = false;
      }
      incomingSeparator = item.separator;
      continue;
    }
    commands.push({
      words,
      cwd: pipelineOrBackground
        ? undefined
        : prepared.envChdir
          ? resolveDirectory(current, prepared.envChdir)
          : current,
    });
    incomingSeparator = item.separator;
  }
  return { commands, diagnostics: [...new Set(diagnostics)] };
}

/** Inspect simple, literal Git-Bash command lists without executing them. */
export function inspectStaticShell(command: string, cwd: string): StaticShellInspection {
  return inspect(command, path.resolve(cwd), 0);
}

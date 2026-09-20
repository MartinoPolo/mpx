import path from 'node:path';

export interface StaticShellCommand {
  readonly words: readonly ShellWord[];
  readonly cwd: string | undefined;
  readonly hasRedirection: boolean;
}

export interface ShellWord {
  readonly value: string;
  /** True when expansion can change this word's value. */
  readonly dynamic: boolean;
}

export interface StaticShellInspection {
  readonly commands: readonly StaticShellCommand[];
  readonly diagnostics: readonly string[];
  readonly uninspected: readonly (readonly ShellWord[])[];
  readonly opaqueInputs: readonly string[];
}

type Token = ShellWord | { readonly operator: string } | { readonly redirection: string };

const MAX_COMMAND_LENGTH = 64 * 1024;

function isOperator(token: Token): token is { readonly operator: string } { return 'operator' in token; }
function isRedirection(token: Token): token is { readonly redirection: string } { return 'redirection' in token; }

function tokenize(input: string): { tokens: Token[]; opaqueExpansion: boolean; malformed: boolean; unsupportedSyntax: boolean } {
  const tokens: Token[] = [];
  let value = '';
  let dynamic = false;
  let opaqueExpansion = false;
  let quote: "'" | '"' | undefined;
  let malformed = false;
  let unsupportedSyntax = false;

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
    const redirectStart = character === '<' || character === '>' ||
      (character === '&' && input[index + 1] === '>');
    if (redirectStart) {
      if ((character === '<' && input[index + 1] === '<') ||
        ((character === '<' || character === '>') && input[index + 1] === '(')) unsupportedSyntax = true;
      if (/^\d*$/u.test(value)) { value = ''; dynamic = false; }
      else word();
      let redirect = character;
      if (character === '&') { redirect += '>'; index += 1; if (input[index + 1] === '>') { redirect += '>'; index += 1; } }
      else if (character === '>' && input[index + 1] === '>') { redirect += '>'; index += 1; }
      else if (input[index + 1] === '&' || (character === '>' && input[index + 1] === '|') || (character === '<' && input[index + 1] === '>')) { redirect += input[index + 1]; index += 1; }
      tokens.push({ redirection: redirect });
      continue;
    }
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
  return { tokens, opaqueExpansion, malformed, unsupportedSyntax };
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
  const uninspected: ShellWord[][] = [];
  const opaqueInputs: string[] = [];
  const opaque = (message: string): StaticShellInspection => ({
    commands, diagnostics: [message], uninspected: [], opaqueInputs: [input],
  });
  if (input.length > MAX_COMMAND_LENGTH) return opaque('Package-manager inspection skipped a shell command that exceeds the supported size limit.');
  const parsed = tokenize(input);
  if (parsed.unsupportedSyntax) return opaque('Package-manager inspection skipped unsupported heredoc or process-substitution syntax.');
  if (parsed.malformed) return opaque('Package-manager inspection skipped unsupported malformed shell quoting.');
  if (parsed.opaqueExpansion) {
    diagnostics.push('Package-manager inspection cannot inspect command substitution in this shell command.');
    uninspected.push([{ value: '<command-substitution>', dynamic: true }]);
  }

  interface Segment { words: ShellWord[]; separator: string | undefined; hasRedirection: boolean }
  const segments: Segment[] = [];
  let segment: ShellWord[] = [];
  let hasRedirection = false;
  let redirectNeedsTarget = false;
  let unsupportedStructure = false;
  for (const token of parsed.tokens) {
    if (isRedirection(token)) { hasRedirection = true; redirectNeedsTarget = true; continue; }
    if (!isOperator(token)) {
      if (redirectNeedsTarget) redirectNeedsTarget = false;
      else segment.push(token);
      continue;
    }
    if ('(){}'.includes(token.operator)) unsupportedStructure = true;
    if (redirectNeedsTarget) diagnostics.push('Package-manager inspection skipped malformed shell redirection.');
    redirectNeedsTarget = false;
    if (segment.length > 0) segments.push({ words: segment, separator: token.operator, hasRedirection });
    segment = []; hasRedirection = false;
  }
  if (redirectNeedsTarget) diagnostics.push('Package-manager inspection skipped malformed shell redirection.');
  if (segment.length > 0) segments.push({ words: segment, separator: undefined, hasRedirection });

  const controlWords = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'case', 'esac', 'do', 'done', 'function']);
  const hasControlFlow = segments.some(item => controlWords.has(executableName(commandWords(item.words).words[0]?.value ?? '')));
  if (unsupportedStructure || hasControlFlow) {
    const commandPrefixes = new Set(['if', 'then', 'elif', 'else', 'while', 'until', 'do']);
    const candidates = segments.map(item => {
      const words = commandWords(item.words).words;
      const name = executableName(words[0]?.value ?? '');
      if (!controlWords.has(name)) return [...words];
      if (!commandPrefixes.has(name)) return [];
      const body = words.slice(1);
      const prepared = commandWords(body);
      return [...(prepared.unsupportedEnvOption ? body : prepared.words)];
    }).filter(words => words.length > 0);
    return {
      commands,
      diagnostics: [unsupportedStructure ? 'Package-manager inspection skipped unsupported shell grouping.' : 'Package-manager inspection skipped unsupported shell control-flow grammar.'],
      uninspected: [...uninspected, ...candidates], opaqueInputs,
    };
  }

  interface Pipeline { stages: Segment[]; separator: string | undefined }
  interface AndList { pipelines: Pipeline[]; terminator: string | undefined }
  const lists: AndList[] = [];
  let cursor = 0;
  while (cursor < segments.length) {
    const pipelines: Pipeline[] = [];
    for (;;) {
      const stages: Segment[] = [];
      for (;;) {
        const stage = segments[cursor++];
        if (!stage) break;
        stages.push(stage);
        if (stage.separator !== '|') break;
      }
      const separator = stages.at(-1)?.separator;
      pipelines.push({ stages, separator });
      if (separator !== '&&' && separator !== '||') break;
    }
    lists.push({ pipelines, terminator: pipelines.at(-1)?.separator });
  }

  let parentCwd = initialCwd;
  for (const list of lists) {
    const entryCwd = parentCwd;
    let listCwd = entryCwd;
    let possibleMutation = false;
    let previousConnector: string | undefined;
    for (const pipeline of list.pipelines) {
      const preparedStages = pipeline.stages.map(item => ({ item, prepared: commandWords(item.words) }));
      const directMutation = preparedStages.some(({ prepared }) =>
        !prepared.envWrapped && ['cd', 'pushd', 'popd'].includes((prepared.words[0]?.value ?? '').toLowerCase()),
      );
      const pipelineCwd = directMutation && pipeline.stages.length > 1 ? undefined : listCwd;
      if (directMutation && pipeline.stages.length > 1) { listCwd = undefined; possibleMutation = true; }

      for (const { item, prepared } of preparedStages) {
        if (prepared.unsupportedEnvOption) {
          diagnostics.push(`Package-manager inspection skipped unsupported env option ${prepared.unsupportedEnvOption}.`);
          uninspected.push(item.words); continue;
        }
        const words = prepared.words;
        if (words.length === 0) continue;
        const executable = words[0];
        const name = executableName(executable?.value ?? '');
        const shellBuiltin = (executable?.value ?? '').toLowerCase();
        if (executable?.dynamic) {
          diagnostics.push('Package-manager inspection skipped a command with a dynamic executable.');
          uninspected.push([...words]); listCwd = undefined; possibleMutation = true; continue;
        }
        if (!prepared.envWrapped && (shellBuiltin === 'cd' || shellBuiltin === 'pushd')) {
          possibleMutation = true;
          if (pipeline.stages.length === 1 && pipeline.separator === '&&' && previousConnector !== '||') {
            let targetIndex = 1;
            while (words[targetIndex] && ['-L', '-P', '-e'].includes(words[targetIndex]?.value ?? '')) targetIndex += 1;
            if (words[targetIndex]?.value === '--') targetIndex += 1;
            listCwd = resolveDirectory(listCwd, words[targetIndex]);
          } else listCwd = undefined;
          continue;
        }
        if (!prepared.envWrapped && shellBuiltin === 'popd') { listCwd = undefined; possibleMutation = true; continue; }
        const commandCwd = prepared.envChdir ? resolveDirectory(pipelineCwd, prepared.envChdir) : pipelineCwd;
        if (['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(name)) {
          const optionIndex = words.findIndex((entry, index) => index > 0 && /^-[A-Za-z]*c[A-Za-z]*$/u.test(entry.value));
          const script = optionIndex >= 0 ? words[optionIndex + 1] : undefined;
          if (depth >= 4 || !script || script.dynamic) {
            diagnostics.push(`Package-manager inspection skipped unsupported ${name} shell wrapper.`); uninspected.push([...words]);
          } else {
            const nested = inspect(script.value, commandCwd, depth + 1);
            commands.push(...nested.commands.map(command => ({ ...command, hasRedirection: command.hasRedirection || item.hasRedirection })));
            diagnostics.push(...nested.diagnostics);
            uninspected.push(...nested.uninspected.map(fragment => [...fragment]));
            opaqueInputs.push(...nested.opaqueInputs);
          }
          continue;
        }
        if (['cmd', 'powershell', 'pwsh', 'sudo', 'eval', 'source', '.', '!'].includes(name)) {
          diagnostics.push(`Package-manager inspection skipped unsupported ${name} shell wrapper.`); uninspected.push([...words]);
          if (['eval', 'source', '.'].includes(name)) { listCwd = undefined; possibleMutation = true; }
          continue;
        }
        commands.push({ words, cwd: commandCwd, hasRedirection: item.hasRedirection });
      }
      if (pipeline.separator === '||' && possibleMutation) listCwd = undefined;
      previousConnector = pipeline.separator;
    }
    if (list.terminator === '&') parentCwd = entryCwd;
    else if (possibleMutation) parentCwd = undefined;
    else parentCwd = entryCwd;
  }
  return { commands, diagnostics: [...new Set(diagnostics)], uninspected, opaqueInputs };
}

/** Inspect simple, literal Git-Bash command lists without executing them. */
export function inspectStaticShell(command: string, cwd: string): StaticShellInspection {
  return inspect(command, path.resolve(cwd), 0);
}

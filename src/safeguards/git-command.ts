import path from 'node:path';
import { inspectStaticShell, type StaticShellCommand } from './shell.js';

export interface GitInvocation { operation: string; args: string[]; cwd?: string; prefix: readonly StaticShellCommand[] }
export function gitInvocations(command: string, cwd: string): { invocations: GitInvocation[]; diagnostics: readonly string[] } {
  const inspected = inspectStaticShell(command, cwd);
  const invocations: GitInvocation[] = [];
  for (const [index, call] of inspected.commands.entries()) {
    if (!/(?:^|[\\/])git(?:\.exe)?$/i.test(call.words[0]?.value ?? '')) continue;
    let directory = call.cwd; let cursor = 1;
    while (call.words[cursor]?.value.startsWith('-')) {
      const word = call.words[cursor++]!;
      if (word.value === '-C') {
        const target = call.words[cursor++];
        directory = !target || target.dynamic || !directory ? undefined : path.resolve(directory, target.value);
      } else if (['-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(word.value)) {
        cursor++; directory = undefined;
      } else if (/^--(?:git-dir|work-tree|namespace|config-env)=/.test(word.value)) directory = undefined;
      else if (!['--no-pager', '--paginate', '--literal-pathspecs', '--no-optional-locks'].includes(word.value)) directory = undefined;
    }
    invocations.push({ operation: call.words[cursor]?.value ?? '', args: call.words.slice(cursor + 1).map(w => w.value), cwd: directory, prefix: inspected.commands.slice(0, index) });
  }
  return { invocations, diagnostics: inspected.diagnostics };
}
const READ_ONLY_GIT = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'remote']);
export function readOnlyPrefix(calls: readonly StaticShellCommand[]): boolean {
  return calls.every(call => {
    const [first, operation, ...args] = call.words.map(w => w.value);
    if (['echo', 'printf', 'pwd', 'true', 'test', '['].includes(first ?? '')) return !call.words.some(w => /[<>]/.test(w.value));
    if (first === 'git' && READ_ONLY_GIT.has(operation ?? '')) return operation !== 'remote' || args.length === 0 || args.every(a => ['-v', '--verbose'].includes(a));
    return false;
  });
}

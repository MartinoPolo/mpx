import type { RuntimeScope } from '../src/runtime-install.js';

function replaceOnce(source: string, before: string, after: string): string {
  const lines = source.split('\n');
  const matches = lines.flatMap((line, index) => line === before ? [index] : []);
  if (matches.length !== 1) throw new Error('Launcher layout changed; preserve it and review before rollout.');
  lines[matches[0]!] = after;
  return lines.join('\n');
}

export function renderAccountRolloutShell(source: string, scopes: readonly RuntimeScope[]): string {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  let result = source.replaceAll('\r\n', '\n');
  const unique = new Set(scopes.map(scope => `${scope.account}/${scope.harness}`));
  if (unique.size !== scopes.length) throw new Error('Duplicate launcher rollout scope.');
  for (const scope of scopes) {
    if (!['personal', 'work'].includes(scope.account) || !['pi', 'claude'].includes(scope.harness)) throw new Error('Invalid launcher rollout scope.');
    if (scope.harness === 'pi') {
      if (scope.account === 'personal') throw new Error('Personal Pi already belongs to the accepted pilot.');
      result = replaceOnce(result, 'piw() { piw-mpx "$@"; }', 'piw() { bash "${MPX_PROJECTS:?piw requires MPX_PROJECTS}/mpx2/bin/piw" "$@"; }');
      continue;
    }
    const command = scope.account === 'personal' ? 'cc' : 'ccw';
    const legacy = scope.account === 'personal'
      ? 'xcc()  { _claude_account_launch personal "$HOME/.claude"      "$@"; }'
      : 'xccw() { _claude_account_launch work     "$HOME/.claude-work" "$@"; }';
    if (new RegExp(`^l${command}\\(\\)`, 'mu').test(result)) throw new Error('Original Claude fallback launcher already exists; preserve it.');
    result = replaceOnce(result, legacy, `${legacy.replace(`x${command}()`, `l${command}()`)}\nx${command}() { ${command}-mpx "$@"; }`);
    result = replaceOnce(result, `${command}() { ${command}-mpx "$@"; }`, `${command}() { bash "\${MPX_PROJECTS:?${command} requires MPX_PROJECTS}/mpx2/bin/${command}" "$@"; }`);
  }
  return result.replaceAll('\n', newline);
}

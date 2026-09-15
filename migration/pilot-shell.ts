function replaceOnce(source: string, before: string, after: string) {
  if (source.split(before).length !== 2) throw new Error('Shell layout changed; review the pilot aliases before applying.');
  return source.replace(before, after);
}

export function renderPilotShell(source: string) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  let result = source.replaceAll('\r\n', '\n');
  if (result.includes('# MPX2 PERSONAL PILOT')) throw new Error('Pilot aliases already present; inspect rather than overwrite.');
  result = replaceOnce(result,
    'xpi()  { _pi_account_launch personal "$HOME/.pi/agent"      "$@"; }\nxpiw() { _pi_account_launch work     "$HOME/.pi/agent-work" "$@"; }',
    '# MPX2 PERSONAL PILOT — current MPX and original legacy remain separate routes.\nlpi()  { _pi_account_launch personal "$HOME/.pi/agent"      "$@"; }\nlpiw() { _pi_account_launch work     "$HOME/.pi/agent-work" "$@"; }\nxpi()  { pi-mpx "$@"; }\nxpiw() { piw-mpx "$@"; }');
  result = replaceOnce(result, 'pi() { pi-mpx "$@"; }', 'pi() { bash "${MPX_PROJECTS:?pi requires MPX_PROJECTS}/mpx2/bin/pi" "$@"; }');
  result = replaceOnce(result,
    'MPX_RUNTIME*|MPX_ACTIVE_CONTENT*|MPX_COMPILED_AGENTS_DIR|MPX_SESSION_LIFECYCLE_*|MPX_IDENTITY|MPX_MODE)',
    'MPX_RUNTIME*|MPX_ACTIVE_CONTENT*|MPX_ACCOUNT|MPX_COMPILED_AGENTS_DIR|MPX_SESSION_LIFECYCLE_*|MPX_IDENTITY|MPX_MODE)');
  result = replaceOnce(result,
    '    PI_CODING_AGENT_DIR="$(cygpath -w "$config_dir")" PI_PANE_ACCOUNT="$account" \\\n      command pi --use-theme dark "${extension_args[@]}" "$@"',
    '    local legacy_skills=(--skill "$HOME/.agents/skills/mpx")\n    local native_argument\n    for native_argument in "$@"; do\n      [[ "$native_argument" != --no-skills && "$native_argument" != -ns ]] || legacy_skills=()\n    done\n    printf "LEGACY Pi · %s · existing native profile\\n" "$account" >&2\n    PI_CODING_AGENT_DIR="$(cygpath -w "$config_dir")" PI_PANE_ACCOUNT="$account" \\\n      command pi --use-theme dark "${extension_args[@]}" "${legacy_skills[@]}" "$@"');
  return result.replaceAll('\n', newline);
}

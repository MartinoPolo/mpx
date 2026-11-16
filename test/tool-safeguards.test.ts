import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { evaluateTool } from '../src/safeguards/tools.js';
import { handleClaudeHook, POST_COMPACTION_RESTART } from '../src/claude-hooks.js';

test('shared interception blocks NUL, dangerous commands, manager mismatches and uninspected commit mutations', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mpx-tools-'));
  const options = { isTrusted: () => false };
  try {
    await mkdir(join(cwd, '.git'));
    await writeFile(join(cwd, 'package.json'), '{"packageManager":"pnpm@11.15.1"}');
    for (const name of ['write', 'edit', 'Write', 'Edit', 'NotebookEdit']) {
      assert.equal((await evaluateTool({ name, input: { path: 'NUL' }, cwd }, options)).decision, 'block');
    }
    assert.equal((await evaluateTool({ name: 'apply_patch', input: { patch: '*** Begin Patch\n*** Add File: nested/NUL\n+hello\n*** End Patch' }, cwd }, options)).decision, 'block');
    for (const command of ['rm -rf src', 'npm install', 'git add . && git commit --no-verify -m test', 'git commit -am test']) {
      assert.equal((await evaluateTool({ name: 'bash', input: { command }, cwd }, options)).decision, 'block', command);
    }
    assert.equal((await evaluateTool({ name: 'bash', input: { command: 'git commit -m test' }, cwd }, { ...options, siblingCommands: ['git add .'] })).decision, 'block');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('quiet shell syntax retains destructive, package-manager and index-mutation blocks', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mpx-shell-protections-'));
  try {
    await writeFile(join(cwd, 'package.json'), '{"packageManager":"pnpm@11"}');
    const options = { isTrusted: () => false };
    for (const command of [
      'pnpm run check > check.log 2>&1',
      'git status --short > status.log 2>&1',
      'pnpm run check | tail -n 20',
      'rg pattern src | head -n 20',
    ]) {
      assert.deepEqual(await evaluateTool({ name: 'bash', input: { command }, cwd }, options), { decision: 'allow', diagnostics: [] }, command);
    }
    for (const command of [
      'rm -rf src > delete.log 2>&1',
      'git push --force origin main > push.log 2>&1',
      'git clean -fd | tail -n 20',
      'pnpm run check 2>NUL',
      'pnpm run check &>NUL',
      'printf x > /dev/sda',
      'npm install > install.log 2>&1',
      'npm install | tail -n 20',
      'git add . > add.log 2>&1 && git commit -m check > commit.log 2>&1',
      'bash -c "$TASK"',
      'echo $(rm -rf src)',
    ]) {
      assert.equal((await evaluateTool({ name: 'bash', input: { command }, cwd }, options)).decision, 'block', command);
    }
    const unknown = await evaluateTool({ name: 'bash', input: { command: 'cd "$TARGET" && pnpm run check' }, cwd }, options);
    assert.equal(unknown.decision, 'warn');
    assert.match(unknown.diagnostics.join('\n'), /dynamic or unresolved/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('PowerShell tool commands keep automatic constants inspectable and preserve single quotes', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mpx-powershell-'));
  const options = { isTrusted: () => false };
  try {
    for (const command of [
      'Remove-Item -Recurse -Force -Confirm:$false -LiteralPath node_modules/.vite',
      "Remove-Item -Recurse -Force -Confirm:$false -LiteralPath 'dist','coverage'",
      "Write-Output 'it''s fine'",
    ]) {
      assert.equal((await evaluateTool({ name: 'PowerShell', input: { command }, cwd }, options)).decision, 'allow', command);
    }
    for (const command of [
      'Remove-Item -Recurse -Force -Confirm:$false src',
      'Remove-Item -Recurse -Force $env:TARGET',
      "Remove-Item -Recurse -Force 'node_modules','src'",
    ]) {
      assert.equal((await evaluateTool({ name: 'PowerShell', input: { command }, cwd }, options)).decision, 'block', command);
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('PowerShell assignments are values, and a variable resolves only from one literal assignment before its use', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mpx-powershell-'));
  const options = { isTrusted: () => false };
  const evaluate = (command: string) => evaluateTool({ name: 'PowerShell', input: { command }, cwd }, options);
  try {
    for (const command of [
      "$f = 'C:\\x'; Get-Item $f",
      "$f='C:\\x'; Get-Item $f",
      '$p = "$env:TEMP\\x"; Get-Item $p',
      "$root = 'node_modules/.vite'; Remove-Item -Recurse -Force $root",
      "$exe = 'C:\\tools\\tool.exe'; & $exe --version",
      '$head = $(git rev-parse HEAD); Write-Output $head',
      '$os = Get-CimInstance Win32_OperatingSystem',
    ]) {
      assert.equal((await evaluate(command)).decision, 'allow', command);
    }
    for (const [command, reason] of [
      ['& $exe --version', /executable is dynamic.*literal name/],
      ['$exe = Get-Command tool; & $exe', /executable is dynamic/],
      ["$f = 'src'; Remove-Item -Recurse -Force $f", /forced recursive deletion/],
      ["$f = 'node_modules'; $f = 'src'; Remove-Item -Recurse -Force $f", /forced recursive deletion/],
      ["$f = 'node_modules'; Set-Variable f 'src'; Remove-Item -Recurse -Force $f", /forced recursive deletion/],
      ["Remove-Item -Recurse -Force $f; $f = 'node_modules'", /forced recursive deletion/],
      ["if ($c) { $f = 'node_modules' }; Remove-Item -Recurse -Force $f", /forced recursive deletion/],
      ['$x = Remove-Item -Recurse -Force src', /forced recursive deletion/],
      ['$x = $(Remove-Item -Recurse -Force src)', /forced recursive deletion/],
      ['$d = $dir.Delete($true)', /executable is dynamic/],
      ['Write-Output "a`tb"', /backtick.*script file/],
    ] as const) {
      const result = await evaluate(command);
      assert.equal(result.decision, 'block', command);
      assert.match(result.diagnostics.join('\n'), reason, command);
    }
    assert.equal((await evaluateTool({ name: 'Bash', input: { command: "$f = 'C:\\x'; ls $f" }, cwd }, options)).decision, 'block');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('PowerShell automatic variables are values in scriptblocks but never an invoked executable', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mpx-powershell-'));
  const options = { isTrusted: () => false };
  const evaluate = (command: string) => evaluateTool({ name: 'PowerShell', input: { command }, cwd }, options);
  try {
    for (const command of [
      'Get-ChildItem | ForEach-Object { $_.Name }',
      'Get-ChildItem | ForEach-Object { $_ }',
      'Get-ChildItem | Where-Object { $_.Length -gt 0 }',
      'Get-ChildItem | Where-Object { ($_.Length -gt 0) -and ($PSItem.Name -like "*.mp4") }',
      "Get-PSDrive C,D | Select-Object Name,@{n='FreeGB';e={[math]::Round($_.Free/1GB)}}",
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine.Substring(0, [Math]::Min(170, $_.CommandLine.Length)))" }',
      'Get-ChildItem | ForEach-Object { if ($_.Length -gt 330) { $_.Name.Substring(0,330) } else { $_ } }',
      "Invoke-Expression 'Get-ChildItem'",
    ]) {
      assert.equal((await evaluate(command)).decision, 'allow', command);
    }
    for (const [command, reason] of [
      ['Get-ChildItem | ForEach-Object { & $_ }', /executable is dynamic/],
      ['Get-ChildItem *.ps1 | ForEach-Object { . $_ }', /executable is dynamic/],
      ['Get-ChildItem | ForEach-Object { $_.Delete() }', /executable is dynamic/],
      ['Get-ChildItem | ForEach-Object { Invoke-Expression $_ }', /Invoke-Expression/],
      ['Get-Content cmds.txt | ForEach-Object { iex $_ }', /Invoke-Expression/],
      ["Invoke-Expression 'Remove-Item -Recurse -Force src'", /forced recursive deletion/],
      ['Get-ChildItem | ForEach-Object { Remove-Item -Recurse -Force src }', /forced recursive deletion/],
      ['Get-ChildItem | ForEach-Object { $(Remove-Item -Recurse -Force src) }', /forced recursive deletion/],
      ['$target.Delete()', /executable is dynamic/],
    ] as const) {
      const result = await evaluate(command);
      assert.equal(result.decision, 'block', command);
      assert.match(result.diagnostics.join('\n'), reason, command);
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('Claude native event transport preserves policy and nonblocking context fallbacks', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mpx-claude-hooks-'));
  try {
    const blocked = await handleClaudeHook({ hook_event_name: 'PreToolUse', cwd, tool_name: 'Bash', tool_input: { command: 'git clean -f' } });
    assert.equal(JSON.parse(blocked.stdout).hookSpecificOutput.permissionDecision, 'deny');
    const startup = await handleClaudeHook({ hook_event_name: 'SessionStart', source: 'startup', cwd }, resolve('.'), { MPX_PROJECTS: 'C:/fixture' });
    assert.match(startup.stdout, /C:\/fixture/);
    assert.doesNotMatch(startup.stdout, /Key Decisions|compacted/, 'compaction guidance is summarizer input, not session context');
    assert.doesNotMatch(startup.stdout, /# Working principles/, 'shared instructions arrive through the native CLAUDE.md import');
    const afterCompaction = await handleClaudeHook({ hook_event_name: 'SessionStart', source: 'compact', cwd }, resolve('.'), { MPX_PROJECTS: 'C:/fixture' });
    assert.ok(afterCompaction.stdout.startsWith(POST_COMPACTION_RESTART));
    assert.match(afterCompaction.stdout, /C:\/fixture/);
    assert.equal((await handleClaudeHook({ hook_event_name: 'SessionStart', source: 'startup', cwd }, resolve('.'), {})).stdout, '');
    const guidance = await handleClaudeHook({ hook_event_name: 'PreCompact', cwd }, resolve('.'));
    assert.match(guidance.stdout, /Key Decisions/);
    assert.match(guidance.stdout, /Open Questions/);
    assert.ok(guidance.stdout.length <= 10_000, 'Claude caps PreCompact instructions at 10,000 characters');
    const style = await handleClaudeHook({ hook_event_name: 'UserPromptSubmit', cwd });
    assert.match(style.stdout, /concise/);
    const fallback = await handleClaudeHook({ hook_event_name: 'PreCompact', cwd }, cwd);
    assert.equal(fallback.code, 0); assert.equal(fallback.stdout, ''); assert.match(fallback.stderr, /native compaction/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('real staged secrets block commits even with no-verify through the thin policy', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mpx-secret-transport-'));
  try {
    execFileSync('git', ['init', '-q', cwd]);
    await writeFile(join(cwd, 'app.js'), `const token = "${'ghp_' + 'a'.repeat(36)}";\n`);
    execFileSync('git', ['-C', cwd, 'add', 'app.js']);
    for (const command of [
      'git commit --no-verify -m check',
      'git commit --no-verify -m check > commit.log 2>&1',
      'git commit --no-verify -m check | tail -n 20',
    ]) {
      const result = await evaluateTool({ name: 'Bash', input: { command }, cwd }, { isTrusted: () => false });
      assert.equal(result.decision, 'block', command);
      assert.doesNotMatch(result.diagnostics.join('\n'), /ghp_/);
      assert.match(result.diagnostics.join('\n'), /Blocked staged GitHub token/, 'actual staged-secret inspection must still run');
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

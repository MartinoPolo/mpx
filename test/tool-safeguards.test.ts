import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { evaluateTool } from '../src/safeguards/tools.js';
import { handleClaudeHook } from '../src/claude-hooks.js';

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

test('Claude native event transport preserves policy and nonblocking context fallbacks', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mpx-claude-hooks-'));
  try {
    const blocked = await handleClaudeHook({ hook_event_name: 'PreToolUse', cwd, tool_name: 'Bash', tool_input: { command: 'git clean -f' } });
    assert.equal(JSON.parse(blocked.stdout).hookSpecificOutput.permissionDecision, 'deny');
    const roots = await handleClaudeHook({ hook_event_name: 'SessionStart', cwd }, resolve('.'), { MPX_PROJECTS: 'C:/fixture' });
    assert.match(roots.stdout, /C:\/fixture/);
    assert.match(roots.stdout, /Conversation compaction only/);
    assert.match(roots.stdout, /Key Decisions/);
    assert.equal((await handleClaudeHook({ hook_event_name: 'PreCompact', cwd }, resolve('.'))).stdout, '', 'unsupported PreCompact stdout is not instruction delivery');
    const style = await handleClaudeHook({ hook_event_name: 'UserPromptSubmit', cwd });
    assert.match(style.stdout, /concise/);
    const fallback = await handleClaudeHook({ hook_event_name: 'SessionStart', cwd }, cwd);
    assert.equal(fallback.code, 0); assert.match(fallback.stderr, /native compaction/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('real staged secrets block commits even with no-verify through the thin policy', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mpx-secret-transport-'));
  try {
    execFileSync('git', ['init', '-q', cwd]);
    await writeFile(join(cwd, 'app.js'), `const token = "${'ghp_' + 'a'.repeat(36)}";\n`);
    execFileSync('git', ['-C', cwd, 'add', 'app.js']);
    const result = await evaluateTool({ name: 'Bash', input: { command: 'git commit --no-verify -m check' }, cwd }, { isTrusted: () => false });
    assert.equal(result.decision, 'block'); assert.doesNotMatch(result.diagnostics.join('\n'), /ghp_/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

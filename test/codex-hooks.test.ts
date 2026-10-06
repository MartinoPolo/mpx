import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { handleCodexHook, normalizeCodexHook } from '../src/codex-hooks.js';
import { editedPaths } from '../src/safeguards/tools.js';

test('Codex canonical patch input blocks Windows NUL and finds edited paths', async () => {
  const patch = '*** Begin Patch\n*** Add File: nested/NUL\n+hello\n*** End Patch';
  const event = { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: patch } };
  assert.equal(normalizeCodexHook(event).tool_input?.patch, patch);
  const normalized = normalizeCodexHook(event);
  assert.deepEqual(editedPaths({ name: normalized.tool_name!, input: normalized.tool_input!, cwd: process.cwd() }), ['nested/NUL']);
  assert.equal(JSON.parse((await handleCodexHook(event)).stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('Codex unified exec uses its actual working directory and the current shared policy', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mpx-codex-'));
  try {
    await mkdir(join(cwd, '.git'));
    await writeFile(join(cwd, 'package.json'), '{"packageManager":"pnpm@11"}');
    for (const tool_name of ['Bash', 'exec_command', 'shell_command']) {
      for (const command of ['npm install', 'git add . && git commit -m check', 'git clean -fd', 'Remove-Item src -Recurse -Force']) {
        const result = await handleCodexHook({ hook_event_name: 'PreToolUse', cwd: tmpdir(), tool_name, tool_input: { cmd: command, workdir: cwd } });
        assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny', `${tool_name}: ${command}`);
      }
      assert.equal((await handleCodexHook({ hook_event_name: 'PreToolUse', cwd, tool_name, tool_input: { command: 'git status --short' } })).stdout, '');
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('Codex context uses canonical compaction guidance and current response style', async () => {
  const result = await handleCodexHook({ hook_event_name: 'SessionStart' }, resolve('.'), { MPX_PROJECTS: 'C:/fixture' });
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /Key Decisions/);
  assert.match(context, /C:\/fixture/);
  assert.doesNotMatch(context, /draft PR|Tool preference/);
  const style = await handleCodexHook({ hook_event_name: 'UserPromptSubmit' });
  assert.match(style.stdout, /concise/);
});

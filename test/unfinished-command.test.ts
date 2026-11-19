import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handleClaudeHook } from '../src/claude-hooks.js';

const session_id = '3f1c2a9e-7b6d-4e21-9c55-0a8d7e6f4b13';

test('/mpx-unfinished is answered by the prompt hook and toggles the session entry without a model turn', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'mpx-unfinished-'));
  try {
    const transcript_path = join(vault, 'transcript.jsonl');
    await writeFile(transcript_path, '{"type":"ai-title","aiTitle":"Generated title"}\n{"type":"custom-title","customTitle":"Zoom \\"Lucius\\" notes"}\n');
    const env = { MPX_OBSIDIAN_VAULT: vault };
    const prompt = async (text: string) => JSON.parse((await handleClaudeHook({ hook_event_name: 'UserPromptSubmit', session_id, prompt: text, cwd: join(vault, 'project'), transcript_path }, undefined, env, vault)).stdout);
    const list = () => readFile(join(vault, '_Tooling', 'Unfinished sessions.md'), 'utf8');

    assert.equal((await prompt('/mpx-unfinished  waits on the API key')).decision, 'block');
    assert.match(await list(), new RegExp(`^- \\[ \\] #unfinished Zoom "Lucius" notes · waits on the API key · project \\[▶ resume\\]\\(agent-launch:resume/${session_id}\\)`, 'm'));

    await prompt('/mpx-unfinished');
    assert.equal((await list()).match(/^- \[ \] #unfinished/gm)?.length, 1);

    assert.equal((await prompt('/mpx-unfinished done')).reason, 'Ticked off the unfinished list.');
    assert.match(await list(), /^- \[x\] #unfinished Zoom "Lucius" notes · project /m);

    assert.equal((await prompt('/mpx-unfinishedness')).decision, undefined);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test('/mpx-unfinished --project labels the entry with that project and re-parking keeps the label', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'mpx-unfinished-'));
  try {
    const env = { MPX_OBSIDIAN_VAULT: vault };
    const prompt = async (text: string) => JSON.parse((await handleClaudeHook({ hook_event_name: 'UserPromptSubmit', session_id, prompt: text, cwd: join(vault, 'alfred') }, undefined, env, vault)).stdout);
    const list = () => readFile(join(vault, '_Tooling', 'Unfinished sessions.md'), 'utf8');
    const entry = (description: string) => new RegExp(`^- \\[ \\] #unfinished ${description} \\[▶ resume\\]\\(agent-launch:resume/${session_id}\\) ➕ \\d{4}-\\d{2}-\\d{2}$`, 'm');

    await prompt('/mpx-unfinished waits on --project videoLab the render');
    assert.match(await list(), entry('waits on the render · videoLab'));

    await prompt('/mpx-unfinished render is done, upload left');
    assert.match(await list(), entry('render is done, upload left · videoLab'));
    assert.equal((await list()).match(/^- \[ \] #unfinished/gm)?.length, 1);

    await prompt('/mpx-unfinished --project inventory');
    assert.match(await list(), entry('Unnamed session · inventory'));

    assert.equal((await prompt('/mpx-unfinished done')).reason, 'Ticked off the unfinished list.');
    assert.match(await list(), /^- \[x\] #unfinished Unnamed session · inventory /m);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test('/mpx-unfinished refuses a project name that would break the entry format', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'mpx-unfinished-'));
  try {
    const env = { MPX_OBSIDIAN_VAULT: vault };
    for (const project of ['a[b]', 'a·b']) {
      const output = await handleClaudeHook({ hook_event_name: 'UserPromptSubmit', session_id, prompt: `/mpx-unfinished note --project ${project}`, cwd: join(vault, 'alfred') }, undefined, env, vault);
      assert.match(JSON.parse(output.stdout).reason, /^Project names cannot contain/);
    }
    await assert.rejects(readFile(join(vault, '_Tooling', 'Unfinished sessions.md'), 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, mkdtemp, mkdir, readFile, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import type { UserConfig } from '../src/contracts.js';
import { listNativeSessions, planResume, readPiSession, type NativeSession } from '../src/resume.js';

const iso = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
const execFileAsync = promisify(execFile);

function header(id: string, cwd: string, version = 3) {
  return { type: 'session', version, id, timestamp: iso(0), cwd };
}
function entry(type: string, id: string, parentId: string | null, extra: Record<string, unknown> = {}) {
  return { type, id, parentId, timestamp: iso(Number(id.replace(/\D/g, '').slice(-2)) || 1), ...extra };
}
function user(id: string, parentId: string | null, content: unknown) {
  return entry('message', id, parentId, { message: { role: 'user', content, timestamp: Date.parse(iso(1)) } });
}
function assistant(id: string, parentId: string | null, provider: unknown, model: unknown) {
  return entry('message', id, parentId, { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], provider, model, timestamp: Date.parse(iso(2)) } });
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-resume-'));
  const accounts = {
    personal: { pi: path.join(root, 'personal-pi'), claude: path.join(root, 'personal-claude') },
    work: { pi: path.join(root, 'work-pi'), claude: path.join(root, 'work-claude') },
  };
  for (const roots of Object.values(accounts)) for (const accountRoot of Object.values(roots)) await mkdir(accountRoot, { recursive: true });
  await Promise.all(Object.values(accounts).map(roots => mkdir(path.join(roots.claude, 'projects'), { recursive: true })));
  const config: UserConfig = { accounts, domains: { personal: [], work: [] } };
  const writeSession = async (
    account: 'personal' | 'work', name: string, values: unknown[], options: { newline?: boolean; modified?: number } = {},
  ) => {
    const directory = path.join(accounts[account].pi, 'sessions', '--fixture-cwd--');
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${name}.jsonl`);
    const text = values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n') + (options.newline === false ? '' : '\n');
    await writeFile(file, text);
    if (options.modified !== undefined) {
      const date = new Date(Date.UTC(2026, 0, 1, 0, 0, options.modified));
      await utimes(file, date, date);
    }
    return file;
  };
  return { root, accounts, config, writeSession, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('v3 active branch recovers mid-session model and effort while ignoring abandoned branches and trailing entry types', async () => {
  const f = await fixture();
  try {
    const cwd = path.join(f.root, 'project');
    await mkdir(cwd);
    const values = [
      header('session-active', cwd),
      user('u1', null, [{ type: 'text', text: '  Build\u0007 the\nfeature  ' }, { type: 'image', data: 'ignored' }]),
      assistant('a1', 'u1', 'old-provider', 'old-model'),
      entry('model_change', 'ab1', 'a1', { provider: 'abandoned', modelId: 'wrong-model' }),
      entry('thinking_level_change', 'ab2', 'ab1', { thinkingLevel: 'xhigh' }),
      entry('model_change', 'mc1', 'a1', { provider: 'openai-codex', modelId: 'gpt-5.6-sol' }),
      entry('thinking_level_change', 'tc1', 'mc1', { thinkingLevel: 'low' }),
      entry('custom', 'c1', 'tc1', { customType: 'fixture', data: { retained: true } }),
      entry('compaction', 'cp1', 'c1', { summary: 'summary', firstKeptEntryId: 'u1', tokensBefore: 100 }),
      entry('future_metadata_v9', 'f1', 'cp1', { arbitrary: { nested: true } }),
    ];
    const file = await f.writeSession('work', 'active', values, { newline: false });
    const before = await readFile(file);
    const result = await readPiSession(file, 'work', f.accounts.work.pi);
    assert.equal(result.session.id, 'session-active');
    assert.equal(result.session.cwd, cwd);
    assert.equal(result.session.provider, 'openai-codex');
    assert.equal(result.session.model, 'gpt-5.6-sol');
    assert.equal(result.session.thinking, 'low');
    assert.equal(result.session.title, 'Build the feature');
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(await readFile(file), before, 'inspection must not append a newline or rewrite content');
  } finally { await f.cleanup(); }
});

test('large inactive payloads are projected away while active structured restore metadata remains exact', async () => {
  const f = await fixture();
  try {
    const cwd = path.join(f.root, 'large-project');
    await mkdir(cwd);
    const directory = path.join(f.accounts.personal.pi, 'sessions', '--fixture-cwd--');
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, 'large-inactive.jsonl');
    await writeFile(file, `${JSON.stringify(header('large-inactive', cwd))}\n${JSON.stringify(user('u1', null, 'Large session title'))}\n`);
    const payload = 'x'.repeat(4 * 1024 * 1024);
    let inactiveParent = 'u1';
    for (let index = 0; index < 18; index += 1) {
      const id = `inactive-${index}`;
      const extra = index % 3 === 0
        ? { toolResult: { content: payload, images: [{ data: payload }] } }
        : index % 3 === 1 ? { data: { custom: payload } } : { summary: payload };
      await appendFile(file, `${JSON.stringify(entry(index % 3 === 2 ? 'compaction' : 'custom', id, inactiveParent, extra))}\n`);
      inactiveParent = id;
    }
    await appendFile(file, `${JSON.stringify(entry('model_change', 'active-model', 'u1', {
      provider: 'openai-codex', modelId: 'gpt-5.6-sol', ignored: payload,
    }))}\n`);
    await appendFile(file, `${JSON.stringify(entry('thinking_level_change', 'active-thinking', 'active-model', {
      thinkingLevel: 'xhigh', ignored: payload,
    }))}\n`);

    const moduleUrl = pathToFileURL(path.resolve('src/resume.ts')).href;
    const childCode = `
      import { readPiSession } from ${JSON.stringify(moduleUrl)};
      const result = await readPiSession(${JSON.stringify(file)}, 'personal', ${JSON.stringify(f.accounts.personal.pi)});
      process.stdout.write(JSON.stringify({
        title: result.session.title,
        provider: result.session.provider,
        model: result.session.model,
        thinking: result.session.thinking,
      }));
    `;
    const { stdout } = await execFileAsync(process.execPath, [
      '--max-old-space-size=64', '--import', 'tsx', '--input-type=module', '--eval', childCode,
    ], { cwd: path.resolve('.'), timeout: 30_000, maxBuffer: 1024 * 1024 });
    assert.deepEqual(JSON.parse(stdout), {
      title: 'Large session title', provider: 'openai-codex', model: 'gpt-5.6-sol', thinking: 'xhigh',
    });
  } finally { await f.cleanup(); }
});

test('bounded user-title prefixes do not retain large abandoned user messages', async () => {
  const f = await fixture();
  try {
    const cwd = path.join(f.root, 'project');
    await mkdir(cwd);
    const file = await f.writeSession('personal', 'large-users', [header('large-users', cwd), user('first', null, 'Kept title')]);
    for (let index = 0; index < 20; index++) {
      await appendFile(file, `${JSON.stringify(user(`large-${index}`, 'first', 'x'.repeat(4 * 1024 * 1024)))}\n`);
    }
    await appendFile(file, `${JSON.stringify(assistant('last', 'first', 'p', 'm'))}\n`);
    const code = `import {readPiSession} from ${JSON.stringify(pathToFileURL(path.resolve('src/resume.ts')).href)}; const r=await readPiSession(${JSON.stringify(file)},'personal',${JSON.stringify(f.accounts.personal.pi)}); console.log(r.session.title);`;
    const { stdout } = await execFileAsync(process.execPath, ['--max-old-space-size=64', '--import', 'tsx', '--input-type=module', '--eval', code], { timeout: 30_000, maxBuffer: 64 * 1024 });
    assert.equal(stdout.trim(), 'Kept title');
  } finally { await f.cleanup(); }
});

test('later active assistant metadata supersedes an earlier model change exactly as native branch context does', async () => {
  const f = await fixture();
  try {
    const cwd = path.join(f.root, 'project');
    await mkdir(cwd);
    const file = await f.writeSession('personal', 'assistant-latest', [
      header('assistant-latest', cwd), user('u1', null, 'hello'),
      entry('model_change', 'm1', 'u1', { provider: 'declared', modelId: 'declared-model' }),
      assistant('a1', 'm1', 'observed', 'observed-model'),
      entry('thinking_level_change', 't1', 'a1', { thinkingLevel: 'medium' }),
    ]);
    const { session } = await readPiSession(file, 'personal', f.accounts.personal.pi);
    assert.deepEqual({ provider: session.provider, model: session.model, thinking: session.thinking }, {
      provider: 'observed', model: 'observed-model', thinking: 'medium',
    });
  } finally { await f.cleanup(); }
});

test('missing and invalid restore metadata stays unknown with warnings rather than native off or title inference', async () => {
  const f = await fixture();
  try {
    const cwd = path.join(f.root, 'older');
    await mkdir(cwd);
    const missing = await f.writeSession('personal', 'missing', [header('missing-fields', cwd), user('u1', null, 'Use model gpt-secret at high')]);
    const invalid = await f.writeSession('work', 'invalid-metadata', [
      header('invalid-fields', cwd), user('u1', null, 'title'), assistant('a1', 'u1', 'provider', 'model'),
      entry('model_change', 'm1', 'a1', { provider: 7, modelId: null }),
      entry('thinking_level_change', 't1', 'm1', { thinkingLevel: 'future-ultra' }),
    ]);
    const old = await readPiSession(missing, 'personal', f.accounts.personal.pi);
    assert.equal(old.session.provider, undefined);
    assert.equal(old.session.model, undefined);
    assert.equal(old.session.thinking, undefined);
    assert.match(old.warnings.join('\n'), /provider is unknown/);
    assert.match(old.warnings.join('\n'), /implicit off default is not recovered state/);
    const bad = await readPiSession(invalid, 'work', f.accounts.work.pi);
    assert.equal(bad.session.provider, undefined);
    assert.equal(bad.session.model, undefined);
    assert.equal(bad.session.thinking, undefined);
    assert.match(bad.warnings.join('\n'), /model_change metadata is invalid/);
    assert.match(bad.warnings.join('\n'), /unsupported thinking level/);
  } finally { await f.cleanup(); }
});

test('invalid UTF-8 is rejected without rejecting a legitimate replacement character', async () => {
  const f = await fixture();
  try {
    const cwd = path.join(f.root, 'project-\uFFFD');
    await mkdir(cwd);
    const literal = await f.writeSession('personal', 'literal-replacement', [
      header('session-\uFFFD', cwd), user('u1', null, 'literal \uFFFD title'),
      entry('model_change', 'm1', 'u1', { provider: 'provider-\uFFFD', modelId: 'model-\uFFFD' }),
      entry('thinking_level_change', 't1', 'm1', { thinkingLevel: 'high' }),
    ]);
    const accepted = await readPiSession(literal, 'personal', f.accounts.personal.pi);
    assert.equal(accepted.session.id, 'session-\uFFFD');
    assert.equal(accepted.session.model, 'model-\uFFFD');
    assert.equal(accepted.session.title, 'literal \uFFFD title');

    const invalid = await f.writeSession('personal', 'invalid-utf8', [header('invalid-utf8', cwd)]);
    await appendFile(invalid, Buffer.concat([
      Buffer.from('{"type":"message","id":"u1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"'),
      Buffer.from([0xff]),
      Buffer.from('"}}\n'),
    ]));
    await assert.rejects(readPiSession(invalid, 'personal', f.accounts.personal.pi), /invalid UTF-8/);
  } finally { await f.cleanup(); }
});

test('duplicate ids, cycles, missing parents, corrupt/truncated JSON, and legacy versions produce direct diagnostics', async () => {
  const f = await fixture();
  try {
    const cwd = path.join(f.root, 'project');
    await mkdir(cwd);
    const cases: Array<[string, unknown[], RegExp]> = [
      ['duplicate', [header('dup', cwd), user('same', null, 'one'), user('same', null, 'two')], /duplicate entry id same/],
      ['cycle', [header('cycle', cwd), user('one', 'two', 'one'), user('two', 'one', 'two')], /parent cycle/],
      ['missing-parent', [header('missing-parent', cwd), user('one', 'absent', 'one')], /missing parent absent/],
      ['corrupt', [header('corrupt', cwd), '{"type":"message"'], /malformed JSON on line 2/],
      ['legacy', [header('legacy', cwd, 2), user('one', null, 'one')], /unsupported session version 2/],
    ];
    for (const [name, values, pattern] of cases) {
      const file = await f.writeSession('personal', name, values, { newline: false });
      await assert.rejects(readPiSession(file, 'personal', f.accounts.personal.pi), pattern);
    }
    const listed = await listNativeSessions(f.config, cwd);
    assert.equal(listed.sessions.length, 0);
    for (const [, , pattern] of cases) assert.match(listed.warnings.join('\n'), pattern);
  } finally { await f.cleanup(); }
});

test('oversized entry metadata and entry counts reject the individual transcript with explicit listing warnings', async () => {
  const f = await fixture();
  try {
    const cwd = path.join(f.root, 'bounded-project');
    await mkdir(cwd);
    const oversized = await f.writeSession('personal', 'oversized-id', [
      header('oversized-id', cwd), user('x'.repeat(513), null, 'title'),
    ]);
    await assert.rejects(readPiSession(oversized, 'personal', f.accounts.personal.pi), /id exceeds the 512-character inspection limit/);

    const directory = path.join(f.accounts.work.pi, 'sessions', '--fixture-cwd--');
    await mkdir(directory, { recursive: true });
    const tooMany = path.join(directory, 'too-many.jsonl');
    await writeFile(tooMany, `${JSON.stringify(header('too-many', cwd))}\n`);
    let chunk = '';
    for (let index = 0; index <= 50_000; index += 1) {
      chunk += `${JSON.stringify({
        type: 'custom', id: `e${index}`, parentId: index === 0 ? null : `e${index - 1}`, timestamp: iso(1),
      })}\n`;
      if (chunk.length >= 1024 * 1024) {
        await appendFile(tooMany, chunk);
        chunk = '';
      }
    }
    if (chunk !== '') await appendFile(tooMany, chunk);
    await assert.rejects(readPiSession(tooMany, 'work', f.accounts.work.pi), /entry count exceeds the 50000-entry inspection limit/);

    const listed = await listNativeSessions(f.config, cwd);
    assert.equal(listed.sessions.length, 0);
    assert.match(listed.warnings.join('\n'), /id exceeds the 512-character inspection limit/);
    assert.match(listed.warnings.join('\n'), /entry count exceeds the 50000-entry inspection limit/);
  } finally { await f.cleanup(); }
});

test('combined listing has current-project priority, keeps every same-cwd session, and sorts both accounts by mtime', async () => {
  const f = await fixture();
  try {
    const current = path.join(f.root, 'Current Project');
    const other = path.join(f.root, 'Other Project');
    await Promise.all([mkdir(current), mkdir(other)]);
    const complete = (id: string, cwd: string) => [
      header(id, cwd), user(`${id}u`, null, id), assistant(`${id}a`, `${id}u`, 'provider', 'model'),
      entry('thinking_level_change', `${id}t`, `${id}a`, { thinkingLevel: 'off' }),
    ];
    await f.writeSession('work', 'other-newest', complete('other', other), { modified: 50 });
    await f.writeSession('personal', 'current-old', complete('current-old', current), { modified: 10 });
    await f.writeSession('work', 'current-new', complete('current-new', current), { modified: 20 });
    await f.writeSession('personal', 'other-old', complete('other-old', other), { modified: 5 });

    const { sessions, warnings } = await listNativeSessions(f.config, current.toUpperCase());
    assert.deepEqual(sessions.map(session => session.id), ['current-new', 'current-old', 'other', 'other-old']);
    assert.deepEqual(sessions.map(session => session.account), ['work', 'personal', 'work', 'personal']);
    assert.equal(sessions.filter(session => session.cwd === current).length, 2);
    assert.deepEqual(warnings, []);
    await assert.rejects(stat(path.join(f.accounts.personal.claude, 'sessions')), { code: 'ENOENT' });
    await assert.rejects(stat(path.join(f.accounts.work.claude, 'sessions')), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('Windows header paths are authoritative and compared case-insensitively for project priority', async () => {
  const f = await fixture();
  try {
    const windowsCwd = 'C:\\Work Trees\\Repo';
    const other = 'C:\\Elsewhere';
    const make = (id: string, cwd: string) => [
      header(id, cwd), user(`${id}u`, null, id), assistant(`${id}a`, `${id}u`, 'p', 'm'),
      entry('thinking_level_change', `${id}t`, `${id}a`, { thinkingLevel: 'high' }),
    ];
    await f.writeSession('personal', 'windows-current', make('windows-current', windowsCwd), { modified: 1 });
    await f.writeSession('work', 'windows-newer', make('windows-newer', other), { modified: 30 });
    const { sessions } = await listNativeSessions(f.config, 'c:\\work trees\\repo\\');
    assert.deepEqual(sessions.map(session => session.id), ['windows-current', 'windows-newer']);
    assert.equal(sessions[0]?.cwd, windowsCwd);
  } finally { await f.cleanup(); }
});

test('resume planning emits only native session plus explicit override flags and labels', async () => {
  const f = await fixture();
  try {
    const cwd = path.join(f.root, 'project');
    await mkdir(cwd);
    const completeFile = await f.writeSession('work', 'complete', [
      header('complete', cwd), user('u1', null, 'hello'), assistant('a1', 'u1', 'recovered-provider', 'recovered-model'),
      entry('thinking_level_change', 't1', 'a1', { thinkingLevel: 'low' }),
    ]);
    const { session: complete } = await readPiSession(completeFile, 'work', f.accounts.work.pi);
    const recovered = await planResume(complete);
    assert.deepEqual(recovered.args, ['--session', complete.file]);
    assert.equal(recovered.cwd, cwd);
    assert.deepEqual(recovered.overrideLabels, []);
    assert.equal(recovered.fields.model.provenance, 'recovered');

    const missingFile = await f.writeSession('personal', 'old', [header('old', cwd), user('old-u', null, 'old')]);
    const { session: missing } = await readPiSession(missingFile, 'personal', f.accounts.personal.pi);
    await assert.rejects(planResume(missing), /explicit provider override is required/);
    await assert.rejects(
      planResume(missing, { provider: 'p', model: 'm', thinking: 'future-ultra' as never }),
      /thinking override must be one of/,
    );
    const overridden = await planResume(missing, { provider: 'p', model: 'm', thinking: 'medium' });
    assert.deepEqual(overridden.args, ['--session', missing.file, '--provider', 'p', '--model', 'm', '--thinking', 'medium']);
    assert.deepEqual(overridden.overrideLabels, ['provider=p (override)', 'model=m (override)', 'thinking=medium (override)']);
    assert.deepEqual(Object.values(overridden.fields).map(field => field.provenance), ['override', 'override', 'override']);
  } finally { await f.cleanup(); }
});

test('planning fails for missing transcript/cwd and unsupported Claude without creating resources', async () => {
  const f = await fixture();
  try {
    const cwd = path.join(f.root, 'project');
    await mkdir(cwd);
    const file = await f.writeSession('personal', 'gone', [header('gone', cwd), user('u1', null, 'hello')]);
    const { session } = await readPiSession(file, 'personal', f.accounts.personal.pi);
    await unlink(file);
    await assert.rejects(planResume(session, { provider: 'p', model: 'm', thinking: 'off' }), /resource is unavailable/);
    await assert.rejects(readPiSession(path.join(f.root, 'outside.jsonl'), 'personal', f.accounts.personal.pi), /outside the configured transcript store/);

    const absentCwd = path.join(f.root, 'moved-worktree');
    const movedFile = await f.writeSession('personal', 'moved', [header('moved', absentCwd), user('moved-u', null, 'hello')]);
    const { session: moved } = await readPiSession(movedFile, 'personal', f.accounts.personal.pi);
    await assert.rejects(planResume(moved, { provider: 'p', model: 'm', thinking: 'off' }), /Resume cwd is unavailable/);

    const claude = { ...session, harness: 'claude', file, accountRoot: f.accounts.personal.claude } as NativeSession;
    await assert.rejects(planResume(claude, { model: 'm', thinking: 'low' }), /outside the configured transcript store/);
    await assert.rejects(stat(path.join(f.accounts.personal.claude, 'sessions')), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('symlinked transcript escape is rejected when the platform permits creating it', async (t) => {
  const f = await fixture();
  try {
    const cwd = path.join(f.root, 'project');
    await mkdir(cwd);
    const directory = path.join(f.accounts.personal.pi, 'sessions', '--fixture-cwd--');
    await mkdir(directory, { recursive: true });
    const outside = path.join(f.root, 'outside.jsonl');
    await writeFile(outside, JSON.stringify(header('outside', cwd)));
    const link = path.join(directory, 'link.jsonl');
    try {
      await symlink(outside, link, 'file');
    } catch (error) {
      t.skip(`file symlinks unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    await assert.rejects(readPiSession(link, 'personal', f.accounts.personal.pi), /not a physical file/);
    const listed = await listNativeSessions(f.config, cwd);
    assert.equal(listed.sessions.length, 0);
    assert.match(listed.warnings.join('\n'), /not a physical file/);
  } finally { await f.cleanup(); }
});

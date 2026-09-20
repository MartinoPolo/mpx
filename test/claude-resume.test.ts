import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { UserConfig } from '../src/contracts.js';
import { listNativeSessions, planResume, readClaudeSession } from '../src/resume.js';

const iso = (seconds: number) => new Date(Date.UTC(2026, 1, 1, 0, 0, seconds)).toISOString();

function claudeEntry(type: 'user' | 'assistant', uuid: string, parentUuid: string | null, sessionId: string, cwd: string, options: {
  text?: string; model?: unknown; isSidechain?: boolean; extra?: Record<string, unknown>;
} = {}) {
  return {
    parentUuid, isSidechain: options.isSidechain ?? false, userType: 'external', cwd, sessionId,
    version: '2.1.236', type, uuid, timestamp: iso(Number(uuid.replace(/\D/g, '')) || 1),
    message: type === 'user'
      ? { role: 'user', content: options.text ?? 'user text' }
      : { role: 'assistant', model: options.model, content: [{ type: 'text', text: options.text ?? 'done' }] },
    ...options.extra,
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-claude-resume-'));
  const accounts = {
    personal: { pi: path.join(root, 'personal-pi'), claude: path.join(root, 'personal-claude') },
    work: { pi: path.join(root, 'work-pi'), claude: path.join(root, 'work-claude') },
  };
  for (const roots of Object.values(accounts)) {
    await Promise.all([
      mkdir(path.join(roots.pi, 'sessions'), { recursive: true }),
      mkdir(path.join(roots.claude, 'projects'), { recursive: true }),
    ]);
  }
  const config: UserConfig = { accounts, domains: { personal: [], work: [] } };
  const writeClaude = async (account: 'personal' | 'work', project: string, id: string, values: unknown[], modified = 1) => {
    const directory = path.join(accounts[account].claude, 'projects', project);
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${id}.jsonl`);
    await writeFile(file, `${values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n')}\n`);
    const date = new Date(Date.UTC(2026, 1, 1, 0, 0, modified));
    await utimes(file, date, date);
    return file;
  };
  return { root, accounts, config, writeClaude, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('Claude reader follows the active branch, recovers model, and keeps effort unknown without content inference', async () => {
  const f = await fixture();
  try {
    const cwd = path.join(f.root, 'Current Project');
    await mkdir(cwd);
    const id = '11111111-2222-4333-8444-555555555555';
    const values = [
      { type: 'atis-latch', sessionId: id },
      { type: 'queue-operation', sessionId: id },
      claudeEntry('user', 'u1', null, id, cwd, { text: '  Resume\u0007 this\nfeature with high effort  ', extra: { effort: 'high' } }),
      claudeEntry('assistant', 'a1', 'u1', id, cwd, { model: 'claude-sonnet-old' }),
      claudeEntry('assistant', 'abandoned2', 'a1', id, cwd, { model: 'claude-wrong-abandoned' }),
      claudeEntry('assistant', 'active3', 'a1', id, cwd, { model: 'claude-opus-exact', extra: { effort: 'low' } }),
      claudeEntry('user', 'active4', 'active3', id, cwd, { text: 'continue' }),
      claudeEntry('assistant', 'side5', 'active4', id, cwd, { model: 'claude-sidechain', isSidechain: true }),
      { type: 'summary', summary: 'Use model fake at max effort', leafUuid: 'active4', sessionId: id, cwd, timestamp: iso(9) },
    ];
    const file = await f.writeClaude('work', '--encoded-project--', id, values);
    const before = await readFile(file);
    const result = await readClaudeSession(file, 'work', f.accounts.work.claude);
    assert.equal(result.session.harness, 'claude');
    assert.equal(result.session.account, 'work');
    assert.equal(result.session.id, id);
    assert.equal(result.session.cwd, cwd);
    assert.equal(result.session.title, 'Resume this feature with high effort');
    assert.equal(result.session.model, 'claude-opus-exact');
    assert.equal(result.session.provider, undefined);
    assert.equal(result.session.thinking, undefined);
    assert.match(result.warnings.join('\n'), /effort is not known persisted/);
    assert.deepEqual(await readFile(file), before);

    await assert.rejects(planResume(result.session), /explicit effort override is required/);
    await assert.rejects(planResume(result.session, { provider: 'anthropic', thinking: 'low' }), /does not accept a provider override/);
    const plan = await planResume(result.session, { thinking: 'low' });
    assert.deepEqual(plan.args, ['--resume', id, '--model', 'claude-opus-exact', '--effort', 'low']);
    assert.equal(plan.fields.model.provenance, 'recovered');
    assert.equal(plan.fields.thinking.provenance, 'override');
    assert.deepEqual(plan.overrideLabels, ['effort=low (override)']);
  } finally { await f.cleanup(); }
});

test('Claude unknown model also requires an explicit labeled override and never derives it from title or payload', async () => {
  const f = await fixture();
  try {
    const cwd = path.join(f.root, 'project');
    await mkdir(cwd);
    const id = 'unknown-model-session';
    const file = await f.writeClaude('personal', '--project--', id, [
      claudeEntry('user', 'u1', null, id, cwd, { text: 'Use claude-title-model with medium effort', extra: { model: 'fake-top-level', effort: 'medium' } }),
    ]);
    const { session, warnings } = await readClaudeSession(file, 'personal', f.accounts.personal.claude);
    assert.equal(session.model, undefined);
    assert.match(warnings.join('\n'), /model is unknown/);
    await assert.rejects(planResume(session, { thinking: 'medium' }), /explicit model override/);
    const plan = await planResume(session, { model: 'claude-selected', thinking: 'medium' });
    assert.deepEqual(plan.args, ['--resume', id, '--model', 'claude-selected', '--effort', 'medium']);
    assert.deepEqual(plan.overrideLabels, ['model=claude-selected (override)', 'effort=medium (override)']);
  } finally { await f.cleanup(); }
});

test('combined listing includes both native harnesses and accounts with current-project priority', async () => {
  const f = await fixture();
  try {
    const current = path.join(f.root, 'current');
    const other = path.join(f.root, 'other');
    await Promise.all([mkdir(current), mkdir(other)]);
    const claudeId = 'claude-current';
    await f.writeClaude('work', '--current--', claudeId, [
      claudeEntry('user', 'cu1', null, claudeId, current, { text: 'Claude current' }),
      claudeEntry('assistant', 'ca2', 'cu1', claudeId, current, { model: 'claude-exact' }),
    ], 5);
    const piDirectory = path.join(f.accounts.personal.pi, 'sessions', '--other--');
    await mkdir(piDirectory, { recursive: true });
    const piFile = path.join(piDirectory, 'pi-other.jsonl');
    await writeFile(piFile, [
      { type: 'session', version: 3, id: 'pi-other', timestamp: iso(0), cwd: other },
      { type: 'message', id: 'pu1', parentId: null, timestamp: iso(1), message: { role: 'user', content: 'Pi other' } },
      { type: 'message', id: 'pa2', parentId: 'pu1', timestamp: iso(2), message: { role: 'assistant', provider: 'p', model: 'm' } },
      { type: 'thinking_level_change', id: 'pt3', parentId: 'pa2', timestamp: iso(3), thinkingLevel: 'low' },
    ].map(value => JSON.stringify(value)).join('\n'));
    await utimes(piFile, new Date(Date.UTC(2026, 1, 1, 0, 0, 50)), new Date(Date.UTC(2026, 1, 1, 0, 0, 50)));

    const result = await listNativeSessions(f.config, current.toUpperCase());
    assert.deepEqual(result.sessions.map(session => [session.id, session.harness, session.account]), [
      [claudeId, 'claude', 'work'], ['pi-other', 'pi', 'personal'],
    ]);
    assert.match(result.warnings.join('\n'), /Claude effort is not known persisted/);
  } finally { await f.cleanup(); }
});

test('Claude malformed identity, cwd, branch, JSON, UTF-8, and unavailable resources fail directly', async () => {
  const f = await fixture();
  try {
    const cwd = path.join(f.root, 'project');
    const other = path.join(f.root, 'other');
    await Promise.all([mkdir(cwd), mkdir(other)]);
    const cases: Array<[string, unknown[], RegExp]> = [
      ['filename-id', [claudeEntry('user', 'u1', null, 'different-id', cwd)], /filename does not match sessionId/],
      ['cwd-change', [claudeEntry('user', 'u1', null, 'cwd-change', cwd), claudeEntry('assistant', 'a2', 'u1', 'cwd-change', other, { model: 'm' })], /changes cwd/],
      ['missing-parent', [claudeEntry('assistant', 'a1', 'absent', 'missing-parent', cwd, { model: 'm' })], /missing parent/],
      ['bad-json', ['{"type":"user"'], /malformed JSON/],
    ];
    for (const [name, values, pattern] of cases) {
      const file = await f.writeClaude('personal', `--${name}--`, name, values);
      await assert.rejects(readClaudeSession(file, 'personal', f.accounts.personal.claude), pattern);
    }
    const invalidUtf8 = await f.writeClaude('personal', '--utf8--', 'utf8', [claudeEntry('user', 'u1', null, 'utf8', cwd)]);
    await appendFile(invalidUtf8, Buffer.from([0xff, 0x0a]));
    await assert.rejects(readClaudeSession(invalidUtf8, 'personal', f.accounts.personal.claude), /invalid UTF-8/);
    await assert.rejects(readClaudeSession(path.join(f.root, 'outside.jsonl'), 'personal', f.accounts.personal.claude), /outside the configured transcript store/);
    await assert.rejects(readClaudeSession(path.join(f.accounts.personal.claude, 'projects', '--gone--', 'gone.jsonl'), 'personal', f.accounts.personal.claude), /resource is unavailable/);
  } finally { await f.cleanup(); }
});

test('Claude transcript symlink escape is rejected when file symlinks are available', async (t) => {
  const f = await fixture();
  try {
    const cwd = path.join(f.root, 'project');
    await mkdir(cwd);
    const outside = path.join(f.root, 'linked.jsonl');
    await writeFile(outside, JSON.stringify(claudeEntry('user', 'u1', null, 'linked', cwd)));
    const directory = path.join(f.accounts.personal.claude, 'projects', '--link--');
    await mkdir(directory);
    const link = path.join(directory, 'linked.jsonl');
    try { await symlink(outside, link, 'file'); }
    catch (error) { t.skip(`file symlinks unavailable: ${error instanceof Error ? error.message : String(error)}`); return; }
    await assert.rejects(readClaudeSession(link, 'personal', f.accounts.personal.claude), /not a physical file/);
  } finally { await f.cleanup(); }
});

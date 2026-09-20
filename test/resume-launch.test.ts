import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { UserConfig } from '../src/contracts.js';
import { prepareResumeLaunch } from '../src/resume-launch.js';
import { readClaudeSession, readPiSession } from '../src/resume.js';

const iso = (seconds: number) => new Date(Date.UTC(2026, 2, 1, 0, 0, seconds)).toISOString();

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-resume-launch-'));
  const accounts = {
    personal: { pi: path.join(root, 'personal-pi'), claude: path.join(root, 'personal-claude') },
    work: { pi: path.join(root, 'work-pi'), claude: path.join(root, 'work-claude') },
  };
  for (const roots of Object.values(accounts)) {
    await Promise.all([
      mkdir(path.join(roots.pi, 'sessions', '--project--'), { recursive: true }),
      mkdir(path.join(roots.claude, 'projects', '--project--'), { recursive: true }),
    ]);
  }
  const cwd = path.join(root, 'project');
  await mkdir(cwd);
  const rpc = path.join(root, 'rpc-fixture.mjs');
  await writeFile(rpc, `
import { readFile } from 'node:fs/promises';
const args=process.argv.slice(2), at=(f)=>{const i=args.indexOf(f); return i<0?undefined:args[i+1]};
if(args.includes('--session')||!args.includes('--no-session')) throw new Error('preflight must not open a session');
const file=process.env.PREFLIGHT_SESSION_FILE, lines=(await readFile(file,'utf8')).trim().split(/\\r?\\n/).map(JSON.parse);
const header=lines[0]; let provider,model,thinking;
for(const entry of lines.slice(1)){if(entry.type==='model_change'){provider=entry.provider;model=entry.modelId} if(entry.type==='message'&&entry.message?.role==='assistant'){provider=entry.message.provider;model=entry.message.model} if(entry.type==='thinking_level_change')thinking=entry.thinkingLevel;}
provider=at('--provider')??provider; model=at('--model')??model; thinking=at('--thinking')??thinking;
if(process.env.PREFLIGHT_WRONG==='model') model='silently-substituted'; if(process.env.PREFLIGHT_WRONG==='effort') thinking='low';
let pending=''; process.stdin.on('data',c=>{pending+=c; let n; while((n=pending.indexOf('\\n'))>=0){const line=pending.slice(0,n); pending=pending.slice(n+1); if(!line)continue; const q=JSON.parse(line); const data=q.type==='get_state'?{sessionId:header.id,sessionFile:file,model:{provider,id:model},thinkingLevel:thinking}:q.type==='get_available_models'?{models:process.env.PREFLIGHT_WRONG==='unavailable'?[]:[{provider,id:model}]}:{levels:['off','low','medium','high']}; process.stdout.write(JSON.stringify({id:q.id,type:'response',command:q.type,success:true,data})+'\\n');}});
`);
  const shim = path.join(root, 'native pi shim');
  await writeFile(shim, '#!/usr/bin/env bash\nexec node "$PREFLIGHT_FIXTURE" "$@"\n');
  await chmod(shim, 0o755);
  const config: UserConfig = {
    accounts, domains: { personal: [], work: [] }, executables: { pi: shim, claude: shim },
  };
  const piFile = path.join(accounts.personal.pi, 'sessions', '--project--', 'pi-session.jsonl');
  await writeFile(piFile, [
    { type: 'session', version: 3, id: 'pi-session', timestamp: iso(0), cwd },
    { type: 'message', id: 'u1', parentId: null, timestamp: iso(1), message: { role: 'user', content: 'resume' } },
    { type: 'message', id: 'a2', parentId: 'u1', timestamp: iso(2), message: { role: 'assistant', provider: 'fixture-provider', model: 'fixture-model' } },
    { type: 'thinking_level_change', id: 't3', parentId: 'a2', timestamp: iso(3), thinkingLevel: 'medium' },
  ].map(value => JSON.stringify(value)).join('\n'));
  const date = new Date(Date.UTC(2026, 2, 1));
  await utimes(piFile, date, date);
  return { root, accounts, config, cwd, rpc, piFile, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('managed Pi resume preparation uses config/selection/launch and verifies exact native RPC startup state read-only', async () => {
  const f = await fixture();
  try {
    const read = await readPiSession(f.piFile, 'personal', f.accounts.personal.pi);
    const before = await readFile(f.piFile);
    const prepared = await prepareResumeLaunch({
      root: f.root, session: read.session, config: f.config,
      env: { ...process.env, PREFLIGHT_FIXTURE: f.rpc, PREFLIGHT_SESSION_FILE: f.piFile, PI_MODEL: 'stale-parent', PI_REASONING_LEVEL: 'high' },
    });
    assert.equal(prepared.verification.verified, true);
    assert.equal(prepared.verification.method, 'pi-rpc-read-only-preflight');
    assert.deepEqual(prepared.verification.observed, {
      provider: 'fixture-provider', model: 'fixture-model', thinking: 'medium',
      availableThinking: ['off', 'low', 'medium', 'high'],
    });
    assert.deepEqual(prepared.spec.args.slice(-2), ['--session', f.piFile]);
    assert.equal(prepared.spec.cwd, f.cwd);
    assert.equal(prepared.spec.env.PI_CODING_AGENT_DIR, f.accounts.personal.pi);
    assert.equal(prepared.spec.env.PI_MODEL, undefined);
    assert.deepEqual(await readFile(f.piFile), before);
  } finally { await f.cleanup(); }
});

test('Pi preparation fails closed on unavailable models, substitution, or effort clamping', async () => {
  const f = await fixture();
  try {
    const { session } = await readPiSession(f.piFile, 'personal', f.accounts.personal.pi);
    await assert.rejects(prepareResumeLaunch({
      root: f.root, session, config: f.config,
      env: { ...process.env, PREFLIGHT_FIXTURE: f.rpc, PREFLIGHT_SESSION_FILE: f.piFile, PREFLIGHT_WRONG: 'model' },
    }), /refused silent fallback\/clamping.*silently-substituted/);
    await assert.rejects(prepareResumeLaunch({
      root: f.root, session, config: f.config,
      env: { ...process.env, PREFLIGHT_FIXTURE: f.rpc, PREFLIGHT_SESSION_FILE: f.piFile, PREFLIGHT_WRONG: 'unavailable' },
    }), /not in the native available-model set/);
    await assert.rejects(prepareResumeLaunch({
      root: f.root, session, config: f.config,
      env: { ...process.env, PREFLIGHT_FIXTURE: f.rpc, PREFLIGHT_SESSION_FILE: f.piFile, PREFLIGHT_WRONG: 'effort' },
    }), /refused silent fallback\/clamping.*effort low/);
  } finally { await f.cleanup(); }
});

test('configured account root must exactly match selected transcript account before preflight', async () => {
  const f = await fixture();
  try {
    const { session } = await readPiSession(f.piFile, 'personal', f.accounts.personal.pi);
    const mismatched: UserConfig = {
      ...f.config,
      accounts: { ...f.config.accounts, personal: { ...f.config.accounts.personal, pi: f.accounts.work.pi } },
    };
    await assert.rejects(prepareResumeLaunch({
      root: f.root, session, config: mismatched, env: { ...process.env, PREFLIGHT_FIXTURE: f.rpc },
    }), /Resume account mismatch/);
  } finally { await f.cleanup(); }
});

test('Claude preparation uses explicit native ID/model/effort but reports startup verification unsupported', async () => {
  const f = await fixture();
  try {
    const id = 'claude-session';
    const file = path.join(f.accounts.work.claude, 'projects', '--project--', `${id}.jsonl`);
    await writeFile(file, [
      { type: 'user', uuid: 'u1', parentUuid: null, sessionId: id, cwd: f.cwd, timestamp: iso(1), message: { role: 'user', content: 'resume' } },
      { type: 'assistant', uuid: 'a2', parentUuid: 'u1', sessionId: id, cwd: f.cwd, timestamp: iso(2), message: { role: 'assistant', model: 'claude-exact', content: [] } },
    ].map(value => JSON.stringify(value)).join('\n'));
    const { session } = await readClaudeSession(file, 'work', f.accounts.work.claude);
    const prepared = await prepareResumeLaunch({ root: f.root, session, config: f.config, overrides: { thinking: 'low' } });
    assert.deepEqual(prepared.plan.args, ['--resume', id, '--model', 'claude-exact', '--effort', 'low']);
    assert.deepEqual(prepared.spec.args.slice(-6), prepared.plan.args);
    assert.equal(prepared.spec.env.CLAUDE_CONFIG_DIR, f.accounts.work.claude);
    assert.equal(prepared.verification.verified, false);
    assert.match(prepared.verification.reason ?? '', /not proof of restored startup state/);
  } finally { await f.cleanup(); }
});

test('selected installed Pi runtime accepts an exact disposable session/model/effort when available', { timeout: 40_000 }, async (t) => {
  const selected = process.env.MPX_PI_EXECUTABLE;
  if (!selected || !path.isAbsolute(selected)) { t.skip('MPX_PI_EXECUTABLE is unavailable'); return; }
  try { await access(selected); } catch { t.skip('selected Pi executable is unavailable'); return; }
  const f = await fixture();
  try {
    const provider = 'mpx-resume-fixture';
    const model = 'exact-model';
    await writeFile(path.join(f.accounts.personal.pi, 'models.json'), JSON.stringify({ providers: {
      [provider]: {
        baseUrl: 'http://127.0.0.1:1', api: 'openai-completions', apiKey: 'fixture-only',
        models: [{ id: model, reasoning: true, thinkingLevelMap: { medium: 'medium' } }],
      },
    } }));
    const nativeFile = path.join(f.accounts.personal.pi, 'sessions', '--project--', 'native-session.jsonl');
    await writeFile(nativeFile, [
      { type: 'session', version: 3, id: 'native-session', timestamp: iso(0), cwd: f.cwd },
      { type: 'message', id: 'u1', parentId: null, timestamp: iso(1), message: { role: 'user', content: 'native preflight' } },
      { type: 'model_change', id: 'm2', parentId: 'u1', timestamp: iso(2), provider, modelId: model },
      { type: 'thinking_level_change', id: 't3', parentId: 'm2', timestamp: iso(3), thinkingLevel: 'medium' },
    ].map(value => JSON.stringify(value)).join('\n'));
    const { session } = await readPiSession(nativeFile, 'personal', f.accounts.personal.pi);
    f.config.executables!.pi = await realpath(selected);
    const prepared = await prepareResumeLaunch({ root: f.root, session, config: f.config, preflightTimeoutMs: 30_000 });
    assert.equal(prepared.verification.verified, true);
    assert.deepEqual({
      provider: prepared.verification.observed?.provider,
      model: prepared.verification.observed?.model,
      thinking: prepared.verification.observed?.thinking,
    }, { provider, model, thinking: 'medium' });
  } finally { await f.cleanup(); }
});

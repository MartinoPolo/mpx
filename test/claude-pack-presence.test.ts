import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handleClaudeHook, POST_COMPACTION_RESTART } from '../src/claude-hooks.js';
import { createLaunchSpec } from '../src/launch.js';
import { readUserConfig, resolveProject, selectPacks } from '../src/config.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mpx-pack-presence-'));
  const home = join(root, 'home');
  const appData = join(root, 'appdata');
  const accounts = { personal: { pi: join(root, 'personal-pi'), claude: join(home, '.claude') }, work: { pi: join(root, 'work-pi'), claude: join(root, 'work-cc') } };
  for (const account of Object.values(accounts)) for (const directory of Object.values(account)) await mkdir(directory, { recursive: true });
  for (const pack of ['development', 'personal']) await mkdir(join(root, 'dist', 'packs', pack, 'claude'), { recursive: true });
  const configFile = join(appData, 'mpx', 'config.json');
  await mkdir(join(appData, 'mpx'), { recursive: true });
  await writeFile(configFile, JSON.stringify({ accounts, domains: { personal: [join(root, 'projects')], work: [join(root, 'work')] }, executables: { claude: process.execPath } }));
  const cwd = join(root, 'projects', 'app');
  await mkdir(cwd, { recursive: true });
  const env = { APPDATA: appData, USERPROFILE: home, HOME: home };
  return { root, cwd, env, accounts, configFile, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const transcriptPath = 'C:\\Users\\someone\\.claude\\projects\\app\\session.jsonl';
const sessionStart = (cwd: string, source = 'resume') => ({ hook_event_name: 'SessionStart', source, cwd, transcript_path: transcriptPath });

test('a Claude session started without the MPX launcher warns about every missing pack and names the relaunch command', async () => {
  const f = await fixture();
  try {
    const result = await handleClaudeHook(sessionStart(f.cwd), f.root, f.env);
    const output = JSON.parse(result.stdout);
    assert.match(output.systemMessage, /development, personal/);
    assert.match(output.systemMessage, /`mpx resume --launch "C:\/Users\/someone\/\.claude\/projects\/app\/session\.jsonl" --account personal --harness claude`/);
    assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.ok(output.hookSpecificOutput.additionalContext.startsWith(output.systemMessage), 'the model also learns its skills are missing');
  } finally { await f.cleanup(); }
});

test('the warning keeps the compaction restart and machine roots in the model context', async () => {
  const f = await fixture();
  try {
    const result = await handleClaudeHook(sessionStart(f.cwd, 'compact'), f.root, { ...f.env, MPX_PROJECTS: 'C:/fixture-projects' });
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.ok(context.includes(POST_COMPACTION_RESTART));
    assert.match(context, /C:\/fixture-projects/);
  } finally { await f.cleanup(); }
});

test('a session started by the MPX launcher with the selected packs stays silent', async () => {
  const f = await fixture();
  try {
    const config = await readUserConfig(f.configFile, f.env);
    const project = await resolveProject(f.cwd, config);
    const selection = await selectPacks(f.root, 'claude', 'personal', project, config);
    assert.equal(selection.paths.length, 2, 'both fallback packs are selected');
    const spec = await createLaunchSpec({ root: f.root, cwd: f.cwd, harness: 'claude', account: 'personal', config, project, selection, args: [], env: f.env });
    const result = await handleClaudeHook(sessionStart(f.cwd, 'startup'), f.root, spec.env);
    assert.equal(result.stdout, '');
  } finally { await f.cleanup(); }
});

test('the account follows the Claude config directory rather than an inherited MPX_ACCOUNT', async () => {
  const f = await fixture();
  try {
    const env = { ...f.env, MPX_ACCOUNT: 'personal', CLAUDE_CONFIG_DIR: f.accounts.work.claude };
    const output = JSON.parse((await handleClaudeHook(sessionStart(f.cwd), f.root, env)).stdout);
    assert.match(output.systemMessage, /not loaded in this session: development\./);
    assert.match(output.systemMessage, /--account work --harness claude/);
  } finally { await f.cleanup(); }
});

test('without a pasteable transcript path the warning points to the resume picker', async () => {
  const f = await fixture();
  try {
    const output = JSON.parse((await handleClaudeHook({ hook_event_name: 'SessionStart', source: 'startup', cwd: f.cwd }, f.root, f.env)).stdout);
    assert.match(output.systemMessage, /relaunch with `mpx resume`\.$/);
  } finally { await f.cleanup(); }
});

test('an account outside the MPX configuration stays silent', async () => {
  const f = await fixture();
  try {
    const result = await handleClaudeHook(sessionStart(f.cwd), f.root, { ...f.env, CLAUDE_CONFIG_DIR: join(f.root, 'elsewhere') });
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  } finally { await f.cleanup(); }
});

test('a missing user configuration stays silent, but a malformed one is reported without blocking the session', async () => {
  const f = await fixture();
  try {
    const missing = await handleClaudeHook(sessionStart(f.cwd), f.root, { ...f.env, APPDATA: join(f.root, 'missing') });
    assert.deepEqual([missing.code, missing.stdout, missing.stderr], [0, '', '']);
    await writeFile(f.configFile, '{');
    const malformed = await handleClaudeHook(sessionStart(f.cwd), f.root, f.env);
    assert.equal(malformed.code, 0);
    assert.equal(malformed.stdout, '');
    assert.match(malformed.stderr, /pack check failed/);
  } finally { await f.cleanup(); }
});

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  NativeRpcTransport, completePrompt, observerSource, parseArguments, request, rpcSpawnCommand,
  sanitizeProbeEnvironment, validateCommands, waitForObservation, type RpcTransport,
} from '../migration/native-pi-acceptance.js';
import type { LaunchSpec } from '../src/contracts.js';

test('requires the standard standalone --live gate and absolute paths', () => {
  const cwd = process.platform === 'win32' ? 'C:\\repo' : '/repo';
  const artifacts = process.platform === 'win32' ? 'C:\\probe' : '/probe';
  assert.throws(() => parseArguments(['--live', 'true', '--account', 'work', '--cwd', cwd, '--artifacts', artifacts]), /exactly --live/);
  assert.throws(() => parseArguments(['--live', '--account', 'personal', '--cwd', 'relative', '--artifacts', artifacts]), /absolute/);
  assert.equal(parseArguments(['--live', '--account', 'work', '--cwd', cwd, '--artifacts', artifacts]).account, 'work');
  assert.equal(parseArguments(['--live', '--account', 'work', '--cwd', cwd, '--artifacts', artifacts, '--project-override', cwd]).projectOverride, cwd);
  assert.throws(() => parseArguments(['--live', '--account', 'work', '--cwd', cwd, '--artifacts', artifacts, '--project-override', 'relative']), /absolute/);
});

test('scrubs inherited routing, pane, credential, and provider selectors without mutating input', () => {
  const source = { ORCA_PANE: 'secret', MPX_PARENT_PANE: '1', OPENAI_API_KEY: 'token', CUSTOM_PROVIDER: 'bad', PATH: 'ok' };
  const result = sanitizeProbeEnvironment(source);
  assert.deepEqual(result.env, { PATH: 'ok' });
  assert.deepEqual(source, { ORCA_PANE: 'secret', MPX_PARENT_PANE: '1', OPENAI_API_KEY: 'token', CUSTOM_PROVIDER: 'bad', PATH: 'ok' });
  assert.equal(result.removedProviderOverrides, 2);
});

test('forwards a Windows shell shim positionally through Git Bash with CRT quoting', { skip: process.platform !== 'win32' }, () => {
  const spec = { executable: 'C:\\repo\\node_modules\\.bin\\pi', args: ['--mode', 'rpc', 'line\nvalue'], cwd: 'C:\\repo', env: {}, label: '', warnings: [], requiresConfirmation: false } satisfies LaunchSpec;
  const command = rpcSpawnCommand(spec);
  assert.equal(command.executable, 'bash');
  assert.equal(command.windowsVerbatimArguments, true);
  assert.ok(command.args.every(value => value.startsWith('"') && value.endsWith('"')));
  assert.ok(command.args.some(value => value.includes('C:\\repo\\node_modules\\.bin\\pi')));
});

class Fake implements RpcTransport {
  sent: Record<string, unknown>[] = [];
  queue: Record<string, unknown>[];
  constructor(records: Record<string, unknown>[]) { this.queue = [...records]; }
  send(value: Record<string, unknown>): void { this.sent.push(value); }
  async next(_deadlineMs?: number): Promise<Record<string, unknown>> { const value = this.queue.shift(); if (!value) throw new Error('empty fake'); return value; }
  requeue(records: Record<string, unknown>[]): void { this.queue.unshift(...records); }
  async stop(): Promise<void> {}
}

test('RPC request preserves events emitted before its correlated response', async () => {
  const early = { type: 'extension_ui_request', method: 'notify', message: 'early' };
  const fake = new Fake([early, { id: 'state', type: 'response', success: true, data: { answer: 1 } }]);
  assert.equal((await request(fake, { id: 'state', type: 'get_state' }, Date.now() + 1000, [])).answer, 1);
  assert.deepEqual(await fake.next(0), early);
});

test('RPC request records extension errors without retaining arbitrary diagnostics', async () => {
  const fake = new Fake([{ type: 'extension_error', extensionPath: '/x.ts', error: 'boom' }, { id: 'state', type: 'response', success: true, data: {} }]);
  const errors: string[] = [];
  await request(fake, { id: 'state', type: 'get_state' }, Date.now() + 1000, errors);
  assert.deepEqual(errors, ['/x.ts: boom']);
});

test('observation wait collects extension errors before observer evidence', async () => {
  const fake = new Fake([
    { type: 'extension_error', extensionPath: '/bad.ts', error: 'broken' },
    { type: 'extension_ui_request', method: 'notify', message: 'MPX2_NATIVE_PROBE:{"tools":[]}' },
  ]);
  const errors: string[] = [];
  assert.deepEqual(await waitForObservation(fake, Date.now() + 1000, errors), { tools: [] });
  assert.deepEqual(errors, ['/bad.ts: broken']);
});

test('observer reports registered native tools and blocks every tool call', () => {
  const source = observerSource();
  assert.match(source, /getAllTools\(\).*tool\.name/);
  assert.match(source, /tool_call/);
  assert.match(source, /block:true/);
});

test('prompt waits for agent_settled and requires a successful assistant marker response', async () => {
  const fake = new Fake([
    { id: 'prompt', type: 'response', success: true, data: {} },
    { type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } },
    { type: 'agent_settled' },
    { id: 'last', type: 'response', success: true, data: { text: 'marker-1' } },
  ]);
  assert.equal(await completePrompt(fake, 'remember', Date.now() + 1000, []), 'marker-1');
});

test('prompt rejects any native tool execution before completion', async () => {
  const fake = new Fake([{ id: 'prompt', type: 'response', success: true, data: {} }, { type: 'tool_execution_start', toolName: 'write' }]);
  await assert.rejects(completePrompt(fake, 'x', Date.now() + 1000, []), /attempted tool write/);
});

function fakeChild(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    pid: 123, exitCode: null, signalCode: null, spawnargs: [], kill: () => true,
  });
  return child;
}

test('native transport frames split Unicode JSON only on LF and accepts CRLF', async () => {
  const child = fakeChild();
  const transport = new NativeRpcTransport(child, async () => {});
  const payload = Buffer.from('{"type":"event","text":"雪 line"}\r\n');
  (child.stdout as PassThrough).write(payload.subarray(0, 19));
  (child.stdout as PassThrough).write(payload.subarray(19));
  assert.deepEqual(await transport.next(Date.now() + 1000), { type: 'event', text: '雪 line' });
});

test('native transport removes timed-out waiters so a late event remains available', async () => {
  const child = fakeChild();
  const transport = new NativeRpcTransport(child, async () => {});
  await assert.rejects(transport.next(Date.now() + 5), /timed out/);
  (child.stdout as PassThrough).write('{"type":"late"}\n');
  assert.deepEqual(await transport.next(Date.now() + 1000), { type: 'late' });
});

test('malformed RPC output immediately initiates owned-child cleanup', async () => {
  const child = fakeChild();
  let stops = 0;
  const transport = new NativeRpcTransport(child, async () => { stops++; });
  (child.stdout as PassThrough).write('not-json\n');
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(transport.next(Date.now() + 1000), /Unexpected token|JSON/);
  assert.equal(stops, 1);
});

test('stdin errors fail pending reads and initiate cleanup', async () => {
  const child = fakeChild();
  let stopped = false;
  const transport = new NativeRpcTransport(child, async () => { stopped = true; });
  const pending = transport.next(Date.now() + 1000);
  child.stdin.emit('error', new Error('pipe gone'));
  await assert.rejects(pending, /stdin failed/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, true);
});

test('stop preserves both an execution error and a cleanup failure', async () => {
  const child = fakeChild();
  const transport = new NativeRpcTransport(child, async () => { throw new Error('cleanup failed'); });
  child.emit('error', new Error('spawn failed'));
  await assert.rejects(transport.stop(), error => error instanceof AggregateError && error.errors.length === 2);
});

test('stop terminates the owned tree without first closing native stdin', async () => {
  const child = fakeChild();
  let ended = false;
  child.stdin.on('finish', () => { ended = true; });
  const transport = new NativeRpcTransport(child, async () => { assert.equal(ended, false); });
  await transport.stop();
  assert.equal(ended, false);
});

test('pinned native extension-load stderr signature is classified without exposing stderr', async () => {
  const child = fakeChild();
  const transport = new NativeRpcTransport(child, async () => {});
  (child.stderr as PassThrough).write('private diagnostic\nHint: Start without extensions using "pi -ne".\n');
  child.emit('close', 1, null);
  await assert.rejects(transport.next(Date.now() + 1000), error => error instanceof Error && /extension-load failure/.test(error.message) && !/private diagnostic/.test(error.message));
});

test('native sourceInfo paths reject missing, duplicate, shadowed and out-of-pack skills while preserving extension commands', async () => {
  const { mkdtemp, writeFile, realpath, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'mpx-native-command-paths-'));
  try {
    const file = join(directory, 'SKILL.md');
    const wrong = join(directory, 'OTHER.md');
    await writeFile(file, 'fixture'); await writeFile(wrong, 'unselected fixture');
    const expectedPath = await realpath(file);
    const expected = new Map([['alpha', expectedPath]]);
    const skill = (name: string, sourcePath = expectedPath) => ({ name: `skill:${name}`, source: 'skill', sourceInfo: { path: sourcePath } });
    assert.deepEqual(await validateCommands({ commands: [skill('alpha'), { name: 'skill:mcp-scripting', source: 'extension' }] }, expected), [{ name: 'alpha', path: expectedPath }]);
    await assert.rejects(validateCommands({ commands: [skill('alpha'), { name: 'skill:mp-unselected', source: 'extension' }] }, expected), /Unexpected MPX2 skill/);
    await assert.rejects(validateCommands({ commands: [{ ...skill('alpha'), source: 'extension' }] }, expected), /wrong source/);
    await assert.rejects(validateCommands({ commands: [skill('alpha'), skill('alpha')] }, expected), /resolved 2 times/);
    await assert.rejects(validateCommands({ commands: [skill('alpha', wrong)] }, expected), /wrong path/);
    await assert.rejects(validateCommands({ commands: [skill('alpha'), skill('beta', wrong)] }, expected, [directory]), /Unexpected MPX2 skill/);
    await rm(file);
    await assert.rejects(validateCommands({ commands: [skill('alpha')] }, expected), /source is unavailable/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

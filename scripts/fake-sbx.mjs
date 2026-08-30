#!/usr/bin/env node
import { createHash } from 'node:crypto';
import process from 'node:process';
const argv = process.argv.slice(2);
const callLog = process.env.MPX_FAKE_SBX_CALL_LOG;
if (callLog) {
  const { appendFile } = await import('node:fs/promises');
  await appendFile(callLog, `${JSON.stringify(argv)}\n`);
}
const scoped = argv[0] === '--app-name';
const appName = scoped ? argv[1] : undefined;
const command = argv[scoped ? 2 : 0];
if (process.env.MPX_FAKE_SBX_MODE === `hang-${command}`) {
  await new Promise((resolve) => setTimeout(resolve, 60_000));
}
const offset = scoped ? 3 : 1;
const allowed = new Set([
  'version',
  '--help',
  'daemon',
  'diagnose',
  'create',
  'run',
  'exec',
  'ports',
  'policy',
  'ls',
  'rm',
]);
let invalid =
  !allowed.has(command) ||
  (scoped && !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(appName ?? '')) ||
  argv.some((value) => /[\r\n\0]/u.test(value));
if (command === 'exec' && scoped) {
  const executable = argv[offset + 1];
  if (executable === 'mpx-projection-receiver') {
    const expected = argv[offset + 3],
      destination = argv[offset + 5],
      body = [];
    for await (const chunk of process.stdin) {
      body.push(chunk);
    }
    invalid ||=
      argv[offset + 2] !== '--sha256' ||
      argv[offset + 4] !== '--destination' ||
      !/^[a-f0-9]{64}$/u.test(expected ?? '') ||
      destination !== `/opt/mpx/projections/${expected}` ||
      createHash('sha256').update(Buffer.concat(body)).digest('hex') !== expected;
  } else if (executable === 'claude') {
    invalid ||=
      argv[offset + 2] !== '--plugin-dir' ||
      !argv[offset + 3]?.startsWith('/opt/mpx/projections/') ||
      argv[offset + 4] !== '--mcp-config' ||
      !argv[offset + 5]?.startsWith('/opt/mpx/projections/');
  }
}
if (invalid) {
  process.stderr.write('{"error":"FAKE_SBX_ARGV_INVALID"}\n');
  process.exitCode = 2;
} else if (command === 'version') {
  process.stdout.write('sbx version: v0.39.0 def8cb0523a77e757bdd6ef52b459fe374f3783e\n');
} else if (command === '--help') {
  process.stdout.write(
    ['create', 'daemon', 'diagnose', 'exec', 'ls', 'policy', 'ports', 'rm', 'run', 'version']
      .map((value) => `  ${value} fake`)
      .join('\n') + '\n',
  );
} else if (command === 'daemon') {
  process.stdout.write(
    '{"status":"running","socket":"fake","clientVersion":"0.39.0","daemonVersion":"0.39.0"}\n',
  );
} else if (command === 'diagnose') {
  process.stdout.write(
    '{"version":"1.0","checks":[{"name":"Authentication","status":"pass","message":"fake","detail":"fake","hint":"fake"}],"summary":{"pass":1,"warn":0,"fail":0,"skip":0}}\n',
  );
} else if (command === 'create') {
  const state = process.env.MPX_FAKE_SBX_STATE;
  invalid ||= argv.includes('--profile');
  if (state) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      state,
      JSON.stringify({ allows: [], defaultAllow: process.env.MPX_FAKE_SBX_MODE === 'open-policy' }),
    );
  }
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command, status: 'pass' })}\n`);
} else if (command === 'policy' && argv[scoped ? 3 : 1] === 'allow') {
  const sandboxIndex = argv.indexOf('--sandbox'),
    state = process.env.MPX_FAKE_SBX_STATE,
    targets = argv.slice(sandboxIndex + 2);
  invalid ||=
    argv[scoped ? 4 : 2] !== 'network' ||
    sandboxIndex !== (scoped ? 5 : 3) ||
    targets.length < 1 ||
    argv.includes('--profile') ||
    targets.some((value) => !/^[a-z0-9.-]+:[1-9]\d{0,4}$/u.test(value));
  if (state) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(state, JSON.stringify({ allows: targets }));
  }
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command, status: 'pass' })}\n`);
} else if (command === 'policy' && argv[scoped ? 3 : 1] === 'check') {
  const sandbox = argv[scoped ? 6 : 4],
    target = argv[scoped ? 7 : 5],
    state = process.env.MPX_FAKE_SBX_STATE,
    { readFile } = await import('node:fs/promises'),
    { allows, defaultAllow = false } = state
      ? JSON.parse(await readFile(state, 'utf8'))
      : { allows: [] };
  invalid ||=
    argv.length !== (scoped ? 9 : 7) ||
    argv[scoped ? 5 : 3] !== '--sandbox' ||
    argv[scoped ? 8 : 6] !== '--json' ||
    argv.includes('--profile');
  const mode = process.env.MPX_FAKE_SBX_MODE ?? '',
    expectedAllowed = defaultAllow || allows.includes(target),
    allowed = mode.startsWith('check-mismatch') ? !expectedAllowed : expectedAllowed;
  const response = {
    action: mode === 'check-wrong-action' ? 'connect' : 'net:connect:tcp',
    allowed,
    resource_value: mode === 'check-wrong-resource' ? 'wrong.invalid:443' : target,
    type: mode === 'check-wrong-type' ? 'host' : 'network',
    ...(!allowed ? { deny_kind: 'implicit', reason: 'default deny', rule: 'default' } : {}),
    ...(mode === 'check-unknown-field' ? { sandbox } : {}),
    ...(mode === 'check-private-field' ? { token: 'secret' } : {}),
  };
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (!allowed) {
    process.exit(1);
  }
} else if (command === 'policy' && argv[scoped ? 3 : 1] === 'log') {
  process.stdout.write(`${JSON.stringify({ blocked_hosts: [], allowed_hosts: [] })}\n`);
} else {
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, command, argvSha256: createHash('sha256').update(JSON.stringify(argv)).digest('hex'), status: 'pass' })}\n`,
  );
}
if (command === 'rm' && process.env.MPX_FAKE_SBX_MODE?.includes('rm-fail')) {
  process.stderr.write('x'.repeat(70_000));
  process.exitCode = 9;
}

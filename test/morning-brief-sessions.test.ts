import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const sessionsScript = resolve('content/skills/morning-brief/scripts/sessions.mjs');
const HOUR_MILLISECONDS = 60 * 60 * 1000;
const OVERNIGHT_SESSION = '6f1c2a9e-0b3d-4c7e-9a41-2d6f8e7b1c90';
const EVENING_SESSION = '0b9d2c1e-5f3a-4c7e-9a41-2d6f8e7b1c91';
const PI_SESSION = '01a07d39-5433-77cc-badf-ebd5467e9771';

type Session = { file: string; sessionId: string; activeWhileAway?: unknown; reportLinks?: { label: string; link: string }[] };

const at = (until: number, hoursBefore: number) => new Date(until - hoursBefore * HOUR_MILLISECONDS).toISOString();
const claudeEntry = (role: string, timestamp: string, content: unknown) => JSON.stringify({ type: role, timestamp, message: { role, content } });

test('each session carries its id, and one active while I was away carries the links of its last report', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mpx-brief-sessions-'));
  try {
    const until = Date.now();
    const claudeRoot = join(home, 'claude');
    const piRoot = join(home, 'pi');
    await mkdir(join(home, 'appdata', 'mpx'), { recursive: true });
    await writeFile(join(home, 'appdata', 'mpx', 'config.json'), JSON.stringify({ accounts: { personal: { claude: claudeRoot, pi: piRoot } } }));
    const projectDirectory = join(claudeRoot, 'projects', 'C--videoLab');
    await mkdir(projectDirectory, { recursive: true });

    const manyLinks = Array.from({ length: 8 }, (_, index) => `[frame ${index + 1}](file:///C:/videoLab/out/frame-${index + 1}.png)`).join(' ');
    const report = [
      'Done. See [Render report](file:///C:/videoLab/report.md) and the [demo clip](<file:///C:/videoLab/out/demo clip.mp4>).',
      'Pull request: https://github.com/owner/videoLab/pull/12. Again the [Report](file:///C:/videoLab/report.md).',
      'Not a result: http://insecure.example/page and C:\\videoLab\\notes.txt.',
      manyLinks,
    ].join('\n');
    await writeFile(join(projectDirectory, `${OVERNIGHT_SESSION}.jsonl`), [
      claudeEntry('user', at(until, 10), 'Render the demo and report back'),
      claudeEntry('assistant', at(until, 9), [{ type: 'text', text: 'Starting: [plan](file:///C:/videoLab/plan.md)' }]),
      claudeEntry('assistant', at(until, 3), [{ type: 'text', text: report }]),
      claudeEntry('assistant', at(until, 2.9), [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }]),
    ].join('\n'));
    await writeFile(join(projectDirectory, `${EVENING_SESSION}.jsonl`), [
      claudeEntry('user', at(until, 14), 'Quick question'),
      claudeEntry('assistant', at(until, 13.9), [{ type: 'text', text: 'Answered in [notes](https://notes.example/answer).' }]),
    ].join('\n'));
    const piDirectory = join(piRoot, 'sessions', '--C--videoLab--');
    await mkdir(piDirectory, { recursive: true });
    await writeFile(join(piDirectory, `2026-11-17T08-00-00-000Z_${PI_SESSION}.jsonl`),
      JSON.stringify({ type: 'message', timestamp: at(until, 15), message: { role: 'user', content: [{ type: 'text', text: 'Earlier work' }] } }));

    const { stdout } = await exec(process.execPath, [sessionsScript, '--since', at(until, 48), '--until', new Date(until).toISOString()], {
      env: { ...process.env, APPDATA: join(home, 'appdata') }, timeout: 60_000,
    });
    const { sessions } = JSON.parse(stdout) as { sessions: Session[] };
    const byId = new Map(sessions.map((session) => [session.sessionId, session]));
    assert.deepEqual([...byId.keys()].sort(), [EVENING_SESSION, OVERNIGHT_SESSION, PI_SESSION].sort(), 'the id is the transcript name, without a Pi file\'s time prefix');

    const overnight = byId.get(OVERNIGHT_SESSION)!;
    assert.ok(overnight.activeWhileAway);
    assert.deepEqual(overnight.reportLinks, [
      { label: 'Render report', link: 'file:///C:/videoLab/report.md' },
      { label: 'demo clip', link: 'file:///C:/videoLab/out/demo clip.mp4' },
      { label: 'https://github.com/owner/videoLab/pull/12', link: 'https://github.com/owner/videoLab/pull/12' },
      ...Array.from({ length: 5 }, (_, index) => ({ label: `frame ${index + 1}`, link: `file:///C:/videoLab/out/frame-${index + 1}.png` })),
    ], 'the last report\'s https and file links, each once, at most eight');
    const evening = byId.get(EVENING_SESSION)!;
    assert.deepEqual([evening.activeWhileAway, evening.reportLinks], [undefined, undefined], 'a session not active while I was away has no report links');
    assert.doesNotMatch(stdout, /Render the demo and report back[\s\S]*Render the demo and report back/, 'the prompt is taken once, as the title');
    assert.doesNotMatch(stdout, /Not a result|Starting:/, 'no other report text is copied');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

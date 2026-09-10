import { type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore } from '@mpx/sessions';
import { afterEach, describe, expect, it } from 'vitest';
import { productionSessionResumeDependencies } from '@mpx/application/node';

const roots: string[] = [],
  children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function accountFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-credential-free-subprocess-'));
  roots.push(root);
  const claude = path.join(root, 'claude'),
    pi = path.join(root, 'pi'),
    state = path.join(root, 'state');
  await Promise.all([mkdir(claude), mkdir(pi), mkdir(state)]);
  const user = { identities: { test: { domain: 'local', runtimeRoots: { claude, pi } } } } as never;
  return { root, claude, pi, state, user, store: new SessionStore(state) };
}

describe('credential-free subprocess boundaries', () => {
  it('uses the configured Claude executable, account environment, and JSON for active discovery and resume activity', async () => {
    const f = await accountFixture(),
      capture = path.join(f.root, 'claude-invocations.jsonl'),
      preload = path.join(f.root, 'claude-preload.cjs');
    await writeFile(
      preload,
      `const fs=require('node:fs');fs.appendFileSync(process.env.MPX_CAPTURE,JSON.stringify({argv:process.argv.slice(1),root:process.env.CLAUDE_CONFIG_DIR})+'\\n');process.stdout.write(JSON.stringify({agents:[{type:'interactive',sessionId:'session-real',cwd:'C:/fixture/repo',name:'Fixture',pid:4242,startFingerprint:'fixture-start'}]}));process.exit(0);\n`,
    );
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      MPX_CLAUDE_EXECUTABLE: process.execPath,
      MPX_CAPTURE: capture,
      NODE_OPTIONS: `--require=${preload}`,
    };
    const dependencies = await productionSessionResumeDependencies({
      user: f.user,
      store: f.store,
      environment,
    })({ runtime: 'claude' } as never);
    await expect(
      dependencies.verifyNativeTarget(
        f.claude,
        { kind: 'native-id', value: 'session-real' },
        'claude:session-real',
      ),
    ).resolves.toEqual({ valid: true, activity: 'active' });
    const calls = (await readFile(capture, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls).toHaveLength(1);
    for (const call of calls) {
      expect(path.basename(call.argv[0])).toBe('agents');
      expect(call).toMatchObject({ argv: [expect.any(String), '--json'], root: f.claude });
    }
  }, 20_000);
});

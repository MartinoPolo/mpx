import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore } from '@mpx/sessions';
import { WindowsProcessCapabilities } from '@mpx/windows';
import { afterEach, describe, expect, it } from 'vitest';
import {
  productionSessionDiscoveries,
  productionSessionResumeDependencies,
} from '@mpx/application/node';

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
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-phase-g-subprocess-'));
  roots.push(root);
  const claude = path.join(root, 'claude'),
    pi = path.join(root, 'pi'),
    state = path.join(root, 'state');
  await Promise.all([mkdir(claude), mkdir(pi), mkdir(state)]);
  const user = { identities: { test: { domain: 'local', runtimeRoots: { claude, pi } } } } as never;
  return { root, claude, pi, state, user, store: new SessionStore(state) };
}

describe('Phase G credential-free subprocess boundaries', () => {
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
    const discoveries = await productionSessionDiscoveries({
      user: f.user,
      store: f.store,
      environment,
      options: {
        exactNativeRootVerifier: { verify: async () => undefined },
        piAuthVerifier: { verify: async () => undefined },
      },
    });
    const claude = discoveries.find((item) => item.scanner.runtime === 'claude')!;
    await expect(claude.scanner.scan()).resolves.toMatchObject({
      status: 'available',
      sessions: [{ nativeSessionId: 'session-real', pid: 4242 }],
    });
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
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(path.basename(call.argv[0])).toBe('agents');
      expect(call).toMatchObject({ argv: [expect.any(String), '--json'], root: f.claude });
    }
  }, 20_000);

  it.runIf(process.platform === 'win32')(
    'admits a Pi active-registry entry only across the real Windows process-inspector boundary',
    async () => {
      const f = await accountFixture(),
        sessions = path.join(f.pi, 'sessions'),
        registry = path.join(f.pi, 'agent-resurrect', 'active-sessions');
      await Promise.all([mkdir(sessions), mkdir(registry, { recursive: true })]);
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      children.push(child);
      if (!child.pid) {
        throw new Error('fixture subprocess did not start');
      }
      let inspected;
      for (let attempt = 0; attempt < 50 && !inspected; attempt++) {
        inspected = await new WindowsProcessCapabilities().inspect(child.pid);
        if (!inspected) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      if (!inspected) {
        throw new Error('fixture subprocess could not be inspected');
      }
      const sessionFile = path.join(sessions, 'real.jsonl');
      await writeFile(sessionFile, '{}\n');
      await writeFile(
        path.join(registry, 'real.json'),
        JSON.stringify({
          version: 2,
          agent: 'pi',
          sessionId: 'real',
          sessionFile,
          cwd: 'C:/fixture/repo',
          pid: child.pid,
          processStartedAt: inspected.startFingerprint,
          registeredAt: new Date().toISOString(),
        }),
      );
      const discoveries = await productionSessionDiscoveries({
        user: f.user,
        store: f.store,
        environment: {},
        options: {
          exactNativeRootVerifier: { verify: async () => undefined },
          piAuthVerifier: { verify: async () => undefined },
        },
      });
      await expect(
        discoveries.find((item) => item.scanner.runtime === 'pi')!.scanner.scan(),
      ).resolves.toMatchObject({
        status: 'available',
        sessions: [
          { nativeSessionId: 'real', pid: child.pid, startFingerprint: inspected.startFingerprint },
        ],
      });
    },
    20_000,
  );
});

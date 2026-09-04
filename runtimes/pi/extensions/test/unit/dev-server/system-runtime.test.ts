import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import { createSystemRuntime, systemSpawnInvocation } from '../../../dev-server/system-runtime.js';

test('Windows launches the foreground command through hidden cmd.exe without detaching', () => {
  assert.deepEqual(systemSpawnInvocation('npm run dev', 'win32'), {
    file: 'cmd.exe',
    args: ['/d', '/s', '/c', 'npm run dev'],
    detached: false,
  });
});

test('POSIX launches a detached process group', () => {
  assert.deepEqual(systemSpawnInvocation('npm run dev', 'linux'), {
    file: '/bin/sh',
    args: ['-c', 'npm run dev'],
    detached: true,
  });
});

test(
  'production Windows stop terminates a disposable command tree',
  { skip: process.platform !== 'win32', timeout: 15_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pi-runtime-tree-'));
    const helperPath = path.join(directory, 'tree.cjs');
    const pidPath = path.join(directory, 'pids.json');
    await writeFile(
      helperPath,
      `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(join(__dirname, "pids.json"), JSON.stringify({ helper: process.pid, descendant: child.pid }));
setInterval(() => {}, 1000);
`,
    );
    const runtime = createSystemRuntime();
    const child = runtime.spawn({ command: 'node tree.cjs', cwd: directory });
    let pids: { helper: number; descendant: number } | undefined;
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && pids === undefined) {
        try {
          pids = JSON.parse(await readFile(pidPath, 'utf8'));
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      assert.ok(pids, 'helper did not publish process ids');
      await runtime.stop(child);
      await child.closed;
      const stoppedDeadline = Date.now() + 5_000;
      while (Date.now() < stoppedDeadline && (alive(pids.helper) || alive(pids.descendant))) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(alive(pids.helper), false, 'helper process remained alive');
      assert.equal(alive(pids.descendant), false, 'descendant process remained alive');
    } finally {
      try {
        await runtime.stop(child);
      } catch {}
      for (const pid of pids === undefined ? [] : [pids.helper, pids.descendant]) {
        try {
          await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
        } catch {}
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);

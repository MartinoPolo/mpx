import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createProductionSessionBranchRuntimeAdapter,
  createWindowsTerminalBranchAdapter,
  diagnoseSessionBranchAdapters,
} from './session-branch-adapters.js';

const invocation = {
  executable: 'C:/Program Files/Claude/claude.exe',
  argv: ['--resume', 'parent id', '--fork-session'],
  cwd: 'C:/repo & child',
  nativeTarget: 'runtime-created' as const,
};
const branch = {
  runtime: 'claude' as const,
  identity: { domain: 'work', name: 'employee' },
  rootDigest: 'a'.repeat(64),
  nativeBindingRef: 'binding',
  mode: 'locked',
  executor: 'host' as const,
  artifactKey: 'artifact',
  manifestKey: 'manifest',
  grants: [{ resource: 'repo', access: 'write' }],
  skillPolicy: 'standard',
  contentScope: 'repo',
  workspace: 'direct',
  networkPolicy: 'restricted',
  launchKey: 'launch',
  descriptorDigest: 'b'.repeat(64),
};

describe('production session branch adapters', () => {
  it('delegates a confirmed immutable child launch to normal launch execution without a command string', async () => {
    const exited = Promise.resolve({ exitCode: 0 }),
      lifecycle = Promise.resolve({
        runtimeQualifiedId: 'claude:actual',
        nativeSessionRef: { kind: 'native-id' as const, value: 'actual' },
      });
    const executeNormalLaunch = vi.fn(async () => ({ lifecycle, exited }));
    const adapter = createProductionSessionBranchRuntimeAdapter({ executeNormalLaunch });
    const plan = { launchIdentity: branch } as never;
    const child = await adapter.launch(invocation, plan);
    expect(executeNormalLaunch).toHaveBeenCalledWith({ invocation, branch, plan });
    expect(await child.lifecycle).toMatchObject({ runtimeQualifiedId: 'claude:actual' });
  });

  it('launches a trusted Windows Terminal executable with structured argv and shell disabled', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-wt-')),
      wt = path.join(root, 'wt.exe');
    await writeFile(wt, 'fake');
    const run = vi.fn(async () => ({
      lifecycle: Promise.resolve({
        runtimeQualifiedId: 'claude:actual',
        nativeSessionRef: { kind: 'native-id' as const, value: 'actual' },
      }),
      exited: Promise.resolve(),
    }));
    const adapter = await createWindowsTerminalBranchAdapter({
      candidate: wt,
      trustedRoots: [root],
      inspect: async (file) => ({ file: true, realpath: file }),
      run,
    });
    expect(adapter).not.toBeNull();
    await adapter!.launch({
      executable: wt,
      argv: [
        'new-tab',
        '--title',
        'child & safe',
        '--startingDirectory',
        invocation.cwd,
        '--',
        invocation.executable,
        ...invocation.argv,
      ],
      cwd: invocation.cwd,
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ executable: wt, shell: false, cwd: invocation.cwd }),
    );
  });

  it('reports runtime and optional terminal production availability without side effects', async () => {
    await expect(
      diagnoseSessionBranchAdapters({
        runtimeAvailable: true,
        terminalCandidate: 'C:/missing/wt.exe',
        trustedRoots: ['C:/Windows'],
      }),
    ).resolves.toEqual({
      runtime: { available: true },
      terminal: { available: false, code: 'WINDOWS_TERMINAL_UNAVAILABLE' },
    });
  });
});

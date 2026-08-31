import { describe, expect, it } from 'vitest';
import { DockerRuntimeAdapter, type SandboxRuntimeHandle } from '../../src/index.js';
import { RemoteToolClient } from '@mpx/executors';
const h = (c: string) => c.repeat(64);
function fixture() {
  const calls: { toolPath: string; input: unknown }[] = [];
  let sequence = 0;
  const outputs = new Map<string, string>();
  const handle: SandboxRuntimeHandle = {
    name: 'sbx-1',
    appNamespace: 'mpx-pi',
    async send(line) {
      const request = JSON.parse(line) as {
        requestId: string;
        requestSha256: string;
        toolPath: string;
        sequence: number;
      };
      sequence = request.sequence;
      const output =
        request.toolPath.endsWith('spawn') || request.toolPath.endsWith('restart')
          ? JSON.stringify({ pid: 42, fingerprint: 'pg:42:1' })
          : request.toolPath.endsWith('probe-vm')
            ? JSON.stringify({ ready: true })
            : request.toolPath.endsWith('inspect')
              ? JSON.stringify({ pid: 42, fingerprint: 'pg:42:1' })
              : request.toolPath.endsWith('logs')
                ? JSON.stringify({ stdout: 'ready\n', stderr: '' })
                : JSON.stringify({ stopped: true });
      outputs.set(request.requestId, output);
      calls.push({ toolPath: request.toolPath, input: undefined });
      return (
        JSON.stringify({
          schemaVersion: 1,
          kind: 'result',
          requestId: request.requestId,
          sequence,
          requestSha256: request.requestSha256,
          status: 'ok',
          outputSha256: await hash(output),
          outputBytes: Buffer.byteLength(output),
          errorCode: null,
        }) + '\n'
      );
    },
    async readOutput(requestId) {
      return outputs.get(requestId)!;
    },
    publishedPort(port) {
      return { host: '127.0.0.1' as const, port: port + 10000 };
    },
  };
  const client = new RemoteToolClient({
    planKey: h('a'),
    inventorySha256: h('b'),
    capabilitySha256: h('c'),
    send: (line, signal) => handle.send(line, signal),
  });
  return { handle, client, calls };
}
async function hash(value: string) {
  return (await import('node:crypto')).createHash('sha256').update(value).digest('hex');
}
describe('Docker dev-service runtime', () => {
  it('spawns, probes inside the VM and the assigned host-published loopback port, inspects logs, restarts and stops via the bound sandbox', async () => {
    const { handle, client, calls } = fixture();
    const hostProbes: string[] = [];
    const runtime = new DockerRuntimeAdapter({
      handle,
      client,
      capabilitySha256: h('c'),
      binding: { launchKey: h('d'), worktreeRoot: '/workspace', assignedPorts: [4100] },
      hostProbe: async (host, port) => {
        hostProbes.push(`${host}:${port}`);
        return true;
      },
      hostPortAvailable: async () => true,
    });
    const child = await runtime.spawn({
      id: 'web',
      executable: 'npm',
      args: ['run', 'dev'],
      cwd: '/workspace',
      ports: [4100],
      assignment: { worktreeRoot: '/workspace', ports: [4100] },
      executor: 'docker',
    });
    expect(await runtime.probe(4100)).toBe(true);
    expect(hostProbes).toEqual(['127.0.0.1:14100']);
    expect(await runtime.inspect(child.pid)).toEqual({ pid: 42, fingerprint: 'pg:42:1' });
    await runtime.logs(child.pid);
    await runtime.restart(child);
    await runtime.stop(child);
    expect(calls.map((v) => v.toolPath)).toEqual([
      'dev-services/spawn',
      'dev-services/probe-vm',
      'dev-services/inspect',
      'dev-services/logs',
      'dev-services/restart',
      'dev-services/stop',
    ]);
  });
  it('rejects a host-published assigned port conflict before spawning', async () => {
    const { handle, client, calls } = fixture();
    const runtime = new DockerRuntimeAdapter({
      handle,
      client,
      capabilitySha256: h('c'),
      binding: { launchKey: h('d'), worktreeRoot: '/workspace', assignedPorts: [4100] },
      hostProbe: async () => true,
      hostPortAvailable: async () => false,
    });
    await expect(
      runtime.spawn({
        id: 'web',
        executable: 'npm',
        args: [],
        cwd: '/workspace',
        ports: [4100],
        assignment: { worktreeRoot: '/workspace', ports: [4100] },
        executor: 'docker',
      }),
    ).rejects.toThrow(/port conflict/i);
    expect(calls).toEqual([]);
  });
  it('never falls back to host execution or kills a foreign process group', async () => {
    const { handle, client } = fixture();
    const runtime = new DockerRuntimeAdapter({
      handle,
      client,
      capabilitySha256: h('c'),
      binding: { launchKey: h('d'), worktreeRoot: '/workspace', assignedPorts: [] },
      hostProbe: async () => true,
      hostPortAvailable: async () => true,
    });
    const child = await runtime.spawn({
      id: 'web',
      executable: 'npm',
      args: [],
      cwd: '/workspace',
      ports: [],
      assignment: { worktreeRoot: '/workspace', ports: [] },
      executor: 'docker',
    });
    await expect(
      runtime.stop({
        pid: child.pid,
        fingerprint: 'foreign',
        stdout: child.stdout,
        stderr: child.stderr,
        closed: child.closed,
        onClose: (listener) => child.onClose(listener),
      }),
    ).rejects.toThrow(/ownership|fingerprint/);
  });
});

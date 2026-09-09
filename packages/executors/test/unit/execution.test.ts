import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createSkillArtifactReference, sha256Canonical } from '@mpx/core';
import type { JsonValue } from '@mpx/core';
import type { LaunchDescriptor } from '@mpx/launch';
import { createRuntimeCapabilityManifest } from '@mpx/runtime-contracts';
import type { ProcessRequest } from '../../src/index.js';
import {
  ExecutionError,
  ExecutorRegistry,
  ExecutionService,
  FileLaunchAuditStore,
  HostApprovalStore,
  RuntimeAdapterRegistry,
  compactLaunchBanner,
  createLaunchExecutionAudit,
  invokeBoundedProcess,
  locateTrustedExecutable,
  sanitizedEnvironment,
  sanitizeHostReason,
  type LaunchAuditRecord,
  type LaunchAuditStore,
} from '../../src/index.js';

const hash = (value: string) => value.repeat(64);
const artifactReference = (runtime: 'claude' | 'pi' = 'pi') => ({
  schemaVersion: 5 as const,
  runtime,
  manifestKey: hash('7'),
  artifactKey: hash('8'),
  fileMapHash: hash('9'),
});
function descriptor(executor: 'docker' | 'host' = 'docker'): LaunchDescriptor {
  const tuple = {
    schemaVersion: 3 as const,
    nativeRuntimeRootDigest: hash('a'),
    runtime: 'pi' as const,
    binding: { projectId: 'sample/app', repositoryId: 'sample/repo' },
    identity: { name: 'personal', domain: 'personal' },
    mode: 'project',
    executor:
      executor === 'docker'
        ? {
            name: 'docker' as const,
            effectiveEnforcement: 'mount-enforced' as const,
            isolation: 'container' as const,
            interception: {
              kind: 'container-boundary' as const,
              intercepted: ['container-filesystem', 'declared-mounts'] as const,
              knownBypasses: ['host-services', 'direct-extra-mounts'] as const,
            },
            mounts: { kind: 'explicit' as const, policyEnforced: true as const },
            confidentiality: {
              isolated: 'mount-dependent' as const,
              hostReadable: true as const,
              limitation:
                'Mounted content, host services, and direct extra mounts remain confidentiality limitations.' as const,
            },
            availability: 'available' as const,
          }
        : {
            name: 'host' as const,
            effectiveEnforcement: 'advisory' as const,
            isolation: 'none' as const,
            interception: {
              kind: 'policy-hooks' as const,
              intercepted: ['mpx-mediated-operations'] as const,
              knownBypasses: ['raw-shell', 'direct-filesystem', 'unmanaged-children'] as const,
            },
            mounts: { kind: 'host-direct' as const, policyEnforced: false as const },
            confidentiality: {
              isolated: false as const,
              hostReadable: true as const,
              limitation: 'No filesystem or confidentiality isolation is enforced.' as const,
            },
          },
    workspace: 'direct' as const,
    networkPolicy: { name: 'minimal', declaration: { preset: 'deny-all' as const } },
    preset: null,
    provenance: {
      runtime: 'explicit' as const,
      identity: 'explicit' as const,
      mode: 'explicit' as const,
      executor: 'explicit' as const,
      workspace: 'explicit' as const,
      networkPolicy: 'explicit' as const,
    },
    diagnostics: [],
    selection: {
      location: { name: 'coding', canonicalRoot: 'C:/project' },
      packs: ['development'] as const,
      source: 'project' as const,
    },
    cwdClassification: { domain: 'personal', location: 'coding' },
    routes: {
      gitAuthor: 'git-personal',
      providers: { github: 'gh-personal' },
      ssh: 'ssh-personal',
      mcp: { allow: [], shareNativeAuth: false as const },
    },
    intendedPolicy: {
      mode: 'project',
      resources: { 'selected-project': 'read-write' as const },
      inputsDigest: hash('c'),
    },
    skillArtifact: createSkillArtifactReference({
      runtime: 'pi',
      identity: 'personal',
      projectId: 'sample/app',
      repositoryId: 'sample/repo',
      catalogHash: hash('1'),
      selection: {
        location: { name: 'coding', canonicalRoot: 'C:/project' },
        packs: ['development'],
        source: 'project',
      },
    }),
    elevationAudit: {
      elevated: executor === 'host',
      reason: executor === 'host' ? 'Legacy tool' : null,
      approvalsDigest:
        executor === 'host' ? hash('d') : sha256Canonical({ unrestricted: null, host: null }),
      banner:
        executor === 'host'
          ? {
              code: 'ELEVATED_LAUNCH' as const,
              persistent: true as const,
              message: 'ELEVATED LAUNCH — host-compatibility — Legacy tool',
            }
          : null,
    },
  };
  return {
    ...tuple,
    launchKey: sha256Canonical(tuple as unknown as JsonValue),
  } as LaunchDescriptor;
}

function descriptorWithNativeRoot(
  runtime: 'claude' | 'pi',
  identity: 'personal' | 'work',
  root: string,
): LaunchDescriptor {
  const base = descriptor();
  const tuple = {
    ...base,
    runtime,
    identity: { name: identity, domain: identity },
    skillArtifact: createSkillArtifactReference({
      runtime,
      identity,
      projectId: base.binding.projectId,
      repositoryId: base.binding.repositoryId,
      catalogHash: hash('1'),
      selection: base.selection,
    }),
    nativeRuntimeRootDigest: sha256Canonical(
      root.replaceAll('\\', '/').toLowerCase().replace(/\/$/u, ''),
    ),
  };
  const { launchKey: _discarded, ...identityTuple } = tuple;
  return {
    ...identityTuple,
    launchKey: sha256Canonical(identityTuple as unknown as JsonValue),
  } as LaunchDescriptor;
}

function routesFor(value: LaunchDescriptor): Readonly<Record<string, string>> {
  return {
    [`git:${value.routes.gitAuthor}`]: `C:/state/routes/git/${value.routes.gitAuthor}`,
    ...Object.fromEntries(
      Object.entries(value.routes.providers).map(([provider, label]) => [
        `provider-${provider}:${label}`,
        `C:/state/routes/provider/${provider}/${label}`,
      ]),
    ),
    ...(value.routes.ssh
      ? { [`ssh:${value.routes.ssh}`]: `C:/state/routes/ssh/${value.routes.ssh}` }
      : {}),
    ...Object.fromEntries(
      value.routes.mcp.allow.map((label) => [`mcp:${label}`, `C:/state/routes/mcp/${label}`]),
    ),
  };
}
describe('execution gates', () => {
  it('rejects an initially unavailable executor before route or process effects', async () => {
    const effects: string[] = [];
    const executors = new ExecutorRegistry();
    executors.register({
      name: 'docker',
      assertReady: async () => {
        throw new ExecutionError('EXECUTOR_UNAVAILABLE', 'Docker is unavailable.');
      },
      execute: async () => {
        effects.push('process');
        return { exitCode: 0, stdout: '', stderr: '', truncated: false };
      },
    });
    const runtimes = new RuntimeAdapterRegistry();
    runtimes.register({
      runtime: 'pi',
      prepare: async () => ({ executable: 'C:/trusted/pi.exe', argv: [], environment: {} }),
    });
    const execution = new ExecutionService({
      executors,
      runtimes,
      routes: {
        materialize: async () => {
          effects.push('routes');
          return {};
        },
      },
    });

    await expect(
      execution.execute({
        artifact: artifactReference(),
        descriptor: descriptor(),
        cwd: 'C:/project',
        environment: {},
      }),
    ).rejects.toMatchObject({ code: 'EXECUTOR_UNAVAILABLE' });
    expect(effects).toEqual([]);
  });

  it('admits an exactly launch-bound runtime capability and rejects stale authority before side effects', async () => {
    const effects: string[] = [];
    const selected = descriptor();
    const capability = createRuntimeCapabilityManifest({
      runtime: selected.runtime,
      launchKey: selected.launchKey,
      identity: { ...selected.identity, nativeRuntimeRootDigest: selected.nativeRuntimeRootDigest },
      binding: { ...selected.binding, selection: selected.selection },
      executor: selected.executor.name,
      tools: [],
      routes: [],
      resources: [],
      mounts: [],
      destinations: [],
      skills: [],
      models: [],
      nesting: { depth: 0, maxDepth: 0 },
    });
    const executors = new ExecutorRegistry();
    executors.register({
      name: 'docker',
      assertReady: async () => {
        effects.push('verify');
        return undefined;
      },
      execute: async () => ({ exitCode: 0, stdout: '', stderr: '', truncated: false }),
    });
    const runtimes = new RuntimeAdapterRegistry();
    runtimes.register({
      runtime: 'pi',
      prepare: async () => ({ executable: 'C:/trusted/pi.exe', argv: [], environment: {} }),
    });
    const execution = new ExecutionService({
      executors,
      runtimes,
      routes: { materialize: async (value) => routesFor(value) },
    });
    await expect(
      execution.execute({
        artifact: artifactReference(),
        descriptor: selected,
        capability,
        cwd: 'C:/project',
        environment: {},
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    effects.length = 0;
    const executeWithCapability = (candidate: typeof capability) =>
      execution.execute({
        artifact: artifactReference(),
        descriptor: selected,
        capability: candidate,
        cwd: 'C:/project',
        environment: {},
      });
    await expect(
      executeWithCapability({ ...capability, launchKey: hash('f') }),
    ).rejects.toMatchObject({ code: 'RUNTIME_CAPABILITY_INVALID' });
    const {
      manifestKey: _manifestKey,
      schemaVersion: _schemaVersion,
      ...capabilityInput
    } = capability;
    for (const mismatchedSelection of [
      {
        ...selected.selection,
        location: { ...selected.selection.location, canonicalRoot: 'C:/other' },
      },
      { ...selected.selection, packs: ['personal'] as const },
      { ...selected.selection, source: 'user-location' as const },
    ]) {
      await expect(
        executeWithCapability(
          createRuntimeCapabilityManifest({
            ...capabilityInput,
            binding: { ...selected.binding, selection: mismatchedSelection },
          }),
        ),
      ).rejects.toMatchObject({ code: 'RUNTIME_CAPABILITY_INVALID' });
    }
    await expect(
      executeWithCapability({ ...capability, schemaVersion: 1 } as unknown as typeof capability),
    ).rejects.toMatchObject({ code: 'RUNTIME_CAPABILITY_INVALID' });
    expect(effects).toEqual([]);
  });

  it('cleans up a prepared runtime when the final readiness gate fails before process invocation', async () => {
    const effects: string[] = [];
    let readiness = 0;
    const executors = new ExecutorRegistry();
    executors.register({
      name: 'docker',
      assertReady: async () => {
        readiness += 1;
        effects.push(`ready:${readiness}`);
        if (readiness === 2) {
          throw new ExecutionError('EXECUTOR_UNAVAILABLE', 'Docker became unavailable.');
        }
      },
      execute: async () => {
        effects.push('process');
        return { exitCode: 0, stdout: '', stderr: '', truncated: false };
      },
    });
    const runtimes = new RuntimeAdapterRegistry();
    runtimes.register({
      runtime: 'pi',
      prepare: async () => {
        effects.push('prepared');
        return {
          executable: 'C:/trusted/pi.exe',
          argv: [],
          environment: {},
          shutdown: async () => {
            effects.push('cleanup');
          },
        };
      },
    });
    const execution = new ExecutionService({
      executors,
      runtimes,
      routes: { materialize: async (value) => routesFor(value) },
    });

    await expect(
      execution.execute({
        artifact: artifactReference(),
        descriptor: descriptor(),
        cwd: 'C:/project',
        environment: {},
      }),
    ).rejects.toMatchObject({ code: 'EXECUTOR_UNAVAILABLE' });
    expect(effects).toContain('prepared');
    expect(effects).toContain('cleanup');
    expect(effects).not.toContain('process');
  });

  it('executes Pi through the exact selected Docker executor without host process authority', async () => {
    const effects: string[] = [];
    const executors = new ExecutorRegistry();
    executors.register({
      name: 'docker',
      assertReady: async () => undefined,
      execute: async (request) => {
        effects.push(`process:${request.executable}`);
        expect(request.timeoutMs).toBeUndefined();
        return { exitCode: 0, stdout: 'ok', stderr: '', truncated: false };
      },
    });
    const runtimes = new RuntimeAdapterRegistry();
    runtimes.register({
      runtime: 'pi',
      prepare: async () => ({
        executable: 'C:/trusted/node.exe',
        argv: ['C:/trusted/pi.mjs'],
        environment: {},
      }),
    });
    const execution = new ExecutionService({
      executors,
      runtimes,
      routes: {
        materialize: async (value) => {
          effects.push('routes');
          return routesFor(value);
        },
      },
    });
    await expect(
      execution.execute({
        artifact: artifactReference(),
        descriptor: descriptor(),
        cwd: 'C:/project',
        environment: {},
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(effects).toEqual(['routes', 'process:C:/trusted/node.exe']);
  });

  it('rejects non-TTY host execution before route or process access and binds one approval to the exact request', async () => {
    const effects: string[] = [];
    const approvals = new HostApprovalStore();
    const hostDescriptor = descriptor('host');
    const executors = new ExecutorRegistry();
    executors.register({
      name: 'host',
      assertReady: async () => undefined,
      execute: async () => {
        effects.push('process');
        return { exitCode: 0, stdout: '', stderr: '', truncated: false };
      },
    });
    const runtimes = new RuntimeAdapterRegistry();
    runtimes.register({
      runtime: 'pi',
      prepare: async () => {
        effects.push('runtime');
        return { executable: 'C:/trusted/pi.exe', argv: [], environment: {} };
      },
    });
    const execution = new ExecutionService({
      executors,
      runtimes,
      approvals,
      routes: {
        materialize: async (value) => {
          effects.push('routes');
          return routesFor(value);
        },
      },
    });
    await expect(
      execution.execute({
        artifact: artifactReference(),
        descriptor: hostDescriptor,
        cwd: 'C:/project',
        environment: {},
        tty: { direct: false, confirm: vi.fn() },
      }),
    ).rejects.toMatchObject({ code: 'HOST_TTY_REQUIRED' });
    expect(effects).toEqual([]);
    const request = execution.hostApprovalRequest(
      { descriptor: hostDescriptor, cwd: 'C:/project', environment: {} },
      'nonce-1',
    );
    const approval = await approvals.approve(request, { direct: true, confirm: async () => true });
    await expect(
      execution.execute({
        artifact: artifactReference(),
        descriptor: hostDescriptor,
        cwd: 'C:/other',
        environment: {},
        hostApproval: approval,
        tty: { direct: true, confirm: async () => true },
      }),
    ).rejects.toMatchObject({ code: 'HOST_APPROVAL_MISMATCH' });
    expect(effects).toEqual([]);
  });
});

describe('trust and privacy boundaries', () => {
  it('locates only trusted absolute executables and Node entries, rejecting project wrappers and mpx shims', async () => {
    const inspect = async (file: string) => ({
      file: true,
      realpath: file,
      content: file.endsWith('mpx') ? '#!/bin/sh\nmpx pi' : '',
    });
    await expect(
      locateTrustedExecutable({
        candidates: ['C:/project/node_modules/.bin/pi.cmd', 'C:/trusted/mpx', 'C:/trusted/pi.mjs'],
        projectRoot: 'C:/project',
        trustedRoots: ['C:/trusted'],
        nodeExecutable: 'C:/trusted/node.exe',
        platform: 'linux',
        inspect,
      }),
    ).resolves.toEqual({ executable: 'C:/trusted/node.exe', argvPrefix: ['C:/trusted/pi.mjs'] });
    await expect(
      locateTrustedExecutable({
        candidates: ['pi'],
        projectRoot: 'C:/project',
        trustedRoots: ['C:/trusted'],
        nodeExecutable: 'C:/trusted/node.exe',
        platform: 'linux',
        inspect,
      }),
    ).rejects.toMatchObject({ code: 'TRUSTED_EXECUTABLE_NOT_FOUND' });
  });

  it('resolves the accepted FNM Pi wrapper through its Windows node.exe sibling', async () => {
    const directory = 'C:/Users/snapy/AppData/Roaming/fnm/node-versions/v22.23.1/installation';
    const wrapper = `#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")\n\ncase \`uname\` in\n    *CYGWIN*|*MINGW*|*MSYS*)\n        if command -v cygpath > /dev/null 2>&1; then\n            basedir=\`cygpath -w "$basedir"\`\n        fi\n    ;;\nesac\n\nif [ -x "$basedir/node" ]; then\n  exec "$basedir/node"  "$basedir/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" "$@"\nelse \n  exec node  "$basedir/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" "$@"\nfi\n`;
    const files = new Map([
      [`${directory}/pi`, wrapper],
      [`${directory}/node.exe`, undefined],
      [`${directory}/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`, undefined],
    ]);

    await expect(
      locateTrustedExecutable({
        candidates: [`${directory}/pi`],
        projectRoot: 'C:/_MP_projects/mpx',
        trustedRoots: ['C:/Users/snapy/AppData/Roaming/fnm'],
        nodeExecutable: 'C:/Program Files/nodejs/node.exe',
        knownWrapper: 'pi-fnm',
        platform: 'win32',
        inspect: async (file) => {
          if (!files.has(file)) {
            throw new Error('missing');
          }
          const content = files.get(file);
          return content === undefined
            ? { file: true, realpath: file }
            : { file: true, realpath: file, content };
        },
      }),
    ).resolves.toEqual({
      executable: `${directory}/node.exe`,
      argvPrefix: [`${directory}/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`],
    });
  });

  it('admits only the exact running Windows FNM Pi installation when the home directory is the project root', async () => {
    const home = 'C:/Users/snapy';
    const directory = `${home}/AppData/Roaming/fnm/node-versions/v22/installation`;
    const wrapper = `#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")\nexec "$basedir/node" "$basedir/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" "$@"\n`;
    const cli = `${directory}/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`;
    const files = new Map<string, { realpath: string; content?: string }>([
      [`${directory}/pi`, { realpath: `${directory}/pi`, content: wrapper }],
      [`${directory}/node.exe`, { realpath: `${directory}/node.exe` }],
      [cli, { realpath: cli }],
    ]);
    const resolve = (overrides: Partial<Parameters<typeof locateTrustedExecutable>[0]> = {}) =>
      locateTrustedExecutable({
        candidates: [`${directory}/pi`],
        projectRoot: home,
        homeDirectory: home,
        trustedRoots: [`${home}/AppData/Roaming/fnm`],
        nodeExecutable: `${directory}/node.exe`,
        platform: 'win32',
        knownWrapper: 'pi-fnm',
        inspect: async (file) => {
          const entry = files.get(file);
          if (!entry) {
            throw new Error('missing');
          }
          return { file: true, ...entry };
        },
        ...overrides,
      });

    await expect(resolve()).resolves.toEqual({
      executable: `${directory}/node.exe`,
      argvPrefix: [cli],
    });

    const rejectExistingCandidate = async (candidate: string, content?: string) =>
      expect(
        resolve({
          candidates: [candidate],
          inspect: async (file) => {
            if (file === candidate) {
              return { file: true, realpath: file, ...(content ? { content } : {}) };
            }
            const entry = files.get(file);
            if (!entry) {
              throw new Error('missing');
            }
            return { file: true, ...entry };
          },
        }),
      ).rejects.toMatchObject({ code: 'TRUSTED_EXECUTABLE_NOT_FOUND' });
    await rejectExistingCandidate(`${directory}/pi`); // binary named pi
    await rejectExistingCandidate(`${directory}/arbitrary.js`, 'console.log("not Pi")');
    await rejectExistingCandidate(`${directory}/pi`, `${wrapper}echo forged\n`);
    await expect(resolve({ projectRoot: directory })).rejects.toMatchObject({
      code: 'TRUSTED_EXECUTABLE_NOT_FOUND',
    });
    await expect(resolve({ nodeExecutable: `${directory}/other-node.exe` })).rejects.toMatchObject({
      code: 'TRUSTED_EXECUTABLE_NOT_FOUND',
    });

    files.set(`${directory}/node`, { realpath: `${directory}/node` });
    await expect(resolve()).rejects.toMatchObject({ code: 'TRUSTED_EXECUTABLE_NOT_FOUND' });
    files.delete(`${directory}/node`);
    files.set(cli, { realpath: `${home}/escaped/cli.js` });
    await expect(resolve()).rejects.toMatchObject({ code: 'TRUSTED_EXECUTABLE_NOT_FOUND' });
    files.set(cli, { realpath: cli });
    files.set(`${directory}/node.exe`, { realpath: `${home}/escaped/node.exe` });
    await expect(resolve()).rejects.toMatchObject({ code: 'TRUSTED_EXECUTABLE_NOT_FOUND' });
    files.set(`${directory}/node.exe`, { realpath: `${directory}/node.exe` });
    files.set(`${directory}/pi`, { realpath: `${directory}/forged/pi`, content: wrapper });
    await expect(resolve()).rejects.toMatchObject({ code: 'TRUSTED_EXECUTABLE_NOT_FOUND' });
  });

  it('rejects an accepted Windows FNM Pi wrapper when node siblings conflict', async () => {
    const wrapper = `#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")\nexec "$basedir/node" "$basedir/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" "$@"\n`;
    await expect(
      locateTrustedExecutable({
        candidates: ['C:/fnm/pi'],
        projectRoot: 'C:/project',
        trustedRoots: ['C:/fnm'],
        nodeExecutable: 'C:/other/node.exe',
        platform: 'win32',
        knownWrapper: 'pi-fnm',
        inspect: async (file) => ({
          file: true,
          realpath: file,
          ...(file === 'C:/fnm/pi' ? { content: wrapper } : {}),
        }),
      }),
    ).rejects.toMatchObject({ code: 'TRUSTED_EXECUTABLE_NOT_FOUND' });
  });

  it('recognizes only the exact bounded FNM Pi POSIX wrapper', async () => {
    const wrapper = `#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")\nexec "$basedir/node" "$basedir/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" "$@"\n`;
    const npmStyleWrapper = `#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")\n\ncase \`uname\` in\n    *CYGWIN*|*MINGW*|*MSYS*)\n        if command -v cygpath > /dev/null 2>&1; then\n            basedir=\`cygpath -w "$basedir"\`\n        fi\n    ;;\nesac\n\nif [ -x "$basedir/node" ]; then\n  exec "$basedir/node"  "$basedir/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" "$@"\nelse \n  exec node  "$basedir/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" "$@"\nfi\n`;
    const inspectWrapper = (content: string) => async (file: string) => ({
      file: true,
      realpath: file,
      ...(file === 'C:/fnm/pi' ? { content } : {}),
    });
    await expect(
      locateTrustedExecutable({
        candidates: ['C:/fnm/pi'],
        projectRoot: 'C:/project',
        trustedRoots: ['C:/fnm'],
        nodeExecutable: 'C:/fnm/node.exe',
        platform: 'linux',
        inspect: inspectWrapper(wrapper),
      }),
    ).rejects.toMatchObject({ code: 'TRUSTED_EXECUTABLE_NOT_FOUND' });
    for (const accepted of [wrapper, npmStyleWrapper]) {
      await expect(
        locateTrustedExecutable({
          candidates: ['C:/fnm/pi'],
          projectRoot: 'C:/project',
          trustedRoots: ['C:/fnm'],
          nodeExecutable: 'C:/fnm/node.exe',
          platform: 'linux',
          knownWrapper: 'pi-fnm',
          inspect: inspectWrapper(accepted),
        }),
      ).resolves.toEqual({
        executable: 'C:/fnm/node',
        argvPrefix: ['C:/fnm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'],
      });
    }
    for (const malicious of [
      wrapper.replace('"$@"', '"$@"; calc'),
      npmStyleWrapper.replace('exec node  ', 'exec calc  '),
      '#!/bin/sh\nexec node evil.js "$@"\n',
    ]) {
      await expect(
        locateTrustedExecutable({
          candidates: ['C:/fnm/pi'],
          projectRoot: 'C:/project',
          trustedRoots: ['C:/fnm'],
          nodeExecutable: 'C:/fnm/node.exe',
          platform: 'linux',
          knownWrapper: 'pi-fnm',
          inspect: inspectWrapper(malicious),
        }),
      ).rejects.toMatchObject({ code: 'TRUSTED_EXECUTABLE_NOT_FOUND' });
    }
  });

  it('does not publish obsolete private-route writer APIs', async () => {
    const exports = await import('../../src/index.js');
    expect(exports).not.toHaveProperty('materializePrivateRoutes');
    expect(exports).not.toHaveProperty('PrivateRouteStore');
  });

  it('sanitizes host reasons and launch audits without leaking raw paths or tokens', async () => {
    const reason = 'Need C:/private/repo token=abc123 for restart';
    expect(sanitizeHostReason(reason)).toContain('[path]');
    expect(sanitizeHostReason(reason)).toContain('token=[redacted]');
    expect(sanitizeHostReason(reason)).not.toContain('C:/private/repo');
    expect(sanitizeHostReason(reason)).not.toContain('abc123');

    const approvals = new HostApprovalStore();
    const execution = new ExecutionService({
      executors: new ExecutorRegistry(),
      runtimes: new RuntimeAdapterRegistry(),
      routes: { materialize: async () => ({}) },
      approvals,
    });
    const hostDescriptor = descriptor('host');
    const sanitizedReason = sanitizeHostReason(reason);
    const descriptorTuple = {
      ...hostDescriptor,
      elevationAudit: {
        ...hostDescriptor.elevationAudit,
        reason: sanitizedReason,
        banner: {
          code: 'ELEVATED_LAUNCH' as const,
          persistent: true as const,
          message: `ELEVATED LAUNCH — host-compatibility — ${sanitizedReason}`,
        },
      },
    } as const;
    const { launchKey: _discardedLaunchKey, ...descriptorIdentity } = descriptorTuple;
    const descriptorReason = {
      ...descriptorIdentity,
      launchKey: sha256Canonical(descriptorIdentity as unknown as JsonValue),
    } as LaunchDescriptor;
    const request = execution.hostApprovalRequest(
      { descriptor: descriptorReason, cwd: 'C:/project', environment: {} },
      'nonce-1',
    );
    expect(request.reason).toBe(sanitizedReason);
    expect(request.reason).not.toContain('C:/private/repo');
    expect(request.reason).not.toContain('abc123');
    expect(
      JSON.stringify(createLaunchExecutionAudit(descriptorReason, { started: true })),
    ).not.toContain('C:/private/repo');
    expect(
      JSON.stringify(createLaunchExecutionAudit(descriptorReason, { started: true })),
    ).not.toContain('abc123');
  });

  it('rejects missing private routes before runtime preparation or process execution', async () => {
    const effects: string[] = [];
    const executors = new ExecutorRegistry();
    executors.register({
      name: 'docker',
      assertReady: async () => undefined,
      execute: async () => {
        effects.push('process');
        return { exitCode: 0, stdout: '', stderr: '', truncated: false };
      },
    });
    const runtimes = new RuntimeAdapterRegistry();
    runtimes.register({
      runtime: 'pi',
      prepare: async () => {
        effects.push('runtime');
        return { executable: 'C:/trusted/pi.exe', argv: [], environment: {} };
      },
    });
    const execution = new ExecutionService({
      executors,
      runtimes,
      routes: { materialize: async () => ({}) },
    });

    await expect(
      execution.execute({
        artifact: artifactReference(),
        descriptor: descriptor(),
        cwd: 'C:/project',
        environment: {},
      }),
    ).rejects.toMatchObject({ code: 'PRIVATE_ROUTE_MISSING' });
    expect(effects).toEqual([]);
  });

  it('rejects unsafe private-route paths before runtime preparation or process execution', async () => {
    const effects: string[] = [];
    const executors = new ExecutorRegistry();
    executors.register({
      name: 'docker',
      assertReady: async () => undefined,
      execute: async () => {
        effects.push('process');
        return { exitCode: 0, stdout: '', stderr: '', truncated: false };
      },
    });
    const runtimes = new RuntimeAdapterRegistry();
    runtimes.register({
      runtime: 'pi',
      prepare: async () => {
        effects.push('runtime');
        return { executable: 'C:/trusted/pi.exe', argv: [], environment: {} };
      },
    });
    const execution = new ExecutionService({
      executors,
      runtimes,
      routes: {
        materialize: async () => ({
          ...routesFor(descriptor()),
          'git:git-personal': 'relative/path',
        }),
      },
    });

    await expect(
      execution.execute({
        artifact: artifactReference(),
        descriptor: descriptor(),
        cwd: 'C:/project',
        environment: {},
      }),
    ).rejects.toMatchObject({ code: 'PRIVATE_ROUTE_PATH_INVALID' });
    expect(effects).toEqual([]);
  });

  it('rejects Docker Pi MCP immediately after executor evidence precheck without side effects', async () => {
    const selected = descriptor();
    const tuple = {
      ...selected,
      routes: { ...selected.routes, mcp: { allow: ['context7'], shareNativeAuth: false as const } },
    };
    const { launchKey: _old, ...body } = tuple;
    const rebound = {
      ...body,
      launchKey: sha256Canonical(body as unknown as JsonValue),
    } as LaunchDescriptor;
    const effects: string[] = [];
    const executors = new ExecutorRegistry();
    executors.register({
      name: 'docker',
      assertReady: async () => undefined,
      execute: async () => {
        effects.push('process');
        return { exitCode: 0, stdout: '', stderr: '', truncated: false };
      },
    });
    const runtimes = new RuntimeAdapterRegistry();
    runtimes.register({
      runtime: 'pi',
      prepare: async () => {
        effects.push('runtime');
        return { executable: 'C:/trusted/pi.exe', argv: [], environment: {} };
      },
    });
    const audit: LaunchAuditStore = {
      start: async () => {
        effects.push('audit');
        return 'attempt';
      },
      terminal: async () => {
        effects.push('audit');
      },
    };
    const execution = new ExecutionService({
      executors,
      runtimes,
      audit,
      routes: {
        materialize: async () => {
          effects.push('routes');
          return routesFor(rebound);
        },
      },
    });

    await expect(
      execution.execute({
        descriptor: rebound,
        artifact: artifactReference(),
        cwd: 'C:/project',
        environment: {},
      }),
    ).rejects.toMatchObject({
      code: 'RUNTIME_CAPABILITY_UNSUPPORTED',
      details: { runtime: 'pi', capability: 'mcp', remediation: expect.any(String) },
    });

    expect(effects).toEqual([]);
  });

  it('rejects Host Pi MCP without approval, route, audit, runtime, or process effects and preserves the approval token', async () => {
    const selected = descriptor('host');
    const tuple = {
      ...selected,
      routes: { ...selected.routes, mcp: { allow: ['context7'], shareNativeAuth: false as const } },
    };
    const { launchKey: _old, ...body } = tuple;
    const rebound = {
      ...body,
      launchKey: sha256Canonical(body as unknown as JsonValue),
    } as LaunchDescriptor;
    const effects: string[] = [];
    const executors = new ExecutorRegistry();
    executors.register({
      name: 'host',
      assertReady: async () => undefined,
      execute: async () => {
        effects.push('process');
        return { exitCode: 0, stdout: '', stderr: '', truncated: false };
      },
    });
    const runtimes = new RuntimeAdapterRegistry();
    runtimes.register({
      runtime: 'pi',
      prepare: async () => {
        effects.push('runtime');
        return { executable: 'C:/trusted/pi.exe', argv: [], environment: {} };
      },
    });
    const approvals = new HostApprovalStore();
    const confirm = vi.fn(async () => true);
    const tty = { direct: true, confirm };
    const audit: LaunchAuditStore = {
      start: async () => {
        effects.push('audit');
        return 'attempt';
      },
      terminal: async () => {
        effects.push('audit');
      },
    };
    const execution = new ExecutionService({
      executors,
      runtimes,
      approvals,
      audit,
      routes: {
        materialize: async () => {
          effects.push('routes');
          return routesFor(rebound);
        },
      },
    });
    const approvalRequest = execution.hostApprovalRequest(
      { descriptor: rebound, cwd: 'C:/project', environment: {} },
      'nonce',
    );
    const approval = await approvals.approve(approvalRequest, tty);
    confirm.mockClear();
    const consume = vi.spyOn(approvals, 'consume');

    await expect(
      execution.execute({
        descriptor: rebound,
        artifact: artifactReference(),
        cwd: 'C:/project',
        environment: {},
        hostApproval: approval,
        tty,
      }),
    ).rejects.toMatchObject({
      code: 'RUNTIME_CAPABILITY_UNSUPPORTED',
      details: { runtime: 'pi', capability: 'mcp', remediation: expect.any(String) },
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(effects).toEqual([]);
    expect(() => approvals.consume(approvalRequest, approval)).not.toThrow();
  });

  it('continues to execute Claude descriptors that select MCP routes', async () => {
    const selected = descriptorWithNativeRoot('claude', 'personal', 'C:/accounts/personal/claude');
    const tuple = {
      ...selected,
      routes: { ...selected.routes, mcp: { allow: ['context7'], shareNativeAuth: false as const } },
    };
    const { launchKey: _old, ...body } = tuple;
    const rebound = {
      ...body,
      launchKey: sha256Canonical(body as unknown as JsonValue),
    } as LaunchDescriptor;
    const effects: string[] = [];
    const executors = new ExecutorRegistry();
    executors.register({
      name: 'docker',
      assertReady: async () => undefined,
      execute: async () => {
        effects.push('process');
        return { exitCode: 0, stdout: '', stderr: '', truncated: false };
      },
    });
    const runtimes = new RuntimeAdapterRegistry();
    runtimes.register({
      runtime: 'claude',
      prepare: async ({ routes }) => {
        effects.push(`runtime:${routes['mcp:context7']}`);
        return { executable: 'C:/trusted/claude.exe', argv: [], environment: {} };
      },
    });
    const execution = new ExecutionService({
      executors,
      runtimes,
      routes: {
        materialize: async () => {
          effects.push('routes');
          return routesFor(rebound);
        },
      },
    });

    await expect(
      execution.execute({
        descriptor: rebound,
        artifact: artifactReference('claude'),
        cwd: 'C:/project',
        environment: {},
      }),
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(effects).toEqual(['routes', 'runtime:C:/state/routes/mcp/context7', 'process']);
  });

  it('scrubs secrets while preserving only allowlisted OS, terminal, launch-context, and root variables', () => {
    expect(
      sanitizedEnvironment(
        {
          PATH: 'safe',
          TERM: 'xterm',
          HOME: 'C:/home',
          MPX_LAUNCH_KEY: 'key',
          MPX_SESSION_LIFECYCLE_BINDING_ID: 'ambient-binding',
          MPX_SESSION_LIFECYCLE_EVENT_DIR: 'C:/ambient/events',
          CLAUDE_CONFIG_DIR: 'C:/ambient/claude',
          PI_CODING_AGENT_DIR: 'C:/ambient/pi',
          TOKEN: 'secret',
          API_KEY: 'secret',
          APPROVAL_NONCE: 'secret',
          RANDOM: 'drop',
        },
        {
          MPX_RUNTIME_ROOT: 'C:/state/runtime',
          MPX_SESSION_LIFECYCLE_BINDING_ID: 'trusted-binding',
          MPX_SESSION_LIFECYCLE_EVENT_DIR: 'C:/trusted/events',
          MPX_SESSION_UNRECOGNIZED: 'drop',
          CLAUDE_CONFIG_DIR: 'C:/adapter/claude',
          PI_CODING_AGENT_DIR: 'C:/adapter/pi',
        },
      ),
    ).toEqual({
      PATH: 'safe',
      TERM: 'xterm',
      HOME: 'C:/home',
      MPX_LAUNCH_KEY: 'key',
      MPX_RUNTIME_ROOT: 'C:/state/runtime',
      MPX_SESSION_LIFECYCLE_BINDING_ID: 'trusted-binding',
      MPX_SESSION_LIFECYCLE_EVENT_DIR: 'C:/trusted/events',
    });
  });

  it.each(['ProgramData', 'PROGRAMDATA'])(
    'preserves %s for Windows OpenSSH startup without forwarding SSH overrides',
    (key) => {
      expect(
        sanitizedEnvironment(
          { [key]: 'C:/ProgramData', GIT_SSH_COMMAND: 'untrusted', SSH_AUTH_SOCK: 'ambient' },
          {},
        ),
      ).toEqual({ [key]: 'C:/ProgramData' });
    },
  );

  it.each([
    'MPX_RUNTIME',
    'MPX_ACTIVE_CONTENT_ROOT',
    'MPX_ACTIVE_CONTENT_MANIFEST',
    'MPX_ACTIVE_CONTENT_MANIFEST_INTEGRITY',
    'MPX_COMPILED_AGENTS_DIR',
    'MPX_IDENTITY',
    'MPX_MODE',
    'MPX_REPOSITORY_PROVIDER',
    'MPX_ISSUES_PROVIDER',
  ])('preserves trusted %s skill context without accepting ambient authority', (key) => {
    expect(sanitizedEnvironment({ [key]: 'ambient' }, {})).toEqual({});
    expect(
      sanitizedEnvironment(
        { [key]: 'ambient' },
        { [key]: 'trusted', MPX_ACTIVE_CONTENT_UNKNOWN: 'drop' },
      ),
    ).toEqual({ [key]: 'trusted' });
  });

  it.each([
    ['claude', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR'],
    ['pi', 'PI_CODING_AGENT_DIR', 'CLAUDE_CONFIG_DIR'],
  ] as const)(
    'passes the selected %s native root only through its private child environment channel',
    async (runtime, selectedVariable, otherVariable) => {
      const root = `C:/accounts/personal/${runtime}`;
      const selectedDescriptor = descriptorWithNativeRoot(runtime, 'personal', root);
      const requests: ProcessRequest[] = [];
      const prepareInputs: unknown[] = [];
      const routeMap = routesFor(selectedDescriptor);
      const executors = new ExecutorRegistry();
      executors.register({
        name: 'docker',
        assertReady: async () => undefined,
        execute: async (request) => {
          requests.push(request);
          return { exitCode: 0, stdout: '', stderr: '', truncated: false };
        },
      });
      const runtimes = new RuntimeAdapterRegistry();
      runtimes.register({
        runtime,
        prepare: async (input) => {
          prepareInputs.push(input);
          return {
            executable: 'C:/trusted/runtime.exe',
            argv: ['--safe'],
            environment: {
              [selectedVariable]: 'C:/adapter-controlled',
              [otherVariable]: 'C:/crossed',
              TOKEN: 'secret',
              ARBITRARY: 'drop',
              MPX_REPOSITORY_PROVIDER: 'gitlab',
              MPX_ISSUES_PROVIDER: 'kanbanflow',
            },
          };
        },
      });
      const execution = new ExecutionService({
        executors,
        runtimes,
        routes: { materialize: async () => routeMap },
      });

      await execution.execute({
        artifact: artifactReference(runtime),
        descriptor: selectedDescriptor,
        cwd: 'C:/project',
        environment: {
          [selectedVariable]: 'C:/ambient',
          [otherVariable]: 'C:/ambient-crossed',
          TOKEN: 'ambient-secret',
          APPROVAL_KEY: 'ambient-approval',
          RANDOM: 'drop',
        },
        privateLaunch: {
          launchKey: selectedDescriptor.launchKey,
          runtime,
          identity: selectedDescriptor.identity,
          nativeRuntimeRoot: root,
        },
      });

      expect(requests[0]?.environment).toEqual(
        expect.objectContaining({
          [selectedVariable]: root,
          MPX_REPOSITORY_PROVIDER: 'gitlab',
          MPX_ISSUES_PROVIDER: 'kanbanflow',
        }),
      );
      expect(requests[0]?.environment).toEqual(
        expect.objectContaining(
          runtime === 'claude'
            ? {
                MPX_RUNTIME_ROUTE_GIT_AUTHOR: 'C:/state/routes/git/git-personal',
                MPX_RUNTIME_ROUTE_PROVIDER_GITHUB: 'C:/state/routes/provider/github/gh-personal',
              }
            : {
                MPX_RUNTIME_ROUTE_GIT_AUTHOR: 'C:/state/routes/git/git-personal',
                MPX_RUNTIME_ROUTE_PROVIDER_GITHUB: 'C:/state/routes/provider/github/gh-personal',
              },
        ),
      );
      expect(requests[0]?.environment).toMatchObject({
        GIT_CONFIG_GLOBAL: 'C:/state/routes/git/git-personal/gitconfig',
        GH_CONFIG_DIR: 'C:/state/routes/provider/github/gh-personal',
        GIT_SSH_COMMAND: 'ssh -F "C:/state/routes/ssh/ssh-personal/config"',
      });
      expect(JSON.stringify(prepareInputs)).not.toContain(root);
    },
  );

  it('rejects a work native root bound to a personal descriptor before side effects without disclosing either root', async () => {
    const personalRoot = 'C:/accounts/personal/pi';
    const workRoot = 'C:/accounts/work/pi';
    const selectedDescriptor = descriptorWithNativeRoot('pi', 'personal', personalRoot);
    const effects: string[] = [];
    const executors = new ExecutorRegistry();
    executors.register({
      name: 'docker',
      assertReady: async () => {
        effects.push('verify');
        return undefined;
      },
      execute: async () => {
        effects.push('process');
        return { exitCode: 0, stdout: '', stderr: '', truncated: false };
      },
    });
    const runtimes = new RuntimeAdapterRegistry();
    runtimes.register({
      runtime: 'pi',
      prepare: async () => {
        effects.push('runtime');
        return { executable: 'C:/trusted/pi.exe', argv: [], environment: {} };
      },
    });
    const execution = new ExecutionService({
      executors,
      runtimes,
      routes: {
        materialize: async () => {
          effects.push('routes');
          return {};
        },
      },
    });

    const error = await execution
      .execute({
        artifact: artifactReference(),
        descriptor: selectedDescriptor,
        cwd: 'C:/project',
        environment: {},
        privateLaunch: {
          launchKey: selectedDescriptor.launchKey,
          runtime: 'pi',
          identity: { name: 'work', domain: 'work' },
          nativeRuntimeRoot: workRoot,
        },
      })
      .catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: 'PRIVATE_LAUNCH_BINDING_MISMATCH' });
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      typeof error.code !== 'string'
    ) {
      throw new Error('launch failure did not expose an error code');
    }
    expect(effects).toEqual([]);
    expect(
      JSON.stringify({
        descriptor: selectedDescriptor,
        banner: compactLaunchBanner(selectedDescriptor),
        audit: createLaunchExecutionAudit(selectedDescriptor, {
          started: false,
          errorCode: error.code,
        }),
        error,
      }),
    ).not.toMatch(/accounts[\\/](?:personal|work)/u);
  });

  it('invokes argv-only processes with hard bounds and emits a compact immutable audit', async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', truncated: false }));
    await invokeBoundedProcess(
      { run },
      {
        executable: 'C:/trusted/pi.exe',
        argv: ['--version'],
        cwd: 'C:/project',
        environment: {},
        timeoutMs: 999_999,
        maxOutputBytes: 9_999_999,
      },
    );
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        shell: false,
        timeoutMs: 300_000,
        maxOutputBytes: 1_048_576,
        argv: ['--version'],
      }),
    );
    const audit = createLaunchExecutionAudit(descriptor('host'), {
      started: false,
      errorCode: 'EXECUTOR_UNAVAILABLE',
    });
    expect(audit).toMatchObject({
      schemaVersion: 1,
      executor: 'host',
      outcome: 'failed',
      errorCode: 'EXECUTOR_UNAVAILABLE',
    });
    expect(JSON.stringify(audit)).not.toMatch(/nonce|C:\\/u);
    expect(Object.isFrozen(audit)).toBe(true);
  });
});

describe('persistent launch audit sequencing', () => {
  function auditedExecution(
    audit: LaunchAuditStore,
    effects: string[],
    process: () => Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
      truncated: boolean;
    }> = async () => ({ exitCode: 0, stdout: 'ok', stderr: '', truncated: false }),
  ) {
    const executors = new ExecutorRegistry();
    executors.register({
      name: 'docker',
      assertReady: async () => undefined,
      execute: async () => {
        effects.push('process');
        return process();
      },
    });
    const runtimes = new RuntimeAdapterRegistry();
    runtimes.register({
      runtime: 'pi',
      prepare: async () => ({ executable: 'C:/trusted/pi.exe', argv: [], environment: {} }),
    });
    return new ExecutionService({
      executors,
      runtimes,
      routes: { materialize: async (value) => routesFor(value) },
      audit,
    });
  }

  it('persists a bounded sanitized start record before process execution', async () => {
    const effects: string[] = [];
    const records: LaunchAuditRecord[] = [];
    const audit: LaunchAuditStore = {
      start: async (record) => {
        effects.push('audit:start');
        records.push(record);
        return 'attempt';
      },
      terminal: async () => undefined,
    };
    await auditedExecution(audit, effects).execute({
      artifact: artifactReference(),
      descriptor: descriptor(),
      cwd: 'C:/secret/project',
      environment: { TOKEN: 'secret' },
      approvalNonce: 'nonce',
    });
    expect(effects).toEqual(['audit:start', 'process']);
    expect(records[0]).toMatchObject({
      phase: 'start',
      launchKey: descriptor().launchKey,
      manifestKey: artifactReference().manifestKey,
      artifactKey: artifactReference().artifactKey,
      fileMapHash: artifactReference().fileMapHash,
      runtime: 'pi',
      identity: 'personal',
    });
    expect(JSON.stringify(records[0])).not.toMatch(/secret|TOKEN|nonce|cwd|environment|native/iu);
  });

  it('persists a terminal success result after exactly one process mutation', async () => {
    const effects: string[] = [];
    const records: LaunchAuditRecord[] = [];
    const audit: LaunchAuditStore = {
      start: async (record) => {
        records.push(record);
        return 'attempt';
      },
      terminal: async (_attempt, record) => {
        effects.push('audit:terminal');
        records.push(record);
      },
    };
    await auditedExecution(audit, effects).execute({
      artifact: artifactReference(),
      descriptor: descriptor(),
      cwd: 'C:/project',
      environment: {},
    });
    expect(effects).toEqual(['process', 'audit:terminal']);
    expect(records[1]).toMatchObject({
      phase: 'terminal',
      outcome: 'result',
      exitCode: 0,
      truncated: false,
    });
  });

  it('persists a sanitized terminal failure after a process error', async () => {
    const records: LaunchAuditRecord[] = [];
    const audit: LaunchAuditStore = {
      start: async () => 'attempt',
      terminal: async (_attempt, record) => {
        records.push(record);
      },
    };
    await expect(
      auditedExecution(audit, [], async () => {
        throw Object.assign(new Error('token=secret C:/private'), { code: 'SPAWN_FAILED' });
      }).execute({
        artifact: artifactReference(),
        descriptor: descriptor(),
        cwd: 'C:/project',
        environment: {},
      }),
    ).rejects.toMatchObject({ code: 'SPAWN_FAILED' });
    expect(records[0]).toMatchObject({
      phase: 'terminal',
      outcome: 'failure',
      errorCode: 'SPAWN_FAILED',
    });
    expect(JSON.stringify(records[0])).not.toMatch(/secret|private/iu);
  });

  it('audits a runtime artifact preparation failure after route trust succeeds', async () => {
    const records: LaunchAuditRecord[] = [];
    const audit: LaunchAuditStore = {
      start: async (record) => {
        records.push(record);
        return 'attempt';
      },
      terminal: async (_attempt, record) => {
        records.push(record);
      },
    };
    const executors = new ExecutorRegistry();
    executors.register({
      name: 'docker',
      assertReady: async () => undefined,
      execute: async () => {
        throw new Error('must not execute');
      },
    });
    const runtimes = new RuntimeAdapterRegistry();
    runtimes.register({
      runtime: 'pi',
      prepare: async () => {
        throw Object.assign(new Error('private artifact path'), { code: 'ARTIFACT_INVALID' });
      },
    });
    const execution = new ExecutionService({
      executors,
      runtimes,
      routes: { materialize: async (value) => routesFor(value) },
      audit,
    });
    await expect(
      execution.execute({
        artifact: artifactReference(),
        descriptor: descriptor(),
        cwd: 'C:/project',
        environment: {},
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
    expect(records.map((record) => record.phase)).toEqual(['start', 'terminal']);
    expect(records[1]).toMatchObject({ outcome: 'failure', errorCode: 'ARTIFACT_INVALID' });
  });

  it('fails closed before process execution when the start audit cannot be persisted', async () => {
    const effects: string[] = [];
    const audit: LaunchAuditStore = {
      start: async () => {
        throw new Error('disk unavailable C:/private');
      },
      terminal: async () => undefined,
    };
    await expect(
      auditedExecution(audit, effects).execute({
        artifact: artifactReference(),
        descriptor: descriptor(),
        cwd: 'C:/project',
        environment: {},
      }),
    ).rejects.toMatchObject({ code: 'AUDIT_START_WRITE_FAILED' });
    expect(effects).toEqual([]);
  });

  it('does not retry process mutation or disclose details when terminal persistence is ambiguous', async () => {
    const effects: string[] = [];
    const audit: LaunchAuditStore = {
      start: async () => 'attempt',
      terminal: async () => {
        throw new Error('ambiguous C:/private token=secret');
      },
    };
    const error = await auditedExecution(audit, effects)
      .execute({
        artifact: artifactReference(),
        descriptor: descriptor(),
        cwd: 'C:/project',
        environment: {},
      })
      .catch((reason) => reason);
    expect(error).toMatchObject({ code: 'AUDIT_TERMINAL_WRITE_FAILED' });
    expect(JSON.stringify(error)).not.toMatch(/private|secret/iu);
    expect(effects).toEqual(['process']);
  });

  it('does not write audits before descriptor and trust validation', async () => {
    const writes = vi.fn();
    const audit: LaunchAuditStore = { start: writes, terminal: writes };
    const malformed = { ...descriptor(), launchKey: '0'.repeat(64) } as LaunchDescriptor;
    await expect(
      auditedExecution(audit, []).execute({
        artifact: artifactReference(),
        descriptor: malformed,
        cwd: 'C:/project',
        environment: {},
      }),
    ).rejects.toBeDefined();
    expect(writes).not.toHaveBeenCalled();
  });

  it('rejects symlink escapes at the audit root and every intermediate launch directory', async () => {
    const start = {
      schemaVersion: 1 as const,
      phase: 'start' as const,
      launchKey: 'a'.repeat(64),
      runtime: 'pi' as const,
      executor: 'docker' as const,
      identity: 'work',
      identityDomain: 'work',
      mode: 'project',
      selectionSource: 'project' as const,
      projectId: 'sample/app',
      repositoryId: 'sample/repo',
      manifestKey: 'c'.repeat(64),
      artifactKey: 'b'.repeat(64),
      fileMapHash: 'd'.repeat(64),
      elevated: false,
      reason: null,
    };
    for (const level of ['root', 'launch-audits', 'prefix', 'launch'] as const) {
      const parent = await mkdtemp(path.join(tmpdir(), `mpx-audit-link-${level}-`));
      const outside = await mkdtemp(path.join(tmpdir(), 'mpx-audit-outside-'));
      try {
        let root = path.join(parent, 'state');
        if (level === 'root') {
          await symlink(outside, root, 'dir');
        } else {
          await mkdir(root);
          const segments = ['launch-audits', 'aa', start.launchKey];
          const index = level === 'launch-audits' ? 0 : level === 'prefix' ? 1 : 2;
          let directory = root;
          for (let segment = 0; segment < index; segment += 1) {
            const name = segments[segment];
            if (!name) {
              throw new Error('audit path fixture is incomplete');
            }
            directory = path.join(directory, name);
            await mkdir(directory);
          }
          const linkName = segments[index];
          if (!linkName) {
            throw new Error('audit link fixture is incomplete');
          }
          await symlink(outside, path.join(directory, linkName), 'dir');
        }
        await expect(new FileLaunchAuditStore(root).start(start)).rejects.toMatchObject({
          code: 'AUDIT_PATH_INVALID',
        });
        expect(await readdir(outside)).toEqual([]);
      } finally {
        await rm(parent, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    }
  });

  it('persists immutable exclusive production records under an injectable local root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-audit-'));
    try {
      const store = new FileLaunchAuditStore(root);
      const start = {
        schemaVersion: 1 as const,
        phase: 'start' as const,
        launchKey: 'a'.repeat(64),
        runtime: 'pi' as const,
        executor: 'docker' as const,
        identity: 'work',
        identityDomain: 'work',
        mode: 'project',
        selectionSource: 'project' as const,
        projectId: 'sample/app',
        repositoryId: 'sample/repo',
        manifestKey: 'c'.repeat(64),
        artifactKey: 'b'.repeat(64),
        fileMapHash: 'd'.repeat(64),
        elevated: false,
        reason: null,
      };
      const attempt = await store.start(start);
      const terminal = {
        schemaVersion: 1 as const,
        phase: 'terminal' as const,
        launchKey: start.launchKey,
        outcome: 'result' as const,
        exitCode: 0,
        truncated: false,
        errorCode: null,
      };
      await store.terminal(attempt, terminal);
      await expect(store.terminal(attempt, terminal)).rejects.toMatchObject({ code: 'EEXIST' });
      const directory = path.join(root, 'launch-audits', 'aa', start.launchKey);
      const files = await readdir(directory);
      expect(files).toHaveLength(2);
      expect(
        await Promise.all(files.map((file) => readFile(path.join(directory, file), 'utf8'))),
      ).toEqual(
        expect.arrayContaining([`${JSON.stringify(start)}\n`, `${JSON.stringify(terminal)}\n`]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

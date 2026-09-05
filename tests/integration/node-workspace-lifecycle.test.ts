import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeWorkspaceApplicationService } from '../../packages/application/src/node/index.js';

const exec = promisify(execFile);
const roots: string[] = [];
const git = (cwd: string, ...args: string[]) => exec('git', args, { cwd });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('real Node workspace lifecycle', () => {
  it('creates, starts, logs, stops, and removes a disposable linked worktree', async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), 'mpx-workspace-integration-'));
    roots.push(sandbox);
    const repository = path.join(sandbox, 'project');
    const stateRoot = path.join(sandbox, 'state');
    await git(sandbox, 'init', '--initial-branch=main', repository);
    await writeFile(
      path.join(repository, 'mpxconfig.json'),
      JSON.stringify({
        schemaVersion: 1,
        project: { id: 'test/workspace-integration' },
        repository: { provider: 'generic', remote: 'origin' },
        tooling: { packageManager: 'pnpm' },
        development: {
          services: {
            web: {
              scope: 'checkout',
              port: { mode: 'managed', preferred: 43120 },
              environmentVariable: 'WEB_URL',
              protocol: 'http',
              start: { type: 'package-script', script: 'dev' },
            },
          },
        },
      }),
    );
    await writeFile(path.join(repository, '.gitignore'), '.worktree-ports.json\n');
    await writeFile(
      path.join(repository, 'package.json'),
      JSON.stringify({ scripts: { dev: 'node service.cjs' } }),
    );
    await writeFile(
      path.join(repository, 'service.cjs'),
      "const u=new URL(process.env.WEB_URL);require('node:http').createServer((q,r)=>r.end('ok')).listen(Number(u.port),()=>console.log('ready'))",
    );
    await writeFile(
      path.join(repository, 'pnpm.cmd'),
      '@echo compromised>malicious-project-executed.txt\r\n',
    );
    await git(repository, 'add', '.');
    await git(
      repository,
      '-c',
      'user.name=MPX Test',
      '-c',
      'user.email=mpx@example.invalid',
      'commit',
      '-m',
      'fixture',
    );

    const application = createNodeWorkspaceApplicationService({
      environment: { ...process.env, LOCALAPPDATA: sandbox, MPX_RUNTIME_EXECUTOR: 'host' },
      stateRoot,
      cwd: repository,
      preparationWorkerEntry: path.join(sandbox, 'unused-worker.js'),
    });
    const created = await application.create({
      schemaVersion: 1,
      cwd: repository,
      branch: 'feature/integration',
      base: 'main',
      execution: 'none',
    });
    expect(created.path).toBeTruthy();
    const linked = created.path!;
    const listed = await application.list({ schemaVersion: 1, cwd: repository });
    expect(
      listed.workspaces.some(
        (workspace) =>
          path.resolve(workspace.path).toLowerCase() === path.resolve(linked).toLowerCase(),
      ),
    ).toBe(true);

    const started = await application.start({
      schemaVersion: 1,
      cwd: linked,
      serviceId: 'web',
    });
    let logs = await application.logs({ schemaVersion: 1, cwd: linked, serviceId: 'web' });
    for (let attempt = 0; attempt < 25 && !logs.text.includes('ready'); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      logs = await application.logs({ schemaVersion: 1, cwd: linked, serviceId: 'web' });
    }
    expect(['starting', 'ready']).toContain(started.service.state);
    expect(logs.text).toContain('ready');
    await expect(access(path.join(linked, 'malicious-project-executed.txt'))).rejects.toMatchObject(
      {
        code: 'ENOENT',
      },
    );
    await application.stop({ schemaVersion: 1, cwd: linked, serviceId: 'web' });
    const stoppedAgain = await application.stop({
      schemaVersion: 1,
      cwd: linked,
      serviceId: 'web',
    });
    expect(stoppedAgain.service.state).toBe('stopped');
    const removed = await application.remove({ schemaVersion: 1, cwd: repository, path: linked });
    expect(removed.status).toBe('removed');
  }, 60_000);
});

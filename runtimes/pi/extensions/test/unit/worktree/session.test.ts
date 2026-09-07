import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SessionManager } from '@earendil-works/pi-coding-agent';
import { test } from 'vitest';

import { forkWorktreeSession } from '../../../worktree/session.js';

function context(sessionManager: SessionManager, cwd: string): any {
  return { sessionManager, cwd, model: undefined, thinkingLevel: undefined };
}

test('destination-bound fork retains history and continues from the active leaf', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-worktree-session-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
  try {
    const sourceCwd = path.join(root, 'source');
    const targetCwd = path.join(root, 'target');
    const source = SessionManager.create(sourceCwd, path.join(root, 'sessions'));
    const activeLeaf = source.appendMessage({
      role: 'user',
      content: 'first',
      timestamp: Date.now(),
    });
    const abandoned = source.appendMessage({
      role: 'user',
      content: 'abandoned',
      timestamp: Date.now(),
    });
    source.branch(activeLeaf);

    const destination = SessionManager.open(
      forkWorktreeSession(context(source, sourceCwd), targetCwd),
    );
    const handoff = destination.getLeafEntry() as any;
    const header = destination.getHeader();
    assert.ok(header);
    assert.equal(header.cwd, path.resolve(targetCwd));
    assert.equal(
      destination.getEntries().some((entry) => entry.id === abandoned),
      true,
    );
    assert.equal(handoff.customType, 'worktree-handoff');
    assert.match(handoff.content, /read its \.worktree-ports\.json before starting servers/u);
    assert.equal(handoff.parentId, activeLeaf);
    assert.equal(handoff.details.cwd, targetCwd);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('ephemeral sessions are rejected instead of moving state', () => {
  const source = SessionManager.inMemory(process.cwd());
  assert.throws(
    () => forkWorktreeSession(context(source, process.cwd()), path.resolve('target')),
    /saved session|no-session/u,
  );
});

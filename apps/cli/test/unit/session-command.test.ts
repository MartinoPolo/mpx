import { describe, expect, it, vi } from 'vitest';
import type { SessionApplication } from '@mpx/application';
import { executeSessionCommand } from '../../src/session-command.js';

function application(overrides: Partial<SessionApplication> = {}): SessionApplication {
  return {
    list: vi.fn(async () => ({
      schemaVersion: 1,
      kind: 'session-list',
      records: [],
      diagnostics: [],
    })),
    resurrectionExport: vi.fn(async () => ({
      schemaVersion: 1,
      kind: 'session-resurrection-export',
      generatedAt: '2025-01-01T00:00:00.000Z',
      records: [],
    })),
    resume: vi.fn(async () => ({ resumed: true })),
    ...overrides,
  } as SessionApplication;
}

describe('session command', () => {
  it('returns a filtered native session list', async () => {
    const app = application();

    await executeSessionCommand(
      {
        action: 'list',
        args: [],
        options: new Map([
          ['runtime', 'claude'],
          ['state', 'unfinished'],
          ['limit', '5'],
        ]),
      },
      { application: app },
    );

    expect(app.list).toHaveBeenCalledWith({
      filter: { runtime: 'claude', workflowStatus: 'unfinished' },
      limit: 5,
    });
  });

  it('passes resurrection authority only to session resume', async () => {
    const app = application();

    await executeSessionCommand(
      {
        action: 'resume',
        args: ['session-one'],
        options: new Map([['approve-resurrection', true]]),
      },
      { application: app },
    );

    expect(app.resume).toHaveBeenCalledWith({
      id: 'session-one',
      approveResurrection: true,
      dryRun: false,
    });
  });

  it('executes the exact internal resurrection export', async () => {
    const app = application();

    await executeSessionCommand(
      { action: 'resurrect-export', args: [], options: new Map() },
      { application: app },
    );

    expect(app.resurrectionExport).toHaveBeenCalledOnce();
  });

  it.each(['show', 'save', 'branch', 'mark', 'handoff', 'complete', 'inbox', 'reconcile'])(
    'rejects deleted session action %s',
    async (action) => {
      await expect(
        executeSessionCommand(
          { action, args: [], options: new Map() },
          { application: application() },
        ),
      ).rejects.toMatchObject({ code: 'SESSION_USAGE_ERROR' });
    },
  );
});

import { describe, expect, it, vi } from 'vitest';
import { createPiRuntimeAdapter } from '../src/index.js';
import { fixture } from './fixture.js';

describe('Pi skill adapter', () => {
  it('registers only included human /mpx commands and preserves four-state disclosure', async () => {
    const f = await fixture();
    const commands = new Map<string, (args: string) => Promise<void>>();
    const sent: string[] = [];
    const pi = {
      registerCommand: vi.fn((name: string, spec: { handler: (args: string) => Promise<void> }) =>
        commands.set(name, spec.handler),
      ),
      sendUserMessage: vi.fn(async (content: readonly { type: 'text'; text: string }[]) => {
        const [message] = content;
        expect(message).toBeDefined();
        if (message) {
          sent.push(message.text);
        }
      }),
    };
    const adapter = await createPiRuntimeAdapter({ ...f, pi });
    expect([...commands.keys()]).toEqual(['mpx:explicit', 'mpx:full', 'mpx:named']);
    expect([...commands.keys()]).not.toEqual(
      expect.arrayContaining(['skill:full', 'mp', 'mp-gh', 'kf']),
    );
    expect(adapter.initialContext).toEqual([
      {
        identity: 'full',
        publicName: '/mpx:full',
        description: 'Full skill',
        triggers: 'full trigger',
      },
      { identity: 'named', publicName: '/mpx:named' },
    ]);
    expect(adapter.modelSearch('skill').map((x) => x.identity)).toEqual(['full', 'named']);
    await expect(adapter.loadForModel('explicit')).rejects.toThrow('SKILL_INVOCATION_DENIED');
    const explicitCommand = commands.get('mpx:explicit');
    expect(explicitCommand).toBeTypeOf('function');
    if (!explicitCommand) {
      throw new Error('explicit command was not registered');
    }
    await explicitCommand('ignore this prose /mpx:full');
    expect(pi.sendUserMessage).toHaveBeenCalledOnce();
    expect(sent[0]).toContain('identity=explicit');
    expect(sent[0]).toContain('origin=human-explicit');
  });

  it('fails startup and later expansion closed when launch binding is stale', async () => {
    const f = await fixture();
    await expect(
      createPiRuntimeAdapter({
        ...f,
        pi: { registerCommand() {}, sendUserMessage: async () => undefined },
        expectedLaunch: { launchKey: 'rebound', descriptorDigest: 'digest' },
      }),
    ).rejects.toThrow('RESTART_REQUIRED');
    const adapter = await createPiRuntimeAdapter({
      ...f,
      pi: { registerCommand() {}, sendUserMessage: async () => undefined },
    });
    f.currentBinding.repositoryId = 'other';
    expect(() => adapter.modelSearch('full')).toThrow('RESTART_REQUIRED');
    await expect(adapter.loadForModel('full')).rejects.toThrow('RESTART_REQUIRED');
  });
});

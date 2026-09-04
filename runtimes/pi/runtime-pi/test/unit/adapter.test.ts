import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { SkillProjectionPlan } from '@mpx/skills';
import {
  createPiRuntimeAdapter,
  type PiAdapterInput,
  type PiInvocationInput,
  type PiProjectionBuildInput,
} from '../../src/index.js';
import { fixture } from '../fixtures/fixture.js';

describe('Pi skill adapter', () => {
  it('exposes only a verified projection plan for skill semantics at public boundaries', () => {
    type RawProjectionInput =
      | 'manifest'
      | 'artifact'
      | 'catalog'
      | 'canonicalRoot'
      | 'initialModelContext'
      | 'modelSearchSkills'
      | 'validatedSkillBytes';
    expectTypeOf<PiAdapterInput['skillPlan']>().toEqualTypeOf<SkillProjectionPlan>();
    expectTypeOf<PiProjectionBuildInput['skillPlan']>().toEqualTypeOf<SkillProjectionPlan>();
    expectTypeOf<Extract<keyof PiProjectionBuildInput, 'modelMappings'>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<keyof PiInvocationInput, 'skillDirectories'>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<keyof PiAdapterInput, RawProjectionInput>>().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<keyof PiProjectionBuildInput, RawProjectionInput>
    >().toEqualTypeOf<never>();
  });

  it('rejects a mutated plan before registering any command', async () => {
    const f = await fixture();
    (f.skillPlan.entries[0] as { publicName: string }).publicName = '/mpx:changed';
    const registerCommand = vi.fn();
    await expect(
      createPiRuntimeAdapter({
        skillPlan: f.skillPlan,
        compiledContent: f.compiledContent,
        context: f.context,
        currentBinding: f.currentBinding,
        expectedLaunch: f.expectedLaunch,
        pi: { registerCommand, sendUserMessage: async () => undefined },
      }),
    ).rejects.toThrow('SKILL_PROJECTION_PLAN_CHANGED');
    expect(registerCommand).not.toHaveBeenCalled();
  });

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
    expect(sent[0]).toMatch(/<!-- \/mpx-skill -->\nignore this prose \/mpx:full$/u);
  });

  it('keeps transitional aliases body-and-argument equivalent to native generated skills', async () => {
    const f = await fixture();
    let handler: ((args: string) => Promise<void>) | undefined;
    let prompt = '';
    await createPiRuntimeAdapter({
      ...f,
      pi: {
        registerCommand(name, specification) {
          if (name === 'mpx:full') {
            handler = specification.handler;
          }
        },
        async sendUserMessage(content) {
          prompt = content[0]!.text;
        },
      },
    });
    expect(handler).toBeTypeOf('function');
    await handler!('one two');
    const manifest = f.compiledContent.manifest.skills.find((entry) => entry.identity === 'full')!;
    const generated = f.compiledContent.files.find(
      (file) => file.relativePath === manifest.generatedPath,
    )!;
    const body = Buffer.from(generated.bytes).subarray(manifest.bodyByteOffset).toString('utf8');
    expect(prompt).toContain(`${body}<!-- /mpx-skill -->\none two`);
    expect(prompt).not.toContain("description: 'Full skill'");
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

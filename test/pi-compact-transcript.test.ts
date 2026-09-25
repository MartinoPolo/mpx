import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { ToolExecutionComponent, initTheme, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Text, type TUI } from '@earendil-works/pi-tui';
import { loadExtensions } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';
import { readRenderers } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/renderers/read.js';
import { theme } from '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';

const packagePath = resolve('node_modules/pi-compact-transcript/extensions/compact-transcript.ts');
const result = (text: string) => ({ content: [{ type: 'text', text }], isError: false });
const lines = Array.from({ length: 14 }, (_, index) => `content line ${index + 1}`).join('\n');
const plain = (component: ToolExecutionComponent) => component.render(100).join('\n').replace(/\x1b\[[0-9;]*m/g, '');

async function setup() {
  initTheme('dark');
  const { extensions, errors, runtime } = await loadExtensions([packagePath], process.cwd());
  assert.deepEqual(errors, []);
  runtime.appendEntry = () => {}; // Session toggle persistence is not part of this renderer test.
  const extension = extensions[0];
  if (!extension) throw new Error('Compact transcript extension failed to load');
  const { handlers, commands } = extension;
  const context = {
    cwd: process.cwd(), isProjectTrusted: () => false,
    sessionManager: { getBranch: () => [] },
    ui: { theme, setWorkingMessage() {}, setStatus() {}, notify() {}, requestRender() {} },
  } as unknown as ExtensionCommandContext;
  async function reset() {
    const handler = handlers.get('session_start')?.[0];
    assert.ok(handler);
    await handler({ type: 'session_start', reason: 'resume' }, context);
  }
  function start(id: string, name: string, args: unknown) {
    for (const handler of handlers.get('tool_execution_start') ?? []) {
      handler({ type: 'tool_execution_start', toolCallId: id, toolName: name, args }, context);
    }
  }
  const ui = { requestRender() {} } as TUI;
  const create = (id: string, name: string, args: unknown, hydrate = false) => {
    if (!hydrate) start(id, name, args);
    const renderers = name.split('.').pop() === 'read' ? readRenderers : {
      renderShell: 'self' as const,
      renderCall: (_args: unknown, _theme: unknown, context: { expanded: boolean }) => new Text(`${name} native call (${context.expanded})`, 0, 0),
      renderResult: (_result: unknown, options: { expanded: boolean }) => new Text(options.expanded ? lines : 'short preview', 0, 0),
    };
    const component = new ToolExecutionComponent(name, id, args, {}, renderers, ui, process.cwd());
    component.updateResult(result(lines));
    return component;
  };
  await reset();
  const command = commands.get('compact-transcript');
  assert.ok(command);
  return { create, reset, toggle: (value: string) => command.handler(value, context) };
}

test('skill reads and subagent results use native collapsed, expandable previews', async () => {
  const { create } = await setup();
  const skill = create('skill', 'functions.read', { path: 'skills/Foo/SKILL.md' });
  assert.match(plain(skill), /\[skill\].*Foo.*to expand/);
  assert.doesNotMatch(plain(skill), /content line 14|◆/);
  assert.equal((skill as unknown as { expanded: boolean }).expanded, false);
  skill.setExpanded(true);
  assert.match(plain(skill), /content line 14/);
  skill.setExpanded(false);
  assert.match(plain(skill), /\[skill\].*to expand/);
  assert.doesNotMatch(plain(skill), /content line 14/);
  const windowsSkill = create('windows-skill', 'functions.read', { path: 'skills\\Bar\\SKILL.md' });
  assert.match(plain(windowsSkill), /\[skill\].*Bar.*to expand/);
  assert.doesNotMatch(plain(windowsSkill), /content line 14|◆/);
  const mixedCaseSkill = create('mixed-case-skill', 'functions.read', { path: 'C:\\work\\skills\\Foo\\sKiLl.Md' });
  assert.match(plain(mixedCaseSkill), /read .*sKiLl\.Md/i);
  assert.doesNotMatch(plain(mixedCaseSkill), /content line 14|◆/);
  const subagent = create('agent', 'functions.get_subagent_result', { agent_id: 'a' });
  assert.match(plain(subagent), /get_subagent_result native call \(false\)/);
  assert.match(plain(subagent), /short preview/);
  assert.doesNotMatch(plain(subagent), /content line 14|◆/);
  subagent.setExpanded(true);
  assert.match(plain(subagent), /get_subagent_result native call \(true\)/);
  assert.match(plain(subagent), /content line 14/);
  subagent.setExpanded(false);
  assert.match(plain(subagent), /short preview/);
  assert.doesNotMatch(plain(subagent), /content line 14|◆/);
  const ordinary = create('ordinary', 'functions.read', { path: 'docs/README.md' });
  assert.match(plain(ordinary), /◆.*read/);
  assert.doesNotMatch(plain(ordinary), /content line 14/);
  const bash = create('bash', 'bash', { command: 'cat SKILL.md' });
  assert.match(plain(bash), /◆/);
  assert.doesNotMatch(plain(bash), /content line 14/);
  for (const [id, path] of Object.entries({ nested: 'skills/SKILL.md.bak', bare: 'SKILL.md/file', suffix: 'skills/NOTSKILL.md' })) {
    const read = create(id, 'read', { path });
    assert.match(plain(read), /◆/);
    assert.doesNotMatch(plain(read), /content line 14/);
  }
});

test('exempt calls break bursts in live events and restored history', async () => {
  const { create, reset } = await setup();
  for (const hydrate of [false, true]) {
    await reset();
    const first = create(`first-${hydrate}`, 'read', { path: 'first.txt' }, hydrate);
    const skill = create(`skill-${hydrate}`, 'read', { path: 'skills/SKILL.md' }, hydrate);
    const next = create(`next-${hydrate}`, 'read', { path: 'next.txt' }, hydrate);
    assert.match(plain(first), /◆.*first\.txt/);
    assert.match(plain(skill), /\[skill\].*to expand/);
    assert.doesNotMatch(plain(skill), /content line 14/);
    assert.match(plain(next), /◆.*next\.txt/);
    const last = create(`last-${hydrate}`, 'read', { path: 'last.txt' }, hydrate);
    assert.equal(plain(next), '');
    assert.match(plain(last), /2×.*last\.txt/);
    assert.match(plain(skill), /\[skill\].*to expand/);
    const more = create(`more-${hydrate}`, 'read', { path: 'more.txt' }, hydrate);
    assert.match(plain(more), /3×.*more\.txt/);
    const agent = create(`agent-${hydrate}`, 'functions.get_subagent_result', { agent_id: 'a' }, hydrate);
    const secondAgent = create(`second-agent-${hydrate}`, 'functions.get_subagent_result', { agent_id: 'b' }, hydrate);
    assert.match(plain(agent), /short preview/);
    assert.match(plain(secondAgent), /short preview/);
    assert.doesNotMatch(plain(agent), /content line 14|◆/);
    assert.doesNotMatch(plain(secondAgent), /content line 14|◆/);
    const afterAgent = create(`after-agent-${hydrate}`, 'read', { path: 'after.txt' }, hydrate);
    assert.match(plain(afterAgent), /◆.*after\.txt/);
  }
});

test('late skill path dissolves its original burst without changing a newer burst', async () => {
  const { create, reset } = await setup();
  for (const hydrate of [false, true]) {
    await reset();
    const first = create(`first-${hydrate}`, 'read', { path: 'first.txt' }, hydrate);
    const provisional = create(`provisional-${hydrate}`, 'read', { path: 'draft.txt' }, hydrate);
    assert.equal(plain(first), '');
    const command = create(`command-${hydrate}`, 'bash', { command: 'pwd' }, hydrate);
    const nextCommand = create(`next-command-${hydrate}`, 'bash', { command: 'ls' }, hydrate);
    assert.equal(plain(command), '');
    assert.match(plain(nextCommand), /2×/);

    provisional.updateArgs({ path: 'skills/SKILL.md' });
    assert.match(plain(first), /◆.*first\.txt/);
    assert.match(plain(provisional), /\[skill\].*to expand/);
    assert.doesNotMatch(plain(provisional), /content line 14/);
    assert.equal(plain(command), '');
    assert.match(plain(nextCommand), /2×/);
    const lastCommand = create(`last-command-${hydrate}`, 'bash', { command: 'date' }, hydrate);
    assert.match(plain(lastCommand), /3×/);
  }
});

test('toggles and streamed argument updates do not leave ordinary reads expanded', async () => {
  const { create, toggle } = await setup();
  const skill = create('skill', 'read', { path: 'SKILL.md' });
  skill.updateArgs({ path: 'skills/SKILL.md', limit: 5 });
  assert.match(plain(skill), /\[skill\].*to expand/);
  assert.doesNotMatch(plain(skill), /content line 14/);
  skill.updateArgs({ path: 'notes.txt' });
  assert.match(plain(skill), /◆.*notes\.txt/);
  assert.doesNotMatch(plain(skill), /content line 14/);
  skill.updateArgs({ path: 'skills/SKILL.md' });
  assert.match(plain(skill), /\[skill\].*to expand/);
  assert.doesNotMatch(plain(skill), /content line 14/);
  const ordinary = create('ordinary', 'read', { path: 'other.txt' });
  ordinary.setExpanded(true);
  assert.match(plain(ordinary), /content line 14/);
  ordinary.setExpanded(false);
  assert.match(plain(ordinary), /◆/);
  await toggle('off');
  assert.match(plain(skill), /\[skill\].*to expand/);
  assert.doesNotMatch(plain(skill), /content line 14/);
  assert.doesNotMatch(plain(ordinary), /◆/);
  await toggle('on');
  assert.match(plain(skill), /\[skill\].*to expand/);
  assert.doesNotMatch(plain(skill), /content line 14/);
  assert.match(plain(ordinary), /◆/);
  const before = create('before-stream', 'read', { path: 'before.txt' });
  const streaming = create('streaming', 'read', { path: 'draft.txt' });
  assert.equal(plain(before), '');
  streaming.updateArgs({ path: 'skills/SKILL.md' });
  assert.match(plain(before), /◆.*before\.txt/);
  assert.match(plain(streaming), /\[skill\].*to expand/);
  assert.doesNotMatch(plain(streaming), /content line 14/);
});

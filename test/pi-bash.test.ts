import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionAPI, ToolCallEvent } from '@earendil-works/pi-coding-agent';
import piBash from '../extensions/pi-bash.js';

test('defaults only omitted Bash timeouts without replacing tools', () => {
  let handler: ((event: ToolCallEvent) => unknown) | undefined;
  piBash({
    on(name: string, callback: (event: ToolCallEvent) => unknown) {
      assert.equal(name, 'tool_call');
      handler = callback;
    },
  } as unknown as ExtensionAPI);
  assert.ok(handler);

  const cases = [
    { toolName: 'bash', input: { command: 'echo test' }, expected: { command: 'echo test', timeout: 120 } },
    ...[1, 86_400, 0].map(timeout => ({
      toolName: 'bash', input: { command: 'echo test', timeout }, expected: { command: 'echo test', timeout },
    })),
    { toolName: 'read', input: { path: 'README.md' }, expected: { path: 'README.md' } },
  ];
  for (const { toolName, input, expected } of cases) {
    handler({ type: 'tool_call', toolCallId: 'fixture', toolName, input });
    assert.deepEqual(input, expected);
  }
});

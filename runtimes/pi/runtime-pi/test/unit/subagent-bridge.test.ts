import { expect, it, vi } from 'vitest';
import type { Agent, AgentLaunchRequest } from '@mpx/subagents';
import { activatePiSubagentBridge } from '../../src/subagent-bridge.js';

it('registers Agent/result/steer over the provider-neutral lifecycle and preserves fleet surfaces', async () => {
  const tools = new Map<
    string,
    {
      execute(
        id: string,
        params: Record<string, unknown>,
      ): Promise<{ content: Array<{ text: string }> }>;
    }
  >();
  const launch = vi.fn(async (request: AgentLaunchRequest): Promise<Agent> => ({
    ...request,
    id: 'a1',
    status: 'running',
    createdAt: 0,
    resultConsumed: false,
  }));
  const result = vi.fn(async () => 'done');
  const steer = vi.fn();
  activatePiSubagentBridge(
    {
      registerTool(tool) {
        tools.set(tool.name, tool);
      },
    },
    {
      lifecycle: { launch, get_subagent_result: result, steer_subagent: steer, list: () => [] },
      createLaunchRequest: (params) => params as never,
      updateFleet: vi.fn(),
      notify: vi.fn(),
    },
  );
  expect([...tools.keys()]).toEqual(['Agent', 'get_subagent_result', 'steer_subagent']);
  const agentTool = tools.get('Agent');
  expect(agentTool).toBeDefined();
  if (!agentTool) {
    throw new Error('Agent tool was not registered');
  }
  const [agentContent] = (await agentTool.execute('call', { description: 'task' })).content;
  expect(agentContent).toBeDefined();
  if (!agentContent) {
    throw new Error('Agent tool returned no content');
  }
  expect(agentContent.text).toContain('"id":"a1"');
  const resultTool = tools.get('get_subagent_result');
  expect(resultTool).toBeDefined();
  if (!resultTool) {
    throw new Error('result tool was not registered');
  }
  await resultTool.execute('call', { id: 'a1' });
  expect(result).toHaveBeenCalledWith('a1');
  const steerTool = tools.get('steer_subagent');
  expect(steerTool).toBeDefined();
  if (!steerTool) {
    throw new Error('steer tool was not registered');
  }
  await steerTool.execute('call', { id: 'a1', message: 'focus' });
  expect(steer).toHaveBeenCalledWith('a1', 'focus');
});

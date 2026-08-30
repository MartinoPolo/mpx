import { expect, it } from 'vitest';
import { createPiHookWiring } from '../src/hooks-wiring.js';

it('maps all shared policy events with intentional failure behavior', () => {
  const hooks = createPiHookWiring();
  expect(hooks.map(({ event, policy, failure }) => [event, policy, failure])).toEqual([
    ['tool_call', 'package-manager', 'open'],
    ['tool_call', 'dangerous-command', 'closed'],
    ['tool_call', 'precommit-secret', 'closed'],
    ['tool_call', 'fallow', 'open'],
    ['tool_result', 'post-write', 'report'],
    ['tool_result', 'post-command', 'open'],
    ['session_start', 'machine-session', 'open'],
    ['session_before_compact', 'compaction', 'runtime-default'],
    ['agent_settled', 'notification', 'ignore'],
  ]);
});

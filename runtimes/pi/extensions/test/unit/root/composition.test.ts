import assert from 'node:assert/strict';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { test, vi } from 'vitest';

vi.mock('@mpx/content-compiler', () => ({
  classifyCompiledSkillSource: vi.fn(),
  loadActiveContentProjection: vi.fn(),
  readActiveSkill: vi.fn(),
}));

import mpxPiExtensions, {
  composeExtensions,
  DEFAULT_EXTENSION_COMPONENTS,
  type ExtensionComponent,
} from '../../../index.js';

const EXPECTED_COMPONENTS = [
  'session-lifecycle',
  'agent-resurrect',
  'auto-title',
  'compact-instructions',
  'canonical-skills',
  'footer',
  'fullscreen-scroll-speed',
  'guard-hooks',
  'notifications',
  'dev-server',
  'subagents',
  'worktree',
  'terminal-progress',
];

type Handler = (...arguments_: unknown[]) => unknown;

interface RegistrationSnapshot {
  tools: string[];
  commands: string[];
  messageRenderers: string[];
  events: Map<string, Handler[]>;
  busEvents: Map<string, Handler[]>;
}

function safeExtensionApi(): { api: ExtensionAPI; registrations: RegistrationSnapshot } {
  const registrations: RegistrationSnapshot = {
    tools: [],
    commands: [],
    messageRenderers: [],
    events: new Map(),
    busEvents: new Map(),
  };
  const eventBusHandlers = new Map<string, Set<Handler>>();
  const api = {
    events: {
      emit: () => undefined,
      on: (event: string, handler: Handler) => {
        const handlers = eventBusHandlers.get(event) ?? new Set<Handler>();
        handlers.add(handler);
        eventBusHandlers.set(event, handlers);
        const registeredHandlers = registrations.busEvents.get(event) ?? [];
        registeredHandlers.push(handler);
        registrations.busEvents.set(event, registeredHandlers);
        return () => handlers.delete(handler);
      },
    },
    on: (event: string, handler: Handler) => {
      const handlers = registrations.events.get(event) ?? [];
      handlers.push(handler);
      registrations.events.set(event, handlers);
    },
    registerTool: (definition: { name: string }) => registrations.tools.push(definition.name),
    registerCommand: (name: string) => registrations.commands.push(name),
    registerMessageRenderer: (name: string) => registrations.messageRenderers.push(name),
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  return { api, registrations };
}

test('default composition is static, stable, and unique', () => {
  const names = DEFAULT_EXTENSION_COMPONENTS.map(({ name }) => name);

  assert.deepEqual(names, EXPECTED_COMPONENTS);
  assert.equal(new Set(names).size, names.length);
});

test('default entry point provides every required public registration and lifecycle category', async () => {
  const { api, registrations } = safeExtensionApi();

  await mpxPiExtensions(api);

  const requiredLifecycleEvents = [
    'after_provider_response',
    'agent_start',
    'agent_settled',
    'input',
    'model_select',
    'session_before_compact',
    'session_before_switch',
    'session_compact',
    'session_info_changed',
    'session_shutdown',
    'session_start',
    'thinking_level_select',
    'tool_call',
    'tool_execution_end',
    'tool_execution_start',
    'tool_result',
  ];
  for (const event of requiredLifecycleEvents) {
    assert.ok(registrations.events.has(event), `missing ${event} lifecycle registration`);
  }
  for (const tool of ['Agent', 'dev_server', 'get_subagent_result', 'steer_subagent', 'worktree']) {
    assert.ok(registrations.tools.includes(tool), `missing ${tool} tool`);
  }
  for (const command of ['agents', 'dev-servers', 'worktree']) {
    assert.ok(registrations.commands.includes(command), `missing ${command} command`);
  }
  assert.ok(registrations.messageRenderers.includes('subagent-notification'));
  for (const event of ['dev-servers:changed', 'subagents:completed', 'subagents:failed']) {
    assert.ok(registrations.busEvents.has(event), `missing ${event} bus lifecycle registration`);
  }
});

test('default composition has unique registration and UI ownership', async () => {
  const { api, registrations } = safeExtensionApi();

  await mpxPiExtensions(api);

  assert.equal(new Set(registrations.tools).size, registrations.tools.length);
  assert.equal(new Set(registrations.commands).size, registrations.commands.length);
  assert.equal(new Set(registrations.messageRenderers).size, registrations.messageRenderers.length);
  for (const handlers of [...registrations.events.values(), ...registrations.busEvents.values()]) {
    assert.equal(new Set(handlers).size, handlers.length);
  }
});

test('composition awaits every injected component exactly once in order', async () => {
  const calls: string[] = [];
  const components: ExtensionComponent[] = EXPECTED_COMPONENTS.map((name) => ({
    name,
    register: async () => {
      await Promise.resolve();
      calls.push(name);
    },
  }));

  await composeExtensions({} as ExtensionAPI, components);

  assert.deepEqual(calls, EXPECTED_COMPONENTS);
});

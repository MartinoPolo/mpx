import assert from 'node:assert/strict';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { test } from 'vitest';

import mpxPiExtensions, {
  composeExtensions,
  DEFAULT_EXTENSION_COMPONENTS,
  type ExtensionComponent,
} from '../../../index.js';

const EXPECTED_COMPONENTS = [
  'agent-resurrect',
  'auto-title',
  'compact-instructions',
  'footer',
  'fullscreen-scroll-speed',
  'guard-hooks',
  'dev-server',
  'subagents',
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

function registeredHandlerSource(
  registrations: RegistrationSnapshot,
  event: string,
  marker: string,
): boolean {
  return (registrations.events.get(event) ?? []).some((handler) =>
    String(handler).includes(marker),
  );
}

test('default composition is static, stable, and unique', () => {
  const names = DEFAULT_EXTENSION_COMPONENTS.map(({ name }) => name);

  assert.deepEqual(names, EXPECTED_COMPONENTS);
  assert.equal(new Set(names).size, names.length);
});

test('default entry point composes representative registrations from every component', () => {
  const { api, registrations } = safeExtensionApi();

  mpxPiExtensions(api);

  assert.equal(registeredHandlerSource(registrations, 'session_start', 'writeRegistration'), true);
  assert.equal(registeredHandlerSource(registrations, 'input', 'firstPrompt'), true);
  assert.equal(registrations.events.has('session_before_compact'), true);
  assert.equal(registeredHandlerSource(registrations, 'session_start', 'setFooter'), true);
  assert.equal(registeredHandlerSource(registrations, 'session_start', 'WIDGET_KEY'), true);
  assert.equal(registrations.events.has('tool_call'), true);
  assert.deepEqual(registrations.tools.toSorted(), [
    'Agent',
    'dev_server',
    'get_subagent_result',
    'steer_subagent',
  ]);
  assert.deepEqual(registrations.commands.toSorted(), ['agents', 'dev-servers']);
  assert.deepEqual(registrations.messageRenderers, ['subagent-notification']);
  assert.equal(registeredHandlerSource(registrations, 'tool_execution_end', 'onQuestionEnd'), true);
});

test('default composition has unique registration and UI ownership', () => {
  const { api, registrations } = safeExtensionApi();

  mpxPiExtensions(api);

  assert.equal(new Set(registrations.tools).size, registrations.tools.length);
  assert.equal(new Set(registrations.commands).size, registrations.commands.length);
  assert.equal(new Set(registrations.messageRenderers).size, registrations.messageRenderers.length);
  for (const handlers of [
    ...registrations.events.values(),
    ...registrations.busEvents.values(),
  ]) {
    assert.equal(new Set(handlers).size, handlers.length);
  }

  const sessionStartHandlers = registrations.events.get('session_start') ?? [];
  assert.equal(
    sessionStartHandlers.filter((handler) => String(handler).includes('setFooter')).length,
    1,
  );
  assert.equal(
    sessionStartHandlers.filter((handler) => String(handler).includes('setEditorComponent')).length,
    1,
  );
});

test('composition invokes every injected component exactly once in order', () => {
  const calls: string[] = [];
  const components: ExtensionComponent[] = EXPECTED_COMPONENTS.map((name) => ({
    name,
    register: () => calls.push(name),
  }));

  composeExtensions({} as ExtensionAPI, components);

  assert.deepEqual(calls, EXPECTED_COMPONENTS);
});

import type { Agent, AgentLaunchRequest, SubagentLifecycle } from '@mpx/subagents';

interface PiTool {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: object;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; details?: unknown }>;
}
export interface PiSubagentToolAPI {
  registerTool(tool: PiTool): void;
}
export interface PiSubagentLifecycleSurface {
  launch(request: AgentLaunchRequest): Promise<Agent>;
  get_subagent_result(id: string): Promise<string>;
  steer_subagent(id: string, message: string): void;
  list(): readonly Agent[];
}
export interface PiSubagentBridgeDependencies {
  readonly lifecycle: PiSubagentLifecycleSurface | SubagentLifecycle;
  createLaunchRequest(params: Record<string, unknown>): AgentLaunchRequest;
  updateFleet(agents: readonly Agent[]): void;
  notify(message: string): void;
}
const objectSchema = (properties: Record<string, object>, required: string[]) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});
const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`SUBAGENT_INPUT_INVALID: ${label} is required`);
  }
  return value;
};
const output = (value: unknown, details?: unknown) => ({
  content: [
    { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) },
  ],
  ...(details === undefined ? {} : { details }),
});

/** Pi-native tool surface over @mpx/subagents. Authority derivation, nesting, scheduling and isolation stay in the provider-neutral lifecycle. */
export function activatePiSubagentBridge(
  pi: PiSubagentToolAPI,
  dependencies: PiSubagentBridgeDependencies,
): void {
  const fleet = (): void => dependencies.updateFleet(dependencies.lifecycle.list());
  pi.registerTool({
    name: 'Agent',
    label: 'Agent',
    description: 'Launch an authority-bounded MPX subagent in foreground, background, or a group.',
    parameters: objectSchema({}, []),
    async execute(_id, params) {
      const agent = await dependencies.lifecycle.launch(dependencies.createLaunchRequest(params));
      fleet();
      return output(agent, { agent });
    },
  });
  pi.registerTool({
    name: 'get_subagent_result',
    label: 'Subagent result',
    description: 'Wait for and consume a background subagent result.',
    parameters: objectSchema({ id: { type: 'string' } }, ['id']),
    async execute(_id, params) {
      const id = text(params.id, 'id');
      const result = await dependencies.lifecycle.get_subagent_result(id);
      fleet();
      return output(result, { id });
    },
  });
  pi.registerTool({
    name: 'steer_subagent',
    label: 'Steer subagent',
    description: 'Send guidance to a queued or running subagent.',
    parameters: objectSchema({ id: { type: 'string' }, message: { type: 'string' } }, [
      'id',
      'message',
    ]),
    async execute(_id, params) {
      const id = text(params.id, 'id'),
        message = text(params.message, 'message');
      dependencies.lifecycle.steer_subagent(id, message);
      fleet();
      dependencies.notify(`Steering sent to ${id}.`);
      return output('Steering accepted.', { id });
    },
  });
}

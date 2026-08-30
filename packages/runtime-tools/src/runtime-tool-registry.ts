import { createHash } from 'node:crypto';

export interface RuntimeToolRegistryEntry {
  readonly path: string;
  readonly topLevel: string;
  readonly category: 'aggregate' | 'child-operation';
  readonly implementation: string;
}
const remote = 'packages/executors/src/production-remote.ts#ProductionRemoteToolClient.execute';
const entry = (path: string, topLevel = path.split('/', 1)[0]!): RuntimeToolRegistryEntry => ({
  path,
  topLevel,
  category: path === topLevel ? 'aggregate' : 'child-operation',
  implementation: remote,
});

/** Phase F1 inventory is the immutable F2 admission set, including Pi built-ins and hidden child operations. */
export const RUNTIME_TOOL_REGISTRY = Object.freeze([
  ...['read', 'write', 'edit', 'find', 'grep', 'ls', 'bash'].map((path) => entry(path)),
  entry('shell/execute', 'bash'),
  entry('process'),
  ...['process/start', 'process/status', 'process/logs', 'process/stop'].map((path) =>
    entry(path, 'process'),
  ),
  entry('git'),
  ...[
    'git/status',
    'git/diff',
    'git/log',
    'git/branch',
    'git/checkout',
    'git/commit',
    'git/worktree',
  ].map((path) => entry(path, 'git')),
  entry('browser'),
  ...[
    'browser/navigate',
    'browser/snapshot',
    'browser/click',
    'browser/type',
    'browser/evaluate',
    'browser/screenshot',
  ].map((path) => entry(path, 'browser')),
  entry('mcp'),
  entry('mcp/:server/:method', 'mcp'),
  entry('web_search'),
  entry('web_search/:provider/search', 'web_search'),
  entry('fetch_content'),
  entry('fetch_content/:provider/fetch', 'fetch_content'),
  entry('get_search_content'),
  entry('get_search_content/:response', 'get_search_content'),
  entry('source_check'),
  entry('source_check/web_search', 'source_check'),
  entry('dev_server'),
  ...['start', 'status', 'logs', 'restart', 'stop'].map((action) =>
    entry(`dev_server/${action}`, 'dev_server'),
  ),
  entry('mpx_model_search'),
  entry('mpx_model_load'),
  entry('Agent'),
  ...['child', 'nested', 'group', 'schedule'].map((action) => entry(`Agent/${action}`, 'Agent')),
  entry('get_subagent_result'),
  entry('steer_subagent'),
] satisfies readonly RuntimeToolRegistryEntry[]);
const stable = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(stable).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
          .join(',')}}`
      : JSON.stringify(value);
export const RUNTIME_TOOL_INVENTORY_SHA256 = createHash('sha256')
  .update(stable(RUNTIME_TOOL_REGISTRY))
  .digest('hex');

export const RUNTIME_GATEWAY_TOOL_NAMES = Object.freeze([
  'mcp',
  'web_search',
  'fetch_content',
  'get_search_content',
  'source_check',
] as const);
export const RUNTIME_TOOL_NAMES = Object.freeze([
  ...RUNTIME_GATEWAY_TOOL_NAMES,
  'dev_server',
] as const);
export type RuntimeToolName = (typeof RUNTIME_GATEWAY_TOOL_NAMES)[number];

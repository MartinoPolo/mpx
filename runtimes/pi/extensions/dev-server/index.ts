import path from 'node:path';

import { Type } from '@earendil-works/pi-ai';
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';

import { DEV_SERVERS_CHANGED_EVENT, type DevServerSnapshot } from './contract.js';
import { DevServerManager } from './manager.js';
import { createSystemRuntime } from './system-runtime.js';

interface ToolParams {
  action: 'start' | 'status' | 'logs' | 'restart' | 'stop';
  id?: string;
  command?: string;
  cwd?: string;
  ports?: number[];
  lines?: number;
}

function requireText(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required for this action.`);
  }
  return value.trim();
}

function renderSnapshot(snapshot: DevServerSnapshot): string {
  const ports =
    snapshot.ports.length === 0
      ? 'no readiness ports'
      : `ports ${snapshot.readyPorts.length}/${snapshot.ports.length}`;
  const exit = snapshot.exitStatus === null ? '' : `, ${snapshot.exitStatus}`;
  return `${snapshot.id}: ${snapshot.state}${exit}, pid ${snapshot.pid ?? '-'}, run ${snapshot.run}, ${ports}\n${snapshot.command}\n${snapshot.cwd}`;
}

async function showDevServers(
  manager: DevServerManager,
  ctx: ExtensionCommandContext,
): Promise<void> {
  while (true) {
    const snapshots = manager.list();
    const labels = snapshots.map((snapshot) => `${snapshot.id} — ${snapshot.state}`);
    const choice = await ctx.ui.select('Managed dev servers', [
      'Start new server',
      ...labels,
      'Close',
    ]);
    if (choice === undefined || choice === 'Close') {
      return;
    }
    if (choice === 'Start new server') {
      const id = await ctx.ui.input('Server id');
      if (!id) {
        continue;
      }
      const command = await ctx.ui.input('Command');
      if (!command) {
        continue;
      }
      const cwd = await ctx.ui.input('Working directory', ctx.cwd);
      if (!cwd) {
        continue;
      }
      const rawPorts = await ctx.ui.input(
        'Readiness ports (comma-separated; blank for immediate)',
        '',
      );
      const ports = (rawPorts ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
        .map(Number);
      try {
        const snapshot = await manager.start({ id, command, cwd: path.resolve(cwd), ports });
        ctx.ui.notify(renderSnapshot(snapshot), snapshot.state === 'ready' ? 'info' : 'warning');
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
      continue;
    }

    const selectedIndex = labels.indexOf(choice);
    const snapshot = snapshots[selectedIndex];
    if (snapshot === undefined) {
      continue;
    }
    const action = await ctx.ui.select(snapshot.id, ['Status', 'Logs', 'Restart', 'Stop', 'Back']);
    try {
      if (action === 'Status') {
        ctx.ui.notify(renderSnapshot(manager.status(snapshot.id)!), 'info');
      } else if (action === 'Logs') {
        ctx.ui.notify(manager.logs(snapshot.id) || '(no logs)', 'info');
      } else if (action === 'Restart') {
        ctx.ui.notify(renderSnapshot(await manager.restart(snapshot.id)), 'info');
      } else if (action === 'Stop') {
        const confirmed = await ctx.ui.confirm(
          'Stop dev server',
          `Terminate ${snapshot.id} and its process tree?`,
        );
        if (confirmed) {
          ctx.ui.notify(renderSnapshot(await manager.stop(snapshot.id)), 'info');
        }
      }
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
    }
  }
}

export default function (pi: ExtensionAPI): void {
  const manager = new DevServerManager(createSystemRuntime(), (snapshot) => {
    pi.events.emit(DEV_SERVERS_CHANGED_EVENT, snapshot);
  });

  pi.registerTool(
    defineTool({
      name: 'dev_server',
      label: 'Managed dev server',
      description:
        'Start, inspect, restart, and stop a foreground development command whose complete process tree is owned by this pi session. ' +
        'Readiness waits for every configured localhost TCP port; omit ports for immediate readiness. Commands that daemonize are unsupported.',
      promptSnippet:
        'Manage a persistent development server with captured logs and automatic session cleanup.',
      promptGuidelines: [
        'Use dev_server start instead of an opaque background shell process for persistent local servers.',
        'Give each server a stable id and include every localhost port required for readiness.',
        'Use dev_server logs for bounded stdout/stderr and stop servers when they are no longer needed.',
      ],
      parameters: Type.Object(
        {
          action: Type.String({
            enum: ['start', 'status', 'logs', 'restart', 'stop'],
            description: 'Operation to perform.',
          }),
          id: Type.Optional(
            Type.String({
              description: 'Stable server id. Required except to list all status snapshots.',
            }),
          ),
          command: Type.Optional(
            Type.String({
              description: 'Foreground command. Required for start; daemonizing is unsupported.',
            }),
          ),
          cwd: Type.Optional(
            Type.String({
              description: 'Working directory for start. Defaults to the current pi directory.',
            }),
          ),
          ports: Type.Optional(
            Type.Array(Type.Integer({ minimum: 1, maximum: 65535 }), {
              description: 'Local TCP readiness ports.',
            }),
          ),
          lines: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 500,
              description: 'Maximum log lines returned to the model.',
            }),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
        signal?.throwIfAborted();
        const params = rawParams as ToolParams;
        let result: string;
        let details: unknown;
        if (params.action === 'start') {
          const id = requireText(params.id, 'id');
          const snapshot = await manager.start({
            id,
            command: requireText(params.command, 'command'),
            cwd: path.resolve(params.cwd ?? ctx.cwd),
            ports: params.ports ?? [],
          });
          if (signal?.aborted) {
            await manager.stop(id);
            signal?.throwIfAborted();
          }
          result = renderSnapshot(snapshot);
          details = snapshot;
        } else if (params.action === 'status') {
          const snapshots =
            params.id === undefined ? manager.list() : [manager.status(params.id)].filter(Boolean);
          result =
            snapshots.length === 0
              ? 'No managed dev servers.'
              : snapshots.map((snapshot) => renderSnapshot(snapshot!)).join('\n\n');
          details = snapshots;
        } else if (params.action === 'logs') {
          const id = requireText(params.id, 'id');
          result =
            manager.logs(id, { maxLines: params.lines ?? 200, maxCharacters: 20_000 }) ||
            '(no logs)';
          details = manager.status(id);
        } else if (params.action === 'restart') {
          const id = requireText(params.id, 'id');
          const snapshot = await manager.restart(id);
          if (signal?.aborted) {
            await manager.stop(id);
            signal?.throwIfAborted();
          }
          result = renderSnapshot(snapshot);
          details = snapshot;
        } else if (params.action === 'stop') {
          const snapshot = await manager.stop(requireText(params.id, 'id'));
          result = renderSnapshot(snapshot);
          details = snapshot;
        } else {
          throw new Error(`Unsupported dev_server action '${String(params.action)}'.`);
        }
        return { content: [{ type: 'text', text: result }], details };
      },
    }),
  );

  pi.registerCommand('dev-servers', {
    description: 'Manage session-owned development servers',
    handler: async (_args, ctx) => {
      await showDevServers(manager, ctx);
    },
  });

  pi.on('session_shutdown', async () => {
    await manager.shutdown();
  });
}

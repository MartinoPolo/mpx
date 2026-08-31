import { describe, expect, it } from 'vitest';
import {
  ISSUE_CAPABILITIES,
  ProviderError,
  ProviderService,
  ProviderRegistry,
  type IssueCapability,
  type ProviderInvocation,
  type ProviderProcessExecutor,
  type ProviderProcessRequest,
  type ProviderProcessResult,
} from '@mpx/providers';
import { defineIssueAdapterConformance, type IssueConformanceDriver } from '@mpx/providers/testing';
import { createKanbanFlowAdapter } from '../../src/index.js';

type WireTask = {
  _id: string;
  name: string;
  columnId: string;
  description?: string;
  number?: { prefix?: string; value: number };
  labels?: { name: string; pinned?: boolean }[];
  responsibleUserId?: string;
  collaborators?: { userId: string }[];
  color?: string;
};

class StatefulKf implements ProviderProcessExecutor {
  readonly requests: ProviderProcessRequest[] = [];
  readonly tasks = new Map<string, WireTask>([
    ['T1', { _id: 'T1', name: 'Seed', description: 'Initial', columnId: 'TODO', labels: [] }],
  ]);
  next = 2;

  async execute(request: ProviderProcessRequest): Promise<ProviderProcessResult> {
    this.requests.push(request);
    const args = request.argv.slice(1);
    if (args[0] === 'issue' && args[1] === 'list') {
      return this.ok([...this.tasks.values()]);
    }
    if (args[0] === 'issue' && args[1] === 'view') {
      return this.ok({ issue: this.get(args[2]!), comments: [], attachments: [] });
    }
    if (args[0] === 'issue' && args[1] === 'create') {
      const id = `T${this.next++}`;
      this.tasks.set(id, {
        _id: id,
        name: value(args, '--name'),
        description: value(args, '--description'),
        columnId: 'TODO',
        labels: [],
      });
      return this.ok({ issueId: id, number: null, attachments: [] });
    }
    if (args[0] === 'issue' && args[1] === 'edit') {
      const task = this.get(args[2]!);
      if (args.includes('--name')) {
        task.name = value(args, '--name');
      }
      if (args.includes('--description')) {
        task.description = value(args, '--description');
      }
      if (args.includes('--add-label')) {
        task.labels = [...(task.labels ?? []), { name: value(args, '--add-label') }];
      }
      return this.ok(task);
    }
    if (args[0] === 'issue' && args[1] === 'move') {
      this.get(args[2]!).columnId = value(args, '--to');
      return this.text('Affected issue.\n');
    }
    if (args[0] === 'issue' && args[1] === 'finish') {
      this.get(args[2]!).columnId = value(args, '--to');
      return this.text('Affected issue.\n');
    }
    if (args[0] === 'comment' && args[1] === 'add') {
      return this.text('C1\nAffected issue.\n');
    }
    throw new Error(`unexpected argv: ${request.argv.join(' ')}`);
  }

  private get(id: string): WireTask {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`missing ${id}`);
    }
    return task;
  }
  private ok(value: unknown): ProviderProcessResult {
    return this.text(JSON.stringify(value));
  }
  private text(stdout: string): ProviderProcessResult {
    return { exitCode: 0, stdout, stderr: '' };
  }
}

function value(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  return args[index + 1]!;
}

const options = {
  states: {
    todo: 'column-todo-17',
    wip: 'column-wip-23',
    review: 'column-review-41',
    done: 'column-done-59',
    archive: 'column-archive-61',
  },
} as const;

function driver(): IssueConformanceDriver {
  const backend = new StatefulKf();
  const adapter = createKanbanFlowAdapter(backend, options);
  return {
    capabilities: adapter.capabilities as readonly IssueCapability[],
    invoke: (capability, input) =>
      adapter.invoke({
        providerId: 'kanbanflow',
        capability,
        input: input as ProviderInvocation['input'],
      }),
  };
}

defineIssueAdapterConformance('KanbanFlow adapter', driver);

describe('KanbanFlow provider adapter', () => {
  it('declares the trusted issues identity and every canonical issue capability only', () => {
    const adapter = createKanbanFlowAdapter(new StatefulKf(), options);
    expect({
      providerId: adapter.providerId,
      role: adapter.role,
      backend: adapter.backend,
      routeRequired: adapter.routeRequired,
    }).toEqual({ providerId: 'kanbanflow', role: 'issues', backend: 'kf', routeRequired: true });
    expect(adapter.capabilities).toEqual(ISSUE_CAPABILITIES);
    expect(
      adapter.capabilities.some(
        (capability) => capability.startsWith('review.') || capability.startsWith('ci.'),
      ),
    ).toBe(false);
  });

  it('uses the renamed public kf issue grammar and argv-only comment and label mutations', async () => {
    const backend = new StatefulKf();
    const adapter = createKanbanFlowAdapter(backend, options);
    const invoke = (capability: IssueCapability, input: Record<string, unknown>) =>
      adapter.invoke({
        providerId: 'kanbanflow',
        capability,
        input: input as ProviderInvocation['input'],
      });
    await invoke('issue.list', {});
    await invoke('issue.view', { id: 'T1' });
    const created = (await invoke('issue.create', { title: 'A title', body: 'A body' })) as {
      id: string;
    };
    await invoke('issue.edit', { id: created.id, title: 'Changed', body: 'Changed body' });
    const comment = await invoke('issue.comment', { id: created.id, body: 'Hello world' });
    expect(comment).toEqual({
      schemaVersion: 1,
      id: 'C1',
      issueId: 'T2',
      body: 'Hello world',
      providerData: { kanbanflow: { nativeId: 'C1' } },
    });
    await invoke('issue.label', { id: created.id, label: 'phase-e' });
    await invoke('issue.move', { id: created.id, destination: 'review' });
    await invoke('issue.finish', { id: created.id });
    expect(backend.requests.map((request) => request.argv)).toEqual([
      ['kf', 'issue', 'list', '--json'],
      ['kf', 'issue', 'view', 'T1', '--json'],
      ['kf', 'issue', 'create', '--name', 'A title', '--description', 'A body', '--json'],
      ['kf', 'issue', 'view', 'T2', '--json'],
      ['kf', 'issue', 'edit', 'T2', '--name', 'Changed', '--description', 'Changed body', '--json'],
      ['kf', 'comment', 'add', 'T2', '--text', 'Hello world'],
      ['kf', 'issue', 'edit', 'T2', '--add-label', 'phase-e', '--json'],
      ['kf', 'issue', 'move', 'T2', '--to', 'column-review-41'],
      ['kf', 'issue', 'view', 'T2', '--json'],
      ['kf', 'issue', 'finish', 'T2', '--to', 'column-done-59'],
      ['kf', 'issue', 'view', 'T2', '--json'],
    ]);
    expect(
      backend.requests.every((request) => !(request as unknown as Record<string, unknown>).shell),
    ).toBe(true);
  });

  it('filters issue lists by normalized state without passing canonical names to kf', async () => {
    const backend = new StatefulKf();
    backend.tasks.set('T9', { _id: 'T9', name: 'Done', columnId: 'column-done-59' });
    const issues = (await createKanbanFlowAdapter(backend, options).invoke({
      providerId: 'kanbanflow',
      capability: 'issue.list',
      input: { state: 'finished' },
    })) as { id: string }[];
    expect(issues.map((issue) => issue.id)).toEqual(['T9']);
    expect(backend.requests[0]?.argv).toEqual(['kf', 'issue', 'list', '--json']);
  });

  it('normalizes wire tasks, configured workflow state, closure, people, and provider-only fields', async () => {
    const backend = new StatefulKf();
    backend.tasks.set('T9', {
      _id: 'T9',
      name: 'Done item',
      description: 'Body',
      columnId: 'column-archive-61',
      number: { prefix: 'E', value: 9 },
      labels: [{ name: 'Bug', pinned: true }],
      responsibleUserId: 'U1',
      collaborators: [{ userId: 'U2' }, { userId: 'U1' }],
      color: 'red',
    });
    const issue = await createKanbanFlowAdapter(backend, options).invoke({
      providerId: 'kanbanflow',
      capability: 'issue.view',
      input: { id: 'T9' },
    });
    expect(issue).toEqual({
      schemaVersion: 1,
      id: 'T9',
      title: 'Done item',
      body: 'Body',
      state: 'finished',
      labels: ['Bug'],
      assignees: ['U1', 'U2'],
      providerData: {
        kanbanflow: {
          nativeId: 'T9',
          number: 'E9',
          columnId: 'column-archive-61',
          workflowState: 'archive',
          color: 'red',
        },
      },
    });
  });

  it('fails review, CI, and undeclared operations structurally before invoking kf', async () => {
    const backend = new StatefulKf();
    const adapter = createKanbanFlowAdapter(backend, options);
    for (const capability of ['review.view', 'ci.status', 'issue.delete']) {
      await expect(
        adapter.invoke({
          providerId: 'kanbanflow',
          capability: capability as IssueCapability,
          input: {},
        }),
      ).rejects.toMatchObject({
        code: capability === 'issue.delete' ? 'CAPABILITY_UNKNOWN' : 'CAPABILITY_UNSUPPORTED',
        capability,
        retryable: false,
      });
    }
    expect(backend.requests).toEqual([]);
    const service = new ProviderService(new ProviderRegistry(), [adapter]);
    await expect(
      service.invoke({ providerId: 'kanbanflow', capability: 'review.view', input: {} }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(backend.requests).toEqual([]);
  });

  it('requires a configured service route before invoking KanbanFlow', async () => {
    const backend = new StatefulKf();
    const service = new ProviderService(new ProviderRegistry(), [
      createKanbanFlowAdapter(backend, options),
    ]);
    await expect(
      service.invoke({ providerId: 'kanbanflow', capability: 'issue.list', input: {} }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ROUTE_REQUIRED' });
    expect(backend.requests).toEqual([]);
  });

  it('rejects non-object and invalid string inputs structurally before invoking kf', async () => {
    const backend = new StatefulKf();
    const adapter = createKanbanFlowAdapter(backend, options);
    const invalidInvocations = [
      { capability: 'issue.list', input: null },
      { capability: 'issue.view', input: {} },
      { capability: 'issue.create', input: { title: 7 } },
      { capability: 'issue.comment', input: { id: 'T1', body: '' } },
      { capability: 'issue.edit', input: { id: 'T1', title: 7 } },
    ] as const;
    for (const invocation of invalidInvocations) {
      let failure: unknown;
      try {
        await adapter.invoke({ providerId: 'kanbanflow', ...invocation } as never);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ProviderError);
      expect(failure).toMatchObject({ code: 'PROVIDER_INVALID' });
    }
    expect(backend.requests).toEqual([]);
  });

  it('turns malformed JSON into a structured response failure', async () => {
    const executor: ProviderProcessExecutor = {
      execute: async () => ({ exitCode: 0, stdout: 'not-json', stderr: '' }),
    };
    await expect(
      createKanbanFlowAdapter(executor, options).invoke({
        providerId: 'kanbanflow',
        capability: 'issue.list',
        input: {},
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it.each([
    [
      { exitCode: 1, stdout: '', stderr: 'token secret-value rejected', failure: 'auth' as const },
      'AUTH_FAILURE',
    ],
    [{ exitCode: 7, stdout: '', stderr: 'token secret-value exploded' }, 'COMMAND_FAILURE'],
  ])('maps process failures without leaking provider diagnostics', async (result, code) => {
    const executor: ProviderProcessExecutor = { execute: async () => result };
    let caught: unknown;
    try {
      await createKanbanFlowAdapter(executor, options).invoke({
        providerId: 'kanbanflow',
        capability: 'issue.list',
        input: {},
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect(caught).toMatchObject({ code });
    expect(JSON.stringify(caught)).not.toContain('secret-value');
    expect(String(caught)).not.toContain('secret-value');
  });
});

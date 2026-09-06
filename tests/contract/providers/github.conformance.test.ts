import { expect } from 'vitest';
import type {
  IssueCapability,
  ProviderProcessExecutor,
  ProviderProcessRequest,
  ProviderProcessResult,
} from '@mpx/providers';
import { defineIssueAdapterConformance } from '@mpx/providers/testing';
import { createBuiltinProviderService, providerRegistry } from '@mpx/providers';

interface NativeIssue {
  number: number;
  id: string;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED';
  labels: { name: string }[];
  url: string;
  assignees: { login: string }[];
}

class StatefulGh implements ProviderProcessExecutor {
  readonly requests: ProviderProcessRequest[] = [];
  private next = 2;
  private readonly issues = new Map<number, NativeIssue>([[1, this.issue(1, 'Seed', 'Initial')]]);

  async execute(request: ProviderProcessRequest): Promise<ProviderProcessResult> {
    this.requests.push(request);
    expect(request.argv[0]).toBe('gh');
    const a = request.argv.slice(1);
    if (a[0] === 'issue' && a[1] === 'list') {
      return this.ok([...this.issues.values()]);
    }
    if (a[0] === 'issue' && a[1] === 'view') {
      return this.ok(this.get(Number(a[2])));
    }
    if (a[0] === 'issue' && a[1] === 'create') {
      const number = this.next++;
      const value = this.issue(number, this.after(a, '--title'), this.after(a, '--body'));
      this.issues.set(number, value);
      return { exitCode: 0, stdout: `${value.url}\n`, stderr: '' };
    }
    if (a[0] === 'issue' && a[1] === 'edit') {
      const value = this.get(Number(a[2]));
      if (a.includes('--title')) {
        value.title = this.after(a, '--title');
      }
      if (a.includes('--body')) {
        value.body = this.after(a, '--body');
      }
      if (a.includes('--add-label')) {
        value.labels.push({ name: this.after(a, '--add-label') });
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (a[0] === 'issue' && a[1] === 'close') {
      this.get(Number(a[2])).state = 'CLOSED';
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (a[0] === 'issue' && a[1] === 'comment') {
      return {
        exitCode: 0,
        stdout: `https://github.test/o/r/issues/${a[2]}#issuecomment-9\n`,
        stderr: '',
      };
    }
    if (a[0] === 'api') {
      return this.ok({
        id: 9,
        node_id: 'IC_9',
        body: this.after(this.requests.at(-2)!.argv, '--body'),
        user: { login: 'octocat' },
        created_at: '2026-01-02T03:04:05Z',
        issue_url: `https://api.github.test/repos/o/r/issues/${this.requests.at(-2)!.argv[3]}`,
      });
    }
    return { exitCode: 1, stdout: '', stderr: 'unexpected fake command' };
  }

  private issue(number: number, title: string, body: string): NativeIssue {
    return {
      number,
      id: `I_${number}`,
      title,
      body,
      state: 'OPEN',
      labels: [],
      url: `https://github.test/o/r/issues/${number}`,
      assignees: [],
    };
  }
  private get(number: number): NativeIssue {
    const value = this.issues.get(number);
    if (!value) {
      throw new Error('missing fake issue');
    }
    return value;
  }
  private after(argv: readonly string[], flag: string): string {
    return argv[argv.indexOf(flag) + 1]!;
  }
  private ok(value: unknown): ProviderProcessResult {
    return { exitCode: 0, stdout: JSON.stringify(value), stderr: '' };
  }
}

defineIssueAdapterConformance('GitHub issue adapter', () => {
  const gh = new StatefulGh();
  const service = createBuiltinProviderService(gh, { providerId: 'github' });
  return {
    capabilities: providerRegistry
      .get('github', 'issues')
      .capabilities.filter((value): value is IssueCapability => value.startsWith('issue.')),
    invoke: (capability, input) =>
      service.invoke({
        providerId: 'github',
        capability,
        route: 'personal',
        input: input as never,
      }),
  };
});

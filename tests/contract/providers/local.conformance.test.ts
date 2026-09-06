import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IssueCapability } from '@mpx/providers';
import { createBuiltinProviderService, providerRegistry } from '@mpx/providers';
import { defineIssueAdapterConformance } from '@mpx/providers/testing';

function seed(root: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, '.mpx-index.json'),
    JSON.stringify({ schemaVersion: 1, next: 2, files: { '1': '000001-seed.md' } }),
  );
  writeFileSync(
    path.join(root, '000001-seed.md'),
    `---\nschemaVersion: 2\nid: "1"\nproject: "test/local"\ntitle: "Seed"\nkind: "task"\npriority: "normal"\nlabels: []\nassignees: []\nstate: "open"\nlocalState: "todo"\ncreatedAt: "2026-01-02T03:04:05.000Z"\nupdatedAt: "2026-01-02T03:04:05.000Z"\nplan: ""\neffort: ""\ncapture: ""\nblockedBy: []\nblocks: []\nrelated: []\nrelationships: {"children":[],"related":[],"duplicates":[]}\n---\nInitial`,
  );
}

defineIssueAdapterConformance('local issue adapter', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mpx-local-conformance-'));
  seed(root);
  const service = createBuiltinProviderService(
    { execute: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
    {
      providerId: 'local',
      local: {
        root,
        projectId: 'test/local',
      },
    },
  );
  return {
    capabilities: providerRegistry
      .get('local', 'issues')
      .capabilities.filter(
        (value): value is IssueCapability =>
          value.startsWith('issue.') && !value.startsWith('issue.dependency.'),
      ),
    invoke: (capability, input) =>
      service.invoke({
        providerId: 'local',
        capability,
        input: input as never,
      }),
  };
});

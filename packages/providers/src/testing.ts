import { describe, expect, it } from 'vitest';
import type { IssueV1 } from './contracts.js';
import type { IssueCapability } from './registry.js';

export interface IssueConformanceDriver {
  readonly capabilities: readonly IssueCapability[];
  invoke(capability: IssueCapability, input: Record<string, unknown>): Promise<unknown>;
}

export function defineIssueAdapterConformance(
  name: string,
  createDriver: () => IssueConformanceDriver,
): void {
  // oxlint-disable-next-line vitest/valid-title -- adapter name intentionally defines the conformance suite title
  describe(name, () => {
    it('preserves normalized state through list, view, create, edit, comment, label, and finish', async () => {
      const driver = createDriver();
      const listed = (await driver.invoke('issue.list', {})) as readonly IssueV1[];
      expect(listed).toHaveLength(1);
      expect(listed[0]).toEqual({
        schemaVersion: 1,
        id: expect.any(String),
        title: 'Seed',
        body: 'Initial',
        state: 'open',
        labels: [],
        providerData: expect.any(Object),
        ...('url' in listed[0]! ? { url: expect.any(String) } : {}),
        ...('assignees' in listed[0]! ? { assignees: expect.any(Array) } : {}),
      });
      const providerData = listed[0]!.providerData!;
      expect(Object.keys(providerData)).toHaveLength(1);
      expect(Object.values(providerData)[0]).toEqual(expect.any(Object));
      expect(listed[0]).not.toHaveProperty('nativeId');
      expect(listed[0]).not.toHaveProperty('number');
      expect(listed[0]).not.toHaveProperty('iid');
      expect(listed[0]).not.toHaveProperty('columnId');
      const viewed = (await driver.invoke('issue.view', { id: listed[0]!.id })) as IssueV1;
      expect(viewed).toMatchObject({
        schemaVersion: 1,
        title: 'Seed',
        state: 'open',
        labels: [],
        providerData: expect.any(Object),
      });
      expect(viewed).not.toHaveProperty('nativeId');

      const created = (await driver.invoke('issue.create', {
        title: 'Created',
        body: 'Body',
      })) as IssueV1;
      expect(created).toMatchObject({
        schemaVersion: 1,
        title: 'Created',
        body: 'Body',
        state: 'open',
        labels: [],
      });
      const edited = (await driver.invoke('issue.edit', {
        id: created.id,
        title: 'Edited',
        body: 'Updated',
      })) as IssueV1;
      expect(edited).toMatchObject({ id: created.id, title: 'Edited', body: 'Updated' });
      await expect(
        driver.invoke('issue.comment', { id: created.id, body: 'Comment' }),
      ).resolves.toMatchObject({
        schemaVersion: 1,
        issueId: created.id,
        body: 'Comment',
        providerData: expect.any(Object),
      });
      const labelled = (await driver.invoke('issue.label', {
        id: created.id,
        label: 'phase-e',
      })) as IssueV1;
      expect(labelled.labels).toEqual(['phase-e']);
      await expect(driver.invoke('issue.finish', { id: created.id })).resolves.toMatchObject({
        id: created.id,
        state: 'finished',
      });
    });

    it('moves issues only when declared and otherwise fails structurally', async () => {
      const driver = createDriver();
      const created = (await driver.invoke('issue.create', {
        title: 'Move',
        body: 'Body',
      })) as IssueV1;
      const moving = driver.invoke('issue.move', { id: created.id, destination: 'Done' });
      if (driver.capabilities.includes('issue.move')) {
        await expect(moving).resolves.toMatchObject({
          id: created.id,
          providerData: expect.any(Object),
        });
      } else {
        await expect(moving).rejects.toMatchObject({
          code: 'CAPABILITY_UNSUPPORTED',
          capability: 'issue.move',
          retryable: false,
        });
      }
    });
  });
}

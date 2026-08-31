import { expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntimeSessionObservationV1 } from '@mpx/runtime-contracts';
import {
  NodeRuntimeStatusEnvelopeMaterializer,
  composeRuntimeSessionObservation,
} from '../../src/launch-execution.js';
import { composeRuntimeStatusEnvelopeV1 } from '@mpx/status';

it('composes a fresh session observation into the runtime status envelope', () => {
  const generatedAt = '2025-02-02T03:04:05.000Z';
  const binding = { launchKey: 'launch', runtimeId: 'pi', repositoryId: 'repo' };
  const envelope = composeRuntimeStatusEnvelopeV1({
    generatedAt,
    binding,
    harness: { kind: 'pi', version: null, surface: 'footer' },
    contributions: [],
  });
  const observation = createRuntimeSessionObservationV1({
    runtime: 'pi',
    identityRef: 'personal:me',
    runtimeQualifiedId: 'pi:native',
    displayId: 'native',
    title: 'Focused work',
    resumeState: 'resumable',
    lifecycleState: 'active',
    workflowStatus: 'unfinished',
    inbox: true,
    dispositionAt: null,
    capturedAt: generatedAt,
    freshUntil: '2025-02-02T03:05:05.000Z',
    source: 'sessions:lifecycle',
    diagnostic: null,
  });

  const composed = composeRuntimeSessionObservation(
    envelope,
    observation,
    '2025-02-02T03:04:30.000Z',
  );

  expect(composed.session).toEqual({
    source: 'cache',
    state: 'current',
    capturedAt: generatedAt,
    freshUntil: '2025-02-02T03:05:05.000Z',
    diagnostic: null,
    unavailable: null,
    elapsedMs: null,
    turns: null,
    title: 'Focused work',
  });
});

it('preserves native runtime session authority over lower-priority cached observations', () => {
  const generatedAt = '2025-02-02T03:04:05.000Z';
  const binding = { launchKey: 'launch', runtimeId: 'claude', repositoryId: 'repo' };
  const native = {
    source: 'native' as const,
    state: 'current' as const,
    capturedAt: generatedAt,
    freshUntil: '2025-02-02T03:05:05.000Z',
    diagnostic: null,
    unavailable: null,
  };
  const envelope = composeRuntimeStatusEnvelopeV1({
    generatedAt,
    binding,
    harness: { kind: 'claude', version: null, surface: 'statusline' },
    contributions: [
      {
        source: 'runtime',
        binding,
        groups: { session: { ...native, elapsedMs: 42, turns: 1, title: 'Native' } },
      },
    ],
  });
  const observation = createRuntimeSessionObservationV1({
    runtime: 'claude',
    identityRef: 'work:me',
    runtimeQualifiedId: 'claude:cached',
    displayId: 'cached',
    title: 'Cached',
    resumeState: 'resumable',
    lifecycleState: 'active',
    workflowStatus: 'unfinished',
    inbox: true,
    dispositionAt: null,
    capturedAt: generatedAt,
    freshUntil: '2025-02-02T03:06:05.000Z',
    source: 'sessions:lifecycle',
    diagnostic: null,
  });

  expect(
    composeRuntimeSessionObservation(envelope, observation, generatedAt).session,
  ).toMatchObject({ source: 'native', title: 'Native', elapsedMs: 42 });
});

it('maps stale and diagnostic lifecycle observations to explicit freshness', () => {
  const generatedAt = '2025-02-02T03:04:05.000Z';
  const binding = { launchKey: 'launch', runtimeId: 'claude', repositoryId: 'repo' };
  const envelope = composeRuntimeStatusEnvelopeV1({
    generatedAt,
    binding,
    harness: { kind: 'claude', version: null, surface: 'statusline' },
    contributions: [],
  });
  const base = {
    runtime: 'claude' as const,
    identityRef: 'work:me',
    runtimeQualifiedId: 'claude:native',
    displayId: 'native',
    title: null,
    resumeState: 'unknown' as const,
    lifecycleState: 'unknown' as const,
    workflowStatus: 'unfinished' as const,
    inbox: true,
    dispositionAt: null,
    capturedAt: generatedAt,
    freshUntil: generatedAt,
    source: 'sessions:lifecycle',
  };
  expect(
    composeRuntimeSessionObservation(
      envelope,
      createRuntimeSessionObservationV1({ ...base, diagnostic: null }),
      '2025-02-02T03:04:06.000Z',
    ).session.state,
  ).toBe('stale');
  expect(
    composeRuntimeSessionObservation(
      envelope,
      createRuntimeSessionObservationV1({ ...base, diagnostic: 'SESSION_SOURCE_MALFORMED' }),
      generatedAt,
    ).session,
  ).toMatchObject({
    source: 'cache',
    state: 'error',
    capturedAt: generatedAt,
    freshUntil: null,
    diagnostic: 'SESSION_SOURCE_MALFORMED',
    unavailable: null,
  });
});

it('durably refreshes a proof-bound live envelope across process restart and quarantines malformed observations', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-live-status-'));
  try {
    const generatedAt = '2025-02-02T03:04:05.000Z';
    const binding = { launchKey: 'a'.repeat(64), runtimeId: 'pi', repositoryId: 'repo' };
    const initial = composeRuntimeStatusEnvelopeV1({
      generatedAt,
      binding,
      harness: { kind: 'pi', version: null, surface: 'footer' },
      contributions: [],
    });
    const authority = { descriptorDigest: 'b'.repeat(64), runtimeRootDigest: 'c'.repeat(64) };
    const first = new NodeRuntimeStatusEnvelopeMaterializer(root);
    const file = await first.materialize({ envelope: initial, authority });
    await writeFile(file, '{malformed');
    const restarted = new NodeRuntimeStatusEnvelopeMaterializer(root);
    const refreshed = { ...initial, generatedAt: '2025-02-02T03:04:06.000Z' };
    expect(await restarted.materialize({ envelope: refreshed, authority })).toBe(file);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      generatedAt: refreshed.generatedAt,
      binding,
    });
    expect((await readdir(path.dirname(file))).some((name) => name.includes('quarantine'))).toBe(
      true,
    );
    await expect(
      restarted.materialize({
        envelope: refreshed,
        authority: { ...authority, runtimeRootDigest: 'd'.repeat(64) },
      }),
    ).rejects.toMatchObject({ code: 'RUNTIME_STATUS_BINDING_INVALID' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

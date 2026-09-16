import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import {
  runNativeExtensionFilterFeasibilityFixture,
  runSubagentIsolationFixture,
  type NativeExtensionFilterEvidence,
  type SubagentIsolationEvidence,
} from './fixtures/subagent-isolation.js';

const parentOnlyExtensions = [
  'orca-agent-status',
  'orca-titlebar-spinner',
  'orca-prefill',
] as const;
const retainedExtensions = ['authorized-test-mcp', 'authorized-safeguard'] as const;
const parentOnlyExtensionNames = new Set<string>(parentOnlyExtensions);
const retainedExtensionNames = new Set<string>(retainedExtensions);
let evidence: SubagentIsolationEvidence;
let nativeFilterEvidence: NativeExtensionFilterEvidence;

before(async () => {
  evidence = await runSubagentIsolationFixture();
  nativeFilterEvidence = await runNativeExtensionFilterFeasibilityFixture();
});

test('native parent-only hooks remain functional in the parent session', () => {
  const activations = evidence.parent.activations.filter((activation) =>
    parentOnlyExtensionNames.has(activation.name),
  );
  assert.deepEqual(
    activations.map((activation) => activation.name),
    [...parentOnlyExtensions].sort(),
  );
  for (const activation of activations) {
    assert.equal(activation.run, 'parent');
    assert.equal(activation.settledEvents, 1);
    assert.equal(activation.eventBusEvents, 1);
    assert.equal(activation.processEvents, 1);
    assert.ok(evidence.parent.activeToolNames.includes(`${activation.name}-tool`));
  }
});

test('same-process child sessions exclude parent-only native extensions before their factories run', () => {
  for (const child of [evidence.baselineChild, evidence.excludedChild]) {
    const activations = child.activations.filter((activation) =>
      parentOnlyExtensionNames.has(activation.name),
    );
    assert.deepEqual(activations, []);
    for (const extensionName of parentOnlyExtensions) {
      assert.ok(!child.allToolNames.includes(`${extensionName}-tool`));
      assert.ok(!child.activeToolNames.includes(`${extensionName}-tool`));
    }
    assert.equal(child.requestedConfigMarkerLoaded, true);
    for (const deniedBuiltin of ['bash', 'edit', 'write']) {
      assert.ok(!child.activeToolNames.includes(deniedBuiltin));
    }
  }
});

test('child runner intersects built-in and extension tools with the inherited ceiling', () => {
  for (const child of [evidence.baselineChild, evidence.excludedChild]) {
    assert.ok(child.activeToolNames.includes('read'));
    assert.ok(!child.allToolNames.includes('bash'));
    assert.ok(!child.activeToolNames.includes('bash'));
    for (const extensionName of retainedExtensions) {
      assert.ok(child.activeToolNames.includes(`${extensionName}-tool`));
    }
  }
});

test('authorized tools, safeguards, and skills remain available in the excluded-child fixture', () => {
  const retainedActivations = evidence.excludedChild.activations.filter((activation) =>
    retainedExtensionNames.has(activation.name),
  );
  assert.equal(retainedActivations.length, retainedExtensions.length);
  for (const activation of retainedActivations) {
    assert.equal(activation.settledEvents, 1);
    assert.ok(evidence.excludedChild.allToolNames.includes(`${activation.name}-tool`));
    assert.ok(evidence.excludedChild.activeToolNames.includes(`${activation.name}-tool`));
  }
  assert.equal(evidence.excludedChild.authorizedSkillLoaded, true);
  assert.equal(evidence.providerRequests, 0);
});

test('settings extension exclusions filter auto-discovered paths before factories run', () => {
  assert.deepEqual(
    nativeFilterEvidence.postLoadOverride.factoryActivations,
    [...parentOnlyExtensions, ...retainedExtensions].sort(),
  );
  assert.deepEqual(
    nativeFilterEvidence.postLoadOverride.loadedExtensions,
    [...retainedExtensions].sort(),
  );
  assert.deepEqual(
    nativeFilterEvidence.settingsPatterns.factoryActivations,
    [...retainedExtensions].sort(),
  );
  assert.deepEqual(
    nativeFilterEvidence.settingsPatterns.loadedExtensions,
    [...retainedExtensions].sort(),
  );
});

import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import {
  runSubagentPolicyFixture,
  type SubagentPolicyEvidence,
} from './fixtures/subagent-policy.js';

let evidence: SubagentPolicyEvidence;

before(async () => {
  evidence = await runSubagentPolicyFixture();
});

test('explicit model and thinking choices override profile defaults without fake override metadata', () => {
  assert.equal(evidence.explicit.modelInput, 'fixture/requested');
  assert.equal(evidence.explicit.modelFromParams, true);
  assert.equal(evidence.explicit.thinking, 'high');
  assert.equal(evidence.explicit.overridden, undefined);
});

test('caller max_turns may tighten but cannot raise the profile safety ceiling', () => {
  assert.equal(evidence.tighterMaxTurns, 5);
  assert.equal(evidence.cappedMaxTurns, 12);
});

test('omitted allowed_subagents receives the global grant while explicit denial remains empty', () => {
  assert.equal(evidence.grants.globalDefault, 'all');
  assert.deepEqual(evidence.grants.explicitRuntimeDenial, []);
  assert.equal(evidence.grants.omitted, undefined);
  assert.deepEqual(evidence.grants.explicitFalse, []);
  assert.deepEqual(evidence.grants.none, []);
  assert.deepEqual(evidence.grants.empty, []);
  assert.deepEqual(evidence.grants.emptyList, []);
  assert.equal(evidence.grants.all, 'all');
  assert.deepEqual(evidence.grants.selected, ['Explore', 'Plan']);
});

import { test } from 'node:test';
import { runCoordinatorFixture } from './fixtures/subagent-coordinator.js';

test('native coordinator receipts, idle recovery, abort, final settlement and saved context', { timeout: 60000 }, runCoordinatorFixture);

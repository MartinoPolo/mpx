import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { checkOutput } from '../src/compiler.js';

const root = fileURLToPath(new URL('../', import.meta.url));
test('built projections match the retained canonical content slice', async () => {
  assert.deepEqual(await checkOutput(root), [], 'Run pnpm build after canonical content changes.');
});

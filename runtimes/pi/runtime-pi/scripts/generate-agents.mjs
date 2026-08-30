import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePiAgents } from './agent-generator.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../../');
const source = path.join(root, 'content', 'agents');
const output = path.join(here, '..', 'projection', 'agents');
const check = process.argv.includes('--check');
const result = await generatePiAgents({ source, output, check });
if (result.drift.length) {
  console.error(`Generated Pi agents drifted: ${result.drift.join(', ')}`);
  process.exitCode = 1;
} else if (!check) {
  console.log(`Generated ${result.changed.length} Pi agents.`);
}

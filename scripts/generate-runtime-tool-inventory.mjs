import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registryFile = path.join(root, 'packages/runtime-tools/src/runtime-tool-registry.ts');
const outputFile = path.join(root, 'docs/inventory/PHASE_F1_RUNTIME_TOOL_INVENTORY.json');
const executorFile = path.join(root, 'packages/executors/src/index.ts');
const stable = (value) =>
  Array.isArray(value)
    ? `[${value.map(stable).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
          .join(',')}}`
      : JSON.stringify(value);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const source = await readFile(registryFile, 'utf8');
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = await import(
  `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
);
const entries = module.RUNTIME_TOOL_REGISTRY;
const inventory = {
  schemaVersion: 1,
  sourceRegistry: 'packages/runtime-tools/src/runtime-tool-registry.ts',
  runtimeToolInventorySha256: sha(stable(entries)),
  executorEvidenceSource: 'packages/executors/src/index.ts',
  executorEvidenceBindingSha256: sha(await readFile(executorFile)),
  productionBackend: 'apps/cli/src/sbx-execution.ts#createProductionSbxExecutionAdapter',
  lifecycleAdapter:
    'packages/executors/src/standalone-sbx-executor.ts#StandaloneSbxLifecycleAdapter',
  counts: {
    topLevel: entries.filter((entry) => entry.category === 'aggregate').length,
    childAccessible: entries.filter((entry) => entry.category === 'child-operation').length,
    total: entries.length,
  },
  entries,
};
const rendered = `${JSON.stringify(inventory, null, 2)}\n`;
if (process.argv.includes('--check')) {
  const current = await readFile(outputFile, 'utf8').catch(() => '');
  if (current !== rendered) {
    console.error('PHASE_F1_RUNTIME_TOOL_INVENTORY.json is stale');
    process.exitCode = 1;
  }
} else {
  await writeFile(outputFile, rendered);
}

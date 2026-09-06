import { readFile } from 'node:fs/promises';
import { ProductionInstallerOperationAdapter } from '@mpx/installer';

const { environment, operation, locator } = JSON.parse(await readFile(process.argv[2], 'utf8'));
const forbidden = async () => {
  throw new Error('Retained projection attempted a resource operation.');
};
const adapter = new ProductionInstallerOperationAdapter(environment, 'disposable', {
  files: { read: forbidden, write: forbidden, create: forbidden, remove: forbidden },
  resources: { read: forbidden, write: forbidden, remove: forbidden },
});
await adapter.hydrateReceiptOperation(operation, locator);
await adapter.apply(operation);
process.stdout.write(JSON.stringify({ digest: await adapter.observe(operation) }));

import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { NodeRepositoryLock } from '../dist/index.js';

const [mode, directory, key] = process.argv.slice(2);
if (mode === 'owned') {
  await new NodeRepositoryLock(directory).acquire(key);
  process.send?.({ type: 'created' });
} else if (mode === 'ownerless') {
  const name = `${createHash('sha256').update(key).digest('hex')}.json.lock`;
  await mkdir(directory, { recursive: true });
  await mkdir(path.join(directory, name));
  process.send?.({ type: 'created' });
} else {
  throw new Error(`Unknown mode ${mode}`);
}
await new Promise(() => undefined);

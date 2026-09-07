import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default async function setup(project) {
  const root = await mkdtemp(join(tmpdir(), 'mpx-test-run-'));
  project.config.env = {
    ...project.config.env,
    TMP: root,
    TEMP: root,
    TMPDIR: root,
  };

  return async function teardown() {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  };
}

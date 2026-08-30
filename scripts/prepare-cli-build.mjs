import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toLowerCase().includes('filter')),
);

const args = ['-r', '--filter', 'mpx...', '--filter', '!mpx', 'build'];
const command = process.platform === 'win32' ? process.env.ComSpec : 'pnpm';
if (!command) {
  throw new Error('CLI build preparation requires a command shell');
}

execFileSync(
  command,
  process.platform === 'win32' ? ['/d', '/s', '/c', `pnpm ${args.join(' ')}`] : args,
  {
    cwd: root,
    env,
    stdio: 'inherit',
  },
);

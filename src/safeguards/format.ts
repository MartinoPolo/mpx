import { readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { localBin, repositoryRoot } from './fallow.js';
import { runBounded, type ProcessResult } from './process.js';

const PRETTIER = ['.prettierrc', '.prettierrc.json', '.prettierrc.yml', '.prettierrc.yaml', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', 'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs'];
export interface FormatResult { changed: boolean; diagnostics: string[] }
export interface FormatOptions {
  isTrusted: (root: string) => boolean | Promise<boolean>;
  run?: (executable: string, args: string[], cwd: string, timeout: number) => Promise<ProcessResult>;
  timeoutMs?: number;
}
/** Await one explicit formatter for exactly the edited file. Never lint, stage or roll back. */
export async function formatEditedFile(file: string, cwd: string, options: FormatOptions): Promise<FormatResult> {
  const deadline = Date.now() + Math.min(options.timeoutMs ?? 4500, 4500);
  const target = await realpath(path.resolve(cwd, file)).catch(() => path.resolve(cwd, file));
  const root = await repositoryRoot(path.dirname(target));
  if (!root) return { changed: false, diagnostics: [] };
  const warning = (reason: string): FormatResult => ({ changed: false, diagnostics: [`Formatter skipped/incomplete: ${reason}; the agent edit is preserved. Run the project's explicit formatting command.`] });
  try {
    let directory = path.dirname(target); let tool: string | undefined; let configDirectory = root;
    while (true) {
      if ((await Promise.all(PRETTIER.map(name => stat(path.join(directory, name)).catch(() => undefined)))).some(info => info?.isFile())) tool = 'prettier';
      if ((await stat(path.join(directory, 'biome.json')).catch(() => undefined))?.isFile() || (await stat(path.join(directory, 'biome.jsonc')).catch(() => undefined))?.isFile()) tool = 'biome';
      if (path.extname(target) === '.py') {
        if ((await stat(path.join(directory, 'ruff.toml')).catch(() => undefined))?.isFile() || (await stat(path.join(directory, '.ruff.toml')).catch(() => undefined))?.isFile()) tool = 'ruff';
        const pyproject = path.join(directory, 'pyproject.toml');
        const pyInfo = await stat(pyproject).catch(() => undefined);
        if (pyInfo?.isFile() && pyInfo.size < 1024 * 1024 && /^\[tool\.ruff(?:\.|\])/m.test(await readFile(pyproject, 'utf8'))) tool = 'ruff';
      }
      const pkgFile = path.join(directory, 'package.json');
      const info = await stat(pkgFile).catch(() => undefined);
      if (!tool && info?.isFile() && info.size < 1024 * 1024) {
        const pkg: unknown = JSON.parse(await readFile(pkgFile, 'utf8'));
        if (pkg && typeof pkg === 'object' && 'prettier' in pkg) tool = 'prettier';
      }
      if (tool) { configDirectory = directory; break; }
      if (directory === root) break;
      directory = path.dirname(directory);
    }
    if (!tool) return { changed: false, diagnostics: [] };
    if (!await options.isTrusted(root)) return warning('effective repository is not natively trusted');
    let bin = await localBin(configDirectory, tool) ?? await localBin(root, tool);
    if (!bin && tool === 'ruff') {
      const venvBin = path.join(root, process.platform === 'win32' ? '.venv/Scripts/ruff.exe' : '.venv/bin/ruff');
      if ((await stat(venvBin).catch(() => undefined))?.isFile()) bin = venvBin;
    }
    if (!bin) return warning(`configured ${tool} has no project-local installation`);
    if ((await stat(path.join(root, '.gitignore')).catch(() => undefined))?.isFile()) {
      const ignored = await runBounded('git', ['-C', root, 'check-ignore', '--no-index', '-q', '--', target], path.dirname(fileURLToPath(import.meta.url)), Math.max(1, deadline - Date.now()));
      if (ignored.code === 0 && !ignored.incomplete) return { changed: false, diagnostics: [] };
      if (ignored.code !== 1 || ignored.incomplete) return warning('project ignore rules could not be verified');
    }
    const before = await stat(target);
    if (!before.isFile() || before.size > 8 * 1024 * 1024) return warning('edited file is not a bounded regular file');
    const bytes = await readFile(target);
    const args = tool === 'prettier' ? ['--write', '--ignore-unknown'] : tool === 'ruff' ? ['format', '--force-exclude'] : ['format', '--write', '--files-ignore-unknown=true'];
    // Preserve the formatter's own ignores and also native Git ignores. Prettier supports repeated paths.
    if (tool === 'prettier') for (const name of ['.gitignore', '.prettierignore']) {
      const ignore = path.join(root, name);
      if ((await stat(ignore).catch(() => undefined))?.isFile()) args.push('--ignore-path', ignore);
    }
    args.push('--', target);
    const remaining = deadline - Date.now();
    if (remaining <= 0) return warning('five-second budget exhausted before execution');
    const nativeExecutable = /\.exe$/i.test(bin);
    const result = await (options.run ?? runBounded)(nativeExecutable ? bin : 'bash', nativeExecutable ? args : ['--noprofile', '--norc', '-c', 'exec "$@"', 'mpx-format', bin, ...args], root, remaining);
    const changed = !bytes.equals(await readFile(target));
    const diagnostics = result.incomplete || result.code !== 0 ? warning(result.incomplete ?? 'formatter error').diagnostics : [];
    if (changed) diagnostics.unshift(`${tool} formatted the edited file: ${file}`);
    return { changed, diagnostics };
  } catch { return warning('configuration, file or formatter unavailable'); }
}

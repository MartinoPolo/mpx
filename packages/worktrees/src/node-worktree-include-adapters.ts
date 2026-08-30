import { execFile } from 'node:child_process';
import { access, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import {
  productionTrustedExecutablePolicy,
  resolveTrustedExecutable,
  revalidateTrustedExecutable,
  type TrustedExecutablePolicy,
} from './trusted-executable.js';
import type { WorktreeIncludeDependencies } from './worktree-include.js';

function execute(gitExecutable: string, args: readonly string[], cwd: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      gitExecutable,
      [...args],
      {
        cwd,
        encoding: 'buffer',
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_EDITOR: 'true',
          GIT_SEQUENCE_EDITOR: 'true',
        },
        windowsHide: true,
        shell: false,
        maxBuffer: 2 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
        } else {
          resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
        }
      },
    );
  });
}

/** Production adapters for direct Git argv execution and link-resolving Node filesystem operations. */
export function createNodeWorktreeIncludeDependencies(
  gitExecutable = 'git',
  trustedExecutablePolicy?: TrustedExecutablePolicy,
): WorktreeIncludeDependencies {
  return {
    git: {
      run: async (args, cwd) => {
        const policy = trustedExecutablePolicy ?? productionTrustedExecutablePolicy([cwd]);
        const executable = await resolveTrustedExecutable(gitExecutable, cwd, policy);
        await revalidateTrustedExecutable(executable, policy);
        return execute(executable.path, args, cwd);
      },
    },
    fs: {
      readFile,
      lstat: async (file) => {
        const value = await lstat(file);
        return {
          isFile: value.isFile(),
          isSymbolicLink: value.isSymbolicLink(),
          isReparsePoint: value.isSymbolicLink(),
          size: value.size,
        };
      },
      mkdir: (directory) => mkdir(directory, { recursive: true }).then(() => undefined),
      exists: async (file) => {
        try {
          await access(file);
          return true;
        } catch {
          return false;
        }
      },
      writeFileExclusive: (file, content) => writeFile(file, content, { flag: 'wx' }),
    },
    canonical: { resolve: realpath },
  };
}

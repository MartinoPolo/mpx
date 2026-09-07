import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  repositoryFiles,
  validateCanonicalScriptSyntax,
  validateFiles,
  validateSharedInstructionLinks,
} from '../../../scripts/validate-generated.mjs';

const messages = (diagnostics) => diagnostics.map((item) => item.code);

function files(path, content) {
  return new Map([[path, content]]);
}

describe('generated repository validation', () => {
  it('rejects broken relative links in shared instructions', () => {
    const diagnostics = validateSharedInstructionLinks(
      new Map([
        ['content/instructions/shared/A.md', 'See [missing](MISSING.md).'],
        ['content/instructions/shared/B.md', 'See [present](A.md#section).'],
      ]),
    );
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'SHARED_INSTRUCTION_LINK_MISSING',
        file: 'content/instructions/shared/A.md',
      }),
    ]);
  });

  it('keeps the canonical shared-instruction inventory complete', async () => {
    const root = path.resolve(import.meta.dirname, '../../../content/instructions/shared');
    expect(new Set(await readdir(root))).toEqual(
      new Set([
        'AUTHORING.md',
        'BOARD_CONVENTION.md',
        'deep-modules.md',
        'DESIGN_PIPELINE.md',
        'DOCUMENTATION_STRATEGY.md',
        'EXECUTOR_CONTRACT.md',
        'EXPLORATION.md',
        'GIT_COMMIT_WORKFLOW.md',
        'interface-design.md',
        'ISSUE_TRACKER.md',
        'MPX_CLI_BASIC.md',
        'MPX_CLI_REFERENCE.md',
        'PLAYWRIGHT_TESTING.md',
        'PROJECT_DOC_TEMPLATES.md',
        'REVIEWER_PROTOCOL.md',
        'SENTRY.md',
        'SUBAGENT_PROTOCOL.md',
        'WRITING_FOR_AGENTS.md',
        'providers',
      ]),
    );
  });

  it('keeps current shared-instruction relative links closed', async () => {
    const root = path.resolve(import.meta.dirname, '../../..');
    const directory = path.join(root, 'content/instructions/shared');
    const collect = async (root, relative = '') => {
      const files = [];
      for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
        const next = path.posix.join(relative, entry.name);
        if (entry.isDirectory()) {
          files.push(...(await collect(root, next)));
        } else {
          files.push(next);
        }
      }
      return files;
    };
    const names = await collect(directory);
    const current = new Map(
      await Promise.all(
        names.map(async (name) => [
          `content/instructions/shared/${name}`,
          await readFile(path.join(directory, name), 'utf8'),
        ]),
      ),
    );
    expect(validateSharedInstructionLinks(current)).toEqual([]);
  });

  it.each([
    'Run `gh issue view 42`.',
    'Read `plugins/mp/skills/shared/AUTHORING.md`.',
    'Resolve `${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs`.',
  ])('rejects forbidden legacy CLI, path, or placeholder in shared instructions: %s', (content) => {
    expect(
      messages(validateFiles(files('content/instructions/shared/LEGACY.md', content))),
    ).toContain('SHARED_INSTRUCTION_LEGACY_REFERENCE');
  });

  it('detects a malformed canonical support script at a newly nested path', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-canonical-script-'));
    const relative = 'content/skills/example/scripts/new/nested support/broken file.mjs';
    try {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), 'export const broken = ;\n');
      expect(validateCanonicalScriptSyntax(root, [relative])).toEqual([
        expect.objectContaining({ code: 'CANONICAL_SCRIPT_SYNTAX', file: relative }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('recursively syntax-checks every current canonical JavaScript support script', async () => {
    const root = path.resolve(import.meta.dirname, '../../..');
    const content = path.join(root, 'content');
    const entries = await readdir(content, { recursive: true, withFileTypes: true });
    const names = entries
      .filter((entry) => entry.isFile() && /\.(?:c?js|mjs)$/u.test(entry.name))
      .map((entry) =>
        path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'),
      );
    expect(names.length).toBeGreaterThan(0);
    expect(validateCanonicalScriptSyntax(root, names)).toEqual([]);
  });

  it.each(['/mp:ship', '/mp-gh:issue-view', '/kf:board'])(
    'rejects active legacy public identity %s',
    (identity) => {
      expect(messages(validateFiles(files('content/skills/demo/SKILL.md', identity)))).toContain(
        'LEGACY_PUBLIC_IDENTITY',
      );
    },
  );

  it('rejects the configured-path corruption marker even when content otherwise validates', () => {
    const marker = ['<configured', 'path>'].join('-');
    expect(
      messages(validateFiles(files('content/skills/demo/SKILL.md', `valid${marker}content`))),
    ).toContain('CONFIGURED_PATH_MARKER');
  });

  it.each([
    'docs/history/archive.md',
    'packages/demo/dist/generated.md',
    'content/demo/node_modules/dependency.md',
  ])('allows the configured-path marker only in explicit generated/history path %s', (file) => {
    const marker = ['<configured', 'path>'].join('-');
    expect(validateFiles(files(file, marker))).toEqual([]);
  });

  it.each([
    'corrupt â€” dash',
    'corrupt â†’ arrow',
    'corrupt Â§ section',
    'corrupt \uFFFD replacement',
  ])('rejects canonical content mojibake signature in "%s"', (content) => {
    expect(messages(validateFiles(files('content/skills/demo/SKILL.md', content)))).toContain(
      'MOJIBAKE',
    );
  });

  it.each(['scripts/intentional-fixture.mjs', 'packages/demo/src/intentional-fixture.test.ts'])(
    'allows intentional replacement characters in source/test fixture %s',
    (file) => {
      expect(validateFiles(files(file, "const fixture = '\uFFFD';"))).toEqual([]);
    },
  );

  it.each(['docs/history/archive.md', 'docs/history/nested/import.md'])(
    'allows mojibake in historical path %s',
    (file) => {
      expect(validateFiles(files(file, 'archived â€” text \uFFFD'))).toEqual([]);
    },
  );

  it('rejects doubled canonical public identities', () => {
    expect(
      messages(validateFiles(files('apps/cli/src/example.ts', 'const command = "/mpx:mpx-ship";'))),
    ).toContain('DOUBLED_MPX_IDENTITY');
  });

  it('rejects absolute legacy source-repository paths in active files', () => {
    expect(
      messages(
        validateFiles(
          files('content/skills/demo/SKILL.md', 'C:\\_MP_projects\\mpx-claude-code\\plugins'),
        ),
      ),
    ).toContain('LEGACY_SOURCE_PATH');
  });

  it.each([
    "import '../../../mpx-pi/extensions/footer.ts'",
    "readFile('~/.codex/skills/review.md')",
    "require('mpx-claude-code/plugins/mp')",
  ])('rejects active dependencies on a legacy runtime root: %s', (dependency) => {
    expect(
      messages(validateFiles(files('runtimes/pi/runtime-pi/src/dependency.ts', dependency))),
    ).toContain('LEGACY_SOURCE_DEPENDENCY');
  });

  it('rejects Claude placeholders in canonical content but permits generated Claude adapter variables', () => {
    expect(
      messages(
        validateFiles(
          new Map([
            ['content/skills/demo/SKILL.md', '${CLAUDE_PLUGIN_ROOT}'],
            [
              'runtimes/claude/runtime-claude/src/index.ts',
              '${CLAUDE_PLUGIN_ROOT} ${CLAUDE_CONFIG_DIR}',
            ],
          ]),
        ),
      ),
    ).toEqual(['CLAUDE_PLACEHOLDER']);
  });

  it('rejects legacy status-map and config readers in active runtimes', () => {
    expect(
      messages(
        validateFiles(
          files(
            'runtimes/pi/runtime-pi/src/legacy.ts',
            'readFile("status-map.json"); readFile("mp.config.json")',
          ),
        ),
      ),
    ).toEqual(expect.arrayContaining(['LEGACY_RUNTIME_READER']));
  });

  it('rejects stale Claude checkpoint and full status-revalidation claims in active compatibility docs', () => {
    expect(
      messages(
        validateFiles(
          new Map([
            [
              'runtimes/claude/runtime-claude/COMPATIBILITY.md',
              'PostToolUse revalidates the integrity checkpoint.',
            ],
            ['docs/RUNTIME_ADAPTERS.md', 'The status adapter revalidates the full projection.'],
          ]),
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        'STALE_CLAUDE_POST_TOOL_CHECKPOINT',
        'STALE_CLAUDE_FULL_STATUS_REVALIDATION',
      ]),
    );
  });

  it('does not ban legitimate PostToolUse or historical status prose', () => {
    expect(
      validateFiles(
        new Map([
          ['docs/LAUNCH.md', 'PostToolUse remains available for unrelated telemetry.'],
          ['docs/history/PHASE_F_DRAFT.md', 'The status adapter revalidates the full projection.'],
        ]),
      ),
    ).toEqual([]);
  });

  it.each(['.env', 'runtime/session.json', 'state/credentials.json', '.claude/runtime-state.json'])(
    'rejects tracked private runtime state %s',
    (path) => {
      expect(messages(validateFiles(files(path, 'secret'), { trackedFiles: [path] }))).toContain(
        'TRACKED_PRIVATE_STATE',
      );
    },
  );

  it('does not classify source and documentation about sessions as private state', () => {
    for (const path of [
      'apps/cli/src/session-command.ts',
      'packages/sessions/test/unit/sessions.test.ts',
      'docs/SESSIONS_INSTALLER.md',
    ]) {
      expect(
        messages(validateFiles(files(path, 'public source'), { trackedFiles: [path] })),
      ).not.toContain('TRACKED_PRIVATE_STATE');
    }
  });

  it('rejects nested package-manager lockfiles', () => {
    expect(
      messages(
        validateFiles(files('packages/demo/pnpm-lock.yaml', 'lockfileVersion: 9'), {
          trackedFiles: ['packages/demo/pnpm-lock.yaml'],
        }),
      ),
    ).toContain('NESTED_LOCKFILE');
  });

  it('narrowly excludes historical documentation from active identity and path checks', () => {
    expect(
      validateFiles(files('docs/history/PI_MIGRATION.md', '/mp:ship C:\\_MP_projects\\mpx-pi')),
    ).toEqual([]);
  });

  it('reports every enumerated textual read failure', async () => {
    const values = await repositoryFiles('C:/missing-repository', [
      'apps/a.ts',
      'apps/b.ts',
      'image.png',
    ]);
    expect([...values.diagnostics]).toEqual([
      expect.objectContaining({ code: 'FILE_READ_FAILED', file: 'apps/a.ts' }),
      expect.objectContaining({ code: 'FILE_READ_FAILED', file: 'apps/b.ts' }),
    ]);
  });

  it('does not read an enumerated textual file larger than the per-file bound', async () => {
    const read = vi.fn();
    const close = vi.fn();
    const values = await repositoryFiles('C:/repo', ['content/large.md'], {
      maxFileBytes: 8,
      open: async () => ({
        stat: async () => ({ isFile: () => true, size: 9, dev: 1, ino: 1 }),
        read,
        close,
      }),
    });
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect([...values.diagnostics]).toEqual([
      expect.objectContaining({ code: 'FILE_TOO_LARGE', file: 'content/large.md' }),
    ]);
  });

  it('allows only the tracked generated CLI bundle to use the larger text-read bound', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-generated-limit-'));
    await Promise.all([mkdir(path.join(root, 'bin')), mkdir(path.join(root, 'content'))]);
    const oversized = Buffer.alloc(1024 * 1024 + 1, 97);
    await Promise.all([
      writeFile(path.join(root, 'bin', 'mpx.mjs'), oversized),
      writeFile(path.join(root, 'content', 'large.md'), oversized),
    ]);
    try {
      const values = await repositoryFiles(root, ['bin/mpx.mjs', 'content/large.md'], {
        trackedFiles: ['bin/mpx.mjs', 'content/large.md'],
      });
      expect(values.get('bin/mpx.mjs')?.length).toBe(oversized.length);
      expect([...values.diagnostics]).toEqual([
        expect.objectContaining({ code: 'FILE_TOO_LARGE', file: 'content/large.md' }),
      ]);

      const untrackedBundle = await repositoryFiles(root, ['bin/mpx.mjs']);
      expect([...untrackedBundle.diagnostics]).toEqual([
        expect.objectContaining({ code: 'FILE_TOO_LARGE', file: 'bin/mpx.mjs' }),
      ]);

      await writeFile(path.join(root, 'bin', 'mpx.mjs'), Buffer.alloc(2 * 1024 * 1024 + 1, 97));
      const overBundleBound = await repositoryFiles(root, ['bin/mpx.mjs']);
      expect(overBundleBound.has('bin/mpx.mjs')).toBe(false);
      expect([...overBundleBound.diagnostics]).toEqual([
        expect.objectContaining({ code: 'FILE_TOO_LARGE', file: 'bin/mpx.mjs' }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not read an enumerated textual non-regular file', async () => {
    const read = vi.fn();
    const close = vi.fn();
    const values = await repositoryFiles('C:/repo', ['content/unsafe.md'], {
      open: async () => ({
        stat: async () => ({ isFile: () => false, size: 1, dev: 1, ino: 1 }),
        read,
        close,
      }),
    });
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect([...values.diagnostics]).toEqual([
      expect.objectContaining({ code: 'FILE_READ_FAILED', file: 'content/unsafe.md' }),
    ]);
  });

  it.each(['growth', 'replacement'])(
    'rejects deterministic file %s during a handle-bound read',
    async (failure) => {
      const content = Buffer.from('safe');
      let reads = 0;
      const close = vi.fn();
      const values = await repositoryFiles('C:/repo', ['content/racing.md'], {
        open: async () => ({
          stat: async () => ({ isFile: () => true, size: content.length, dev: 1, ino: 10 }),
          read: async (buffer, offset, length) => {
            reads += 1;
            if (reads === 1) {
              content.copy(buffer, offset, 0, length);
              return { bytesRead: length, buffer };
            }
            return { bytesRead: failure === 'growth' ? 1 : 0, buffer };
          },
          close,
        }),
        lstat: async () => ({
          isFile: () => true,
          isSymbolicLink: () => false,
          size: content.length,
          dev: 1,
          ino: failure === 'replacement' ? 11 : 10,
        }),
      });
      expect(close).toHaveBeenCalledOnce();
      expect([...values.diagnostics]).toEqual([
        expect.objectContaining({ code: 'FILE_READ_FAILED', file: 'content/racing.md' }),
      ]);
    },
  );

  it('bounds textual file reads to deterministic worker concurrency', async () => {
    let active = 0;
    let peak = 0;
    const names = Array.from({ length: 8 }, (_, index) => `content/${index}.md`);
    const values = await repositoryFiles('C:/repo', names, {
      concurrency: 2,
      open: async () => ({
        stat: async () => ({ isFile: () => true, size: 1, dev: 1, ino: 1 }),
        read: async (buffer, _offset, _length, position) => {
          if (position === 1) {
            return { bytesRead: 0, buffer };
          }
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          buffer[0] = 120;
          return { bytesRead: 1, buffer };
        },
        close: async () => {},
      }),
      lstat: async () => ({
        isFile: () => true,
        isSymbolicLink: () => false,
        size: 1,
        dev: 1,
        ino: 1,
      }),
    });
    expect(values.size).toBe(names.length);
    expect(peak).toBe(2);
  });

  it('caps injected textual file concurrency at the documented worker limit', async () => {
    let active = 0;
    let peak = 0;
    const names = Array.from({ length: 16 }, (_, index) => `content/capped-${index}.md`);
    await repositoryFiles('C:/repo', names, {
      concurrency: 100,
      open: async () => ({
        stat: async () => ({ isFile: () => true, size: 1, dev: 1, ino: 1 }),
        read: async (buffer, _offset, _length, position) => {
          if (position === 1) {
            return { bytesRead: 0, buffer };
          }
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          buffer[0] = 120;
          return { bytesRead: 1, buffer };
        },
        close: async () => {},
      }),
      lstat: async () => ({
        isFile: () => true,
        isSymbolicLink: () => false,
        size: 1,
        dev: 1,
        ino: 1,
      }),
    });
    expect(peak).toBe(8);
  });
});

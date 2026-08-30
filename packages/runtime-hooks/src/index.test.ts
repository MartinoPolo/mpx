import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildCompactContext,
  buildMachineContext,
  classifyDangerousCommand,
  dangerousCommandPolicyModuleSource,
  detectProjectEnvironment,
  evaluateFallowGate,
  evaluatePackagePolicy,
  evaluatePreCommit,
  extractCommitMessage,
  extractPostCommandContext,
  mergeCompactionInstructions,
  planCompactionInjection,
  planFileQuality,
  planNotification,
  planSessionContext,
  readCompactInstructions,
  resolveGuardObservations,
  scanAddedSecrets,
  selectPreCommitCheck,
  validateCommitFormat,
  adaptClaudeHookEvent,
} from './index.js';

function project(files: Record<string, string> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'mpx-hooks-'));
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(root, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return root;
}

describe('dangerous command classification', () => {
  const command = (...tokens: string[]): string => tokens.join(' ');
  const recursiveForce = '-' + 'rf';
  const remove = 'r' + 'm';
  const dangerousRemoveCommands = [
    command('/bin/' + remove, recursiveForce, './'),
    command(`"/usr/bin/${remove}"`, '-r', '-f', '.\\*'),
    command(`'./tools/${remove}'`, '--recursive', '--force', '//'),
    command(remove, recursiveForce, '~\\'),
    command(remove, recursiveForce, '~/*/'),
  ];
  const constrainedRemoveCommands = [
    command('/bin/' + remove, recursiveForce, 'node_modules/'),
    command(`"/usr/bin/${remove}"`, '--recursive', '--force', 'dist\\'),
    command(remove, recursiveForce, 'src/obsolete/'),
    command(remove, recursiveForce, 'src\\obsolete\\'),
  ];
  const dynamicExecutableBypasses = [
    'remove=rm; $remove -rf /',
    'echo ready\n$remove -rf /',
    'if true; then $remove -rf /',
    'remove=rm; ${remove} --recursive --force ./',
    '$(printf rm) -fr ~',
    '`printf rm` -r -f ..',
    '"/usr/bin/${remove}" -rf //',
    'r${suffix} -rf "$HOME"',
    '$remove --recursive --force ${HOME}/',
  ];
  const harmlessDynamicCommands = [
    'echo "$remove" -rf /',
    "printf '%s' '$remove --recursive --force /'",
    '$remove -rf dist',
    '$remove -rf src/obsolete',
    'echo $(printf rm) -rf /',
    'tool $remove --recursive --force /',
    '$remove -r /',
    '$remove -rf ./specific',
  ];
  const unresolvedRecursiveDeletes = [
    'flags=-rf; rm $flags /',
    'letters=rf; rm -$letters /',
    'target=/; rm -rf "$target"',
    'rm --recursive --force $(printf /)',
    'rm -rf ${DELETE_TARGET}',
  ];
  const maliciousWrappedCommands = [
    "env MODE=test sh -c 'rm -rf /'",
    `env PAYLOAD='rm -rf /' sh -c "$PAYLOAD"`,
    "env -u SAFE bash --noprofile -c 'rm -rf /'",
    "command bash -c 'rm --recursive --force ..'",
    "command -- sh -c '$PAYLOAD'",
    'sh -c \'eval "rm -rf /"\'',
    'cmd /c "rmdir /s /q C:\\"',
    'cmd.exe /d /s /c "del /f /q /s C:\\temp\\*"',
    'powershell -Command "Remove-Item -Recurse -Force C:\\"',
    'powershell -NoProfile -Command "Remove-Item -Recurse -Force C:\\"',
    "pwsh -c 'Remove-Item -r -Force /'",
    "eval 'rm -rf ~'",
    `sh -c 'bash -c "rm -rf /"'`,
  ];
  const safeWrappedCommands = [
    "env MODE=test sh -c 'rm -rf node_modules'",
    "env -u UNUSED bash --noprofile -c 'rm -rf node_modules'",
    "command bash -c 'rm -rf src/obsolete'",
    `sh -c 'printf "%s" "rm -rf /"'`,
    "sh -c 'echo rm -rf /'",
    'echo rm -rf /',
    'cmd /c "echo rmdir /s /q C:\\"',
    'cmd.exe /d /c "echo del /f /q /s C:\\temp\\*"',
    `powershell -Command "Write-Output 'Remove-Item -Recurse -Force C:\\'"`,
    `eval 'printf "%s" "rm -rf /"'`,
  ];
  const destructiveLauncherCommands = [
    'command rm -rf /',
    'command -- Remove-Item -Recurse -Force C:\\',
    'env rm -rf /',
    'env MODE=test rmdir /s /q C:\\temp',
    'env -i MODE=test del /f /q /s C:\\temp\\*',
    'env -u SAFE command -- rm --recursive --force ..',
  ];
  const safeLauncherCommands = [
    'command rm -rf node_modules',
    'command -- Remove-Item -Recurse -Force src/obsolete',
    'env rm -rf src/obsolete',
    'env MODE=test rmdir /q C:\\temp',
    'env -i MODE=test del /f /q C:\\temp\\*',
    'env -u SAFE command -- rm -rf dist',
  ];
  const envSplitStringCommands = [
    "env -S 'rm -rf /'",
    "env --split-string='rm -rf /'",
    "env --split-string 'rm -rf /'",
    "env --split-str='rm -rf /'",
    "env -iS'rm -rf /'",
    'env -S "sh -c \'rm -rf /\'"',
    `env -S 'env -S "rm -rf /"'`,
    'env -S "$PAYLOAD"',
    "command env -S'rm -rf /'",
  ];

  it.each([
    'rm -rf /',
    'rm --recursive --force ..',
    'rm -rf src',
    'DROP TABLE users',
    'truncate table logs',
    'git push --force origin main',
    'mkfs.ext4 /dev/sda',
    'dd if=/dev/zero of=/dev/nvme0n1',
    'setx PATH %PATH%;C:\\bad',
    'reg add HKCU\\Environment /v PATH',
  ])('blocks %s', (candidate) => expect(classifyDangerousCommand(candidate).action).toBe('block'));
  it.each(dangerousRemoveCommands)(
    'blocks normalized or path-qualified recursive removal: %s',
    (candidate) =>
      expect(classifyDangerousCommand(candidate)).toMatchObject({
        action: 'block',
        code: 'DANGEROUS_RECURSIVE_DELETE',
      }),
  );
  it.each([
    'rm -rf node_modules',
    'rm -rf src/obsolete',
    'git push --force-with-lease origin main',
    'setx JAVA_HOME C:\\java',
  ])('allows constrained %s', (candidate) =>
    expect(classifyDangerousCommand(candidate).action).toBe('allow'),
  );
  it.each(constrainedRemoveCommands)('allows normalized constrained removal: %s', (candidate) =>
    expect(classifyDangerousCommand(candidate)).toEqual({ action: 'allow' }),
  );
  it.each(dynamicExecutableBypasses)(
    'blocks dynamic executable recursive removal: %s',
    (candidate) =>
      expect(classifyDangerousCommand(candidate)).toEqual({
        action: 'block',
        code: 'DANGEROUS_RECURSIVE_DELETE',
        message: `Blocked: broad recursive deletion is not allowed.\nRun manually only after review: ${candidate}`,
      }),
  );
  it.each(harmlessDynamicCommands)(
    'allows harmless or constrained dynamic command use: %s',
    (candidate) => expect(classifyDangerousCommand(candidate)).toEqual({ action: 'allow' }),
  );
  it.each(unresolvedRecursiveDeletes)(
    'fails closed when recursive-delete flags or targets are dynamic: %s',
    (candidate) =>
      expect(classifyDangerousCommand(candidate)).toMatchObject({
        action: 'block',
        code: 'DANGEROUS_RECURSIVE_DELETE',
        message: expect.stringContaining('cannot be statically established'),
      }),
  );
  it.each(maliciousWrappedCommands)(
    'blocks dangerous payloads nested in command wrappers: %s',
    (candidate) => expect(classifyDangerousCommand(candidate).action).toBe('block'),
  );
  it.each(destructiveLauncherCommands)(
    'blocks destructive executables behind command/env launchers: %s',
    (candidate) => expect(classifyDangerousCommand(candidate).action).toBe('block'),
  );
  it.each(envSplitStringCommands)(
    'fails closed with a structured reason for GNU env split strings: %s',
    (candidate) =>
      expect(classifyDangerousCommand(candidate)).toMatchObject({
        action: 'block',
        code: 'OPAQUE_ENV_SPLIT_STRING',
        message: expect.stringContaining('split-string'),
      }),
  );
  it.each(safeWrappedCommands)('preserves constrained or inert wrapper payloads: %s', (candidate) =>
    expect(classifyDangerousCommand(candidate)).toEqual({ action: 'allow' }),
  );
  it.each([
    ...safeLauncherCommands,
    'env MODE=test DEBUG=1 node app.js',
    'command env -i MODE=test node app.js',
  ])(
    'allows constrained executables and ordinary assignments behind command/env launchers: %s',
    (candidate) => expect(classifyDangerousCommand(candidate)).toEqual({ action: 'allow' }),
  );
  it('fails closed with a structured reason for opaque or malformed wrappers', () => {
    expect(classifyDangerousCommand('sh -c "$PAYLOAD"')).toMatchObject({
      action: 'block',
      code: 'OPAQUE_COMMAND_WRAPPER',
      message: expect.stringContaining('statically inspect'),
    });
    expect(classifyDangerousCommand("bash -c 'rm -rf /")).toMatchObject({
      action: 'block',
      code: 'MALFORMED_COMMAND_WRAPPER',
      message: expect.stringContaining('malformed'),
    });
    expect(classifyDangerousCommand('sh -c')).toMatchObject({
      action: 'block',
      code: 'MALFORMED_COMMAND_WRAPPER',
    });
  });
  it('does not treat inert malformed text as a command wrapper', () =>
    expect(classifyDangerousCommand("echo 'sh")).toEqual({ action: 'allow' }));
  it('bounds wrapper nesting depth', () => {
    const nested = Array.from({ length: 9 }, () => '').reduce(
      (payload) => `sh -c ${JSON.stringify(payload)}`,
      'rm -rf node_modules',
    );
    expect(classifyDangerousCommand(nested)).toMatchObject({
      action: 'block',
      code: 'WRAPPER_DEPTH_EXCEEDED',
      message: expect.stringContaining('8'),
    });
  });
  it('fails closed on oversized command input', () =>
    expect(classifyDangerousCommand('x'.repeat(32_769))).toMatchObject({
      action: 'block',
      code: 'INPUT_TOO_LARGE',
    }));
  it('does not let a second deletion target bypass the allowlist', () =>
    expect(classifyDangerousCommand('rm -rf node_modules /').action).toBe('block'));
  it('exports a standalone ESM policy with exact classifier parity', async () => {
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(dangerousCommandPolicyModuleSource).toString('base64')}`;
    const standalone = (await import(moduleUrl)) as {
      classifyDangerousCommand(command: unknown): ReturnType<typeof classifyDangerousCommand>;
    };
    const commands: unknown[] = [
      ...dangerousRemoveCommands,
      ...constrainedRemoveCommands,
      ...dynamicExecutableBypasses,
      ...harmlessDynamicCommands,
      ...unresolvedRecursiveDeletes,
      ...maliciousWrappedCommands,
      ...safeWrappedCommands,
      ...destructiveLauncherCommands,
      ...safeLauncherCommands,
      ...envSplitStringCommands,
      'sh -c "$PAYLOAD"',
      "bash -c 'rm -rf /",
      'sh -c',
      Array.from({ length: 9 }, () => '').reduce(
        (payload) => `sh -c ${JSON.stringify(payload)}`,
        'rm -rf node_modules',
      ),
      'rm -fr /',
      'rm --recursive --force node_modules /',
      'rm -rf node_modules',
      'rm -rf src/obsolete',
      'rmdir /s /q C:\\temp',
      'del /f /q /s C:\\temp\\*',
      'DROP DATABASE app',
      'TRUNCATE TABLE logs',
      'git push -f upstream master',
      'git push --force-with-lease origin main',
      'git clean -xfd',
      'git clean -fd',
      'mkfs.xfs /dev/sdb',
      'dd if=/dev/urandom of=/dev/sda',
      'cat image > /dev/nvme0',
      'setx PATH C:\\bad',
      "[Environment]::SetEnvironmentVariable('PATH', 'C:\\bad')",
      'reg add HKCU\\Environment /v PATH',
      'setx JAVA_HOME C:\\java',
      'git status',
      undefined,
      'x'.repeat(32_769),
    ];
    for (const candidate of commands) {
      expect(standalone.classifyDangerousCommand(candidate)).toEqual(
        classifyDangerousCommand(candidate),
      );
    }
  });
});

describe('event-order-neutral guard contract', () => {
  it('resolves shuffled adapter observations with explicit fail-open and fail-closed infrastructure policy', () => {
    const observations = [
      { policy: 'fallow' as const, infrastructureFailure: 'audit timed out' },
      { policy: 'dangerous-command' as const, decision: { action: 'allow' as const } },
      {
        policy: 'package-manager' as const,
        decision: { action: 'block' as const, code: 'WRONG_PACKAGE_MANAGER', message: 'Use pnpm.' },
      },
    ];
    const expected = {
      action: 'block',
      code: 'WRONG_PACKAGE_MANAGER',
      message: 'Use pnpm.',
      warnings: ['fallow: audit timed out; skipped (fail-open).'],
    };
    expect(resolveGuardObservations(observations)).toEqual(expected);
    expect(resolveGuardObservations([...observations].reverse())).toEqual(expected);
    expect(
      resolveGuardObservations([
        { policy: 'dangerous-command', infrastructureFailure: 'classifier unavailable' },
      ]),
    ).toMatchObject({ action: 'block', code: 'GUARD_INFRASTRUCTURE_FAILURE' });
  });
});

describe('package and tool policy', () => {
  it('blocks a wrong package manager and directs to the detected manager', () =>
    expect(evaluatePackagePolicy('npm install', 'pnpm')).toMatchObject({
      action: 'block',
      replacement: 'pnpm',
    }));
  it('enforces the manager for every command-list segment', () =>
    expect(evaluatePackagePolicy('echo ready && npm install', 'pnpm')).toMatchObject({
      action: 'block',
      code: 'WRONG_PACKAGE_MANAGER',
      replacement: 'pnpm',
    }));
  it('blocks npx tsc even in a compound command', () =>
    expect(evaluatePackagePolicy('echo ok && npx tsc', 'pnpm').action).toBe('block'));
  it('keeps built-in-tool preferences as warnings', () =>
    expect(evaluatePackagePolicy('cd src && grep -r x .', 'pnpm')).toMatchObject({
      action: 'allow',
      warnings: [expect.stringContaining('Grep')],
    }));
  it('does not warn for a pipeline consumer', () =>
    expect(evaluatePackagePolicy('cat list | grep x', 'pnpm').warnings).toEqual([]));
});

describe('pre-commit policy', () => {
  it('produces an argv check plan while hard-blocking staged secrets', () => {
    const base = {
      command: "git commit -m 'feat: ship'",
      packageManager: 'pnpm' as const,
      toolchain: 'classic' as const,
      framework: null,
      scripts: { typecheck: 'tsc' },
    };
    expect(
      evaluatePreCommit({
        ...base,
        staged: [{ file: 'src/app.ts', diff: '+export const ok = true' }],
      }),
    ).toEqual({
      action: 'allow',
      warnings: [],
      check: {
        executable: 'pnpm',
        args: ['run', 'typecheck'],
        timeoutMilliseconds: 120000,
        failure: 'block',
        outputTailLines: 50,
      },
    });
    expect(
      evaluatePreCommit({
        ...base,
        staged: [{ file: 'src/app.ts', diff: "+api_key='1234567890'" }],
      }),
    ).toMatchObject({
      action: 'block',
      code: 'STAGED_SECRET',
      findings: [{ name: 'Generic Secret', file: 'src/app.ts' }],
    });
  });

  it('scans only added lines for known and generic secrets', () =>
    expect(scanAddedSecrets(" password='not-added'\n+api_key='1234567890'", 'app.ts')).toEqual([
      { name: 'Generic Secret', file: 'app.ts' },
    ]));
  it('bounds untrusted diff input and fails closed', () =>
    expect(() => scanAddedSecrets('+' + 'x'.repeat(1_000_001), 'app.ts')).toThrowError(
      expect.objectContaining({ code: 'INPUT_TOO_LARGE' }),
    ));
  it('extracts quoted and heredoc commit subjects', () =>
    expect(
      extractCommitMessage('git commit -m "$(cat <<\'EOF\'\nfeat(ui): ship\n\nbody\nEOF\n)"'),
    ).toBe('feat(ui): ship'));
  it('warns, but does not block, invalid or long conventional subjects', () =>
    expect(validateCommitFormat('WIP ' + 'x'.repeat(73))).toMatchObject({
      valid: false,
      warnings: [expect.any(String), expect.any(String)],
    }));
  it('prefers check:all for vite-plus and Svelte check otherwise', () => {
    expect(
      selectPreCommitCheck({
        toolchain: 'vite-plus',
        scripts: { 'check:all': 'vp check', typecheck: 'tsc' },
        framework: null,
      }),
    ).toBe('check:all');
    expect(
      selectPreCommitCheck({
        toolchain: 'classic',
        scripts: { check: 'svelte-check', tsc: 'tsc' },
        framework: 'svelte',
      }),
    ).toBe('check');
  });
});

describe('fallow gate', () => {
  it('blocks protected operations on an old binary', () =>
    expect(
      evaluateFallowGate({
        command: 'git commit -m x',
        minimumVersion: '2.46.0',
        runner: { description: 'fallow', version: '2.40.0' },
      }),
    ).toMatchObject({ action: 'block', code: 'FALLOW_VERSION_TOO_OLD' }));
  it('blocks an explicit fail verdict even if the process status is nonzero', () =>
    expect(
      evaluateFallowGate({
        command: 'git push',
        minimumVersion: '2.46.0',
        runner: { description: 'fallow', version: '2.48.0' },
        audit: { status: 2, stdout: '{"verdict":"fail"}', stderr: '' },
      }),
    ).toMatchObject({ action: 'block', code: 'FALLOW_AUDIT_FAILED' }));
  it('fails open, visibly, for missing tools and malformed audit output', () => {
    expect(evaluateFallowGate({ command: 'git commit', minimumVersion: '2.46.0' })).toMatchObject({
      action: 'allow',
      warning: expect.stringContaining('not found'),
    });
    expect(
      evaluateFallowGate({
        command: 'git commit',
        minimumVersion: '2.46.0',
        runner: { description: 'fallow', version: '2.48.0' },
        audit: { status: 2, stdout: 'not json', stderr: '' },
      }),
    ).toMatchObject({ action: 'allow', code: 'FALLOW_RUNTIME_ERROR' });
  });
  it('does not trigger on words that merely resemble git operations', () =>
    expect(evaluateFallowGate({ command: 'mygit commit', minimumVersion: '2.46.0' })).toEqual({
      action: 'allow',
    }));
});

describe('provider-neutral post-command context', () => {
  it('reports a missing PR only from an explicit MPX assumption', () =>
    expect(
      extractPostCommandContext({ operation: 'git-push', exitCode: 0, pullRequest: 'missing' }),
    ).toBe('Pushed to remote. No pull request exists for this branch yet.'));
  it('extracts a bounded provider-neutral created URL', () =>
    expect(
      extractPostCommandContext({
        operation: 'pull-request-create',
        exitCode: 0,
        pullRequestUrl: 'https://git.example.test/o/r/pulls/42',
      }),
    ).toBe('Pull request created: https://git.example.test/o/r/pulls/42'));
  it('reports package vulnerabilities', () =>
    expect(
      extractPostCommandContext({
        operation: 'package-install',
        exitCode: 0,
        stderr: 'found 3 vulnerabilities',
      }),
    ).toContain('vulnerabilities'));
});

describe('format and lint dispatch', () => {
  it('returns argv, never shell text, for vite-plus with eslint gap rules', () =>
    expect(
      planFileQuality({
        relativeFile: 'src/a file.ts',
        toolchain: 'vite-plus',
        runner: ['pnpm', 'exec'],
        configs: ['eslint.config.js'],
      }),
    ).toEqual([
      { executable: 'pnpm', args: ['exec', 'vp', 'fmt', 'src/a file.ts'], reportFailure: false },
      {
        executable: 'pnpm',
        args: ['exec', 'vp', 'lint', '--fix', 'src/a file.ts'],
        reportFailure: true,
      },
      {
        executable: 'pnpm',
        args: ['exec', 'eslint', '--fix', 'src/a file.ts'],
        reportFailure: true,
      },
    ]));
  it('rejects absolute and traversal file paths', () =>
    expect(() =>
      planFileQuality({
        relativeFile: '../secret.ts',
        toolchain: 'classic',
        runner: ['npx'],
        configs: [],
      }),
    ).toThrowError(expect.objectContaining({ code: 'UNSAFE_PATH' })));
  it('dispatches configured ruff for Python', () =>
    expect(
      planFileQuality({
        relativeFile: 'app.py',
        toolchain: 'classic',
        runner: ['npx'],
        configs: ['pyproject:tool.ruff'],
      }),
    ).toHaveLength(2));
});

describe('notification planning', () => {
  it('plans a fail-open top-level notification for equivalent Claude and Pi settled events', () => {
    const claude = planNotification({
      event: 'turn-settled',
      platform: 'win32',
      sessionRole: 'top-level',
    });
    const pi = planNotification({
      event: 'turn-settled',
      platform: 'win32',
      sessionRole: 'top-level',
    });
    expect(claude).toEqual(pi);
    expect(claude).toEqual({ action: 'flash-beep', delivery: 'background', failure: 'ignore' });
    expect(
      planNotification({ event: 'turn-settled', platform: 'win32', sessionRole: 'child' }),
    ).toEqual({ action: 'none' });
    expect(
      planNotification({ event: 'turn-settled', platform: 'linux', sessionRole: 'top-level' }),
    ).toEqual({ action: 'none' });
  });
});

describe('CODEX mirror disposition', () => {
  it('inventories only the reviewed non-private hook without private contents or an absolute home path', () => {
    const inventory = readFileSync(
      fileURLToPath(
        new URL('../../../docs/inventory/codex-mirror-disposition.json', import.meta.url),
      ),
      'utf8',
    );
    expect(inventory).not.toContain('C:/Users/');
    expect(inventory).not.toMatch(/auth\.json|sessions|credentials|history|database|cache/i);
    expect(JSON.parse(inventory)).toMatchObject({
      entries: [
        {
          source: '~/.codex/hooks/compact-context.js',
          disposition: 'canonicalized',
          destination: '@mpx/runtime-hooks',
        },
      ],
    });
  });
});

describe('runtime-neutral context contracts', () => {
  it('plans session and compaction context for delivery before the next model turn', () => {
    const environment = {
      packageManager: 'pnpm' as const,
      runner: ['pnpm', 'exec'] as const,
      toolchain: 'classic' as const,
      framework: null,
      python: false,
    };
    expect(planSessionContext({ MPX_PROJECTS: 'C:/projects' })).toMatchObject({
      delivery: 'before-next-model-turn',
      context: expect.stringContaining('MPX_PROJECTS'),
    });
    expect(
      planCompactionInjection({
        manualInstructions: 'Keep decision.',
        canonicalInstructions: 'Keep open work.',
        environment,
      }),
    ).toMatchObject({
      action: 'inject',
      failure: 'use-runtime-default',
      instructions: 'Keep decision.\n\nKeep open work.',
      postCompactContext: expect.stringContaining('pnpm'),
    });
    expect(planCompactionInjection({ canonicalInstructions: '', environment })).toMatchObject({
      action: 'default',
      failure: 'use-runtime-default',
    });
  });

  it('keeps injected machine prose free of em dashes', () =>
    expect(buildMachineContext({ MPX_PROJECTS: 'C:/projects' }).join('\n')).not.toContain('—'));

  it('builds machine context only from the public MPX root allowlist', () => {
    expect(
      buildMachineContext({
        MPX_PROJECTS: ' C:/projects ',
        MPX_WORK: '',
        HOME: 'C:/private-home',
        MPX_TOKEN: 'private',
      }),
    ).toEqual([
      'Machine roots (from MPX_* env vars; use these instead of guessing paths):',
      '- MPX_PROJECTS = C:/projects - personal projects',
      'Paths outside the working directory should be resolved from these variables.',
    ]);
  });
});

describe('compact instructions and context', () => {
  it('merges manual instructions before canonical instructions and fails open on missing canonical text', () => {
    expect(mergeCompactionInstructions('Keep the API decision.', 'Preserve unresolved work.')).toBe(
      'Keep the API decision.\n\nPreserve unresolved work.',
    );
    expect(mergeCompactionInstructions('Keep the API decision.', '  ')).toBeNull();
  });

  it('selects the first non-empty compact instructions with a byte bound', () => {
    const root = project({ 'empty.md': '  ', 'fallback.md': 'Keep decisions.' });
    expect(
      readCompactInstructions([path.join(root, 'empty.md'), path.join(root, 'fallback.md')]),
    ).toBe('Keep decisions.');
    writeFileSync(path.join(root, 'huge.md'), 'x'.repeat(65_537));
    expect(readCompactInstructions([path.join(root, 'huge.md')])).toBe('');
  });
  it('detects nearest package manager, toolchain, and framework for reinjection', () => {
    const root = project({
      'pnpm-lock.yaml': '',
      'biome.json': '{}',
      'svelte.config.js': '',
      'pyproject.toml': '[tool.ruff]',
      'packages/app/package.json': '{}',
    });
    const env = detectProjectEnvironment(path.join(root, 'packages/app'));
    expect(env).toMatchObject({
      packageManager: 'pnpm',
      toolchain: 'biome',
      framework: 'svelte',
      python: true,
    });
    expect(buildCompactContext(env).join('\n')).toContain("Use 'pnpm' for all package commands.");
  });
});

describe('Claude hook adapter', () => {
  it('runs blocking Bash policies in safety order and stops at the first denial', () => {
    const result = adaptClaudeHookEvent(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'npm install && git commit -m "WIP"' },
      },
      {
        environment: {
          packageManager: 'pnpm',
          runner: ['pnpm', 'exec'],
          toolchain: 'classic',
          framework: null,
          python: false,
        },
        staged: [{ file: 'src/config.ts', diff: "+api_key='1234567890'" }],
        preCommit: { check: 'typecheck', exitCode: 1 },
        fallow: { command: 'git commit', minimumVersion: '2.46.0' },
      },
    );
    expect(result).toMatchObject({
      decision: 'deny',
      code: 'WRONG_PACKAGE_MANAGER',
      evaluated: ['package-manager'],
    });
  });

  it('maps session, write, command, compact, and notification policies to native Claude events', () => {
    const context = {
      environment: {
        packageManager: 'pnpm' as const,
        runner: ['pnpm', 'exec'] as const,
        toolchain: 'biome' as const,
        framework: null,
        python: false,
      },
      machineContext: 'Machine: work',
      sessionContext: 'Session: launch',
      compactInstructions: 'Keep binding.',
      configs: ['biome.json'],
    };
    expect(adaptClaudeHookEvent({ hook_event_name: 'SessionStart' }, context)).toMatchObject({
      additionalContext: expect.stringContaining('Machine: work'),
      evaluated: ['machine-context', 'session-context', 'project-context'],
    });
    expect(
      adaptClaudeHookEvent(
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Write',
          tool_input: { file_path: 'src/a.ts' },
        },
        context,
      ),
    ).toMatchObject({
      quality: [
        {
          executable: 'pnpm',
          args: ['exec', 'biome', 'format', '--write', 'src/a.ts'],
          reportFailure: false,
        },
        {
          executable: 'pnpm',
          args: ['exec', 'biome', 'lint', '--fix', 'src/a.ts'],
          reportFailure: true,
        },
      ],
      evaluated: ['post-write-quality'],
    });
    expect(
      adaptClaudeHookEvent(
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'pnpm install' },
          tool_response: { exit_code: 0, stderr: '3 vulnerabilities' },
        },
        context,
      ),
    ).toMatchObject({
      additionalContext: expect.stringContaining('vulnerabilities'),
      evaluated: ['post-command-context'],
    });
    expect(adaptClaudeHookEvent({ hook_event_name: 'PreCompact' }, context)).toMatchObject({
      additionalContext: expect.stringContaining('Keep binding.'),
      evaluated: ['compaction-injection'],
    });
    expect(
      adaptClaudeHookEvent(
        {
          hook_event_name: 'Notification',
          notification_type: 'permission_prompt',
          message: 'Approval needed',
        },
        context,
      ),
    ).toMatchObject({ notification: 'Approval needed', evaluated: ['notification'] });
  });
});

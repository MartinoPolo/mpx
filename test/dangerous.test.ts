import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { evaluateDangerousCommand, isWindowsNulFileTarget } from '../src/safeguards/dangerous.js';

async function temporary(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'mpx-dangerous-'));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

async function decisions(commands: readonly string[], cwd: string): Promise<string[]> {
  return Promise.all(commands.map(async command => (await evaluateDangerousCommand(command, cwd)).decision));
}

void test('allows narrow and non-force cleanup but blocks unsafe, mixed, traversal, and opaque forced deletion', async () => {
  await temporary(async cwd => {
    assert.deepEqual(
      await decisions([
        'rm file.txt',
        'rmdir empty-directory',
        'rm -r src/old',
        'rm -rf node_modules/.vite/chunks',
        'rm --force --recursive dist/assets',
        'rm -rf packages/app/.cache/nested',
        `rm -rf "${path.join(cwd, 'scratch-child').replaceAll('\\', '/')}"`,
      ], cwd),
      ['allow', 'allow', 'allow', 'allow', 'allow', 'allow', 'allow'],
    );

    for (const command of [
      'rm -rf /',
      'rm -fr src',
      'rm --recursive --force packages/app',
      'rm -rf node_modules src',
      'rm -rf ../node_modules',
      'rm -rf "$TARGET"',
      'rm -rf worktrees/feature',
    ]) {
      const result = await evaluateDangerousCommand(command, cwd);
      assert.equal(result.decision, 'block', command);
      assert.match(result.diagnostics.join('\n'), /forced recursive deletion/i, command);
    }
  });
});

void test('applies forced-recursive cleanup policy to PowerShell and cmd arrangements', async () => {
  await temporary(async cwd => {
    for (const command of [
      "pwsh -NoProfile -Command 'Remove-Item -LiteralPath node_modules/.vite -Recurse -Force'",
      "powershell -Command 'Remove-Item dist,coverage -Force -Recurse'",
      "cmd /c 'rmdir /q /s node_modules\\.cache'",
      "cmd.exe /c 'del /f /s /q dist\\old\\*'",
      'Remove-Item src -Recurse',
      'rmdir /s src',
    ]) {
      assert.equal((await evaluateDangerousCommand(command, cwd)).decision, 'allow', command);
    }
    for (const command of [
      "pwsh -Command 'Remove-Item src -Force -Recurse'",
      "powershell -Command 'Remove-Item node_modules,src -Recurse -Force'",
      "cmd /c 'rd /s /q src'",
      'cmd /c rd /s /q src',
      "cmd /c 'del src\\* /q /f /s'",
    ]) {
      assert.equal((await evaluateDangerousCommand(command, cwd)).decision, 'block', command);
    }
  });
});

void test('blocks every mutating git clean arrangement and allows explicit dry runs', async () => {
  await temporary(async cwd => {
    for (const command of ['git clean', 'git clean -fd', 'git clean -x -d -f', 'git --no-pager clean -e keep', 'git clean -f -- -n']) {
      const result = await evaluateDangerousCommand(command, cwd);
      assert.equal(result.decision, 'block', command);
      assert.match(result.diagnostics.join('\n'), /mutating git clean/i);
    }
    for (const command of ['git clean -n', 'git clean -fdxn', 'git clean -x --dry-run -d']) {
      assert.equal((await evaluateDangerousCommand(command, cwd)).decision, 'allow', command);
    }
  });
});

void test('blocks repository-wide find deletion while retaining narrow non-force deletion', async () => {
  await temporary(async cwd => {
    for (const command of ['find . -type f -delete', 'find .. -name stale -delete', `find "${cwd.replaceAll('\\', '/')}" -delete`]) {
      assert.equal((await evaluateDangerousCommand(command, cwd)).decision, 'block', command);
    }
    assert.equal((await evaluateDangerousCommand('find node_modules/.cache -name stale -delete', cwd)).decision, 'allow');
    assert.equal((await evaluateDangerousCommand(`find "${path.join(cwd, 'node_modules').replaceAll('\\', '/')}" -delete`, cwd)).decision, 'allow');
    assert.equal((await evaluateDangerousCommand('find src/generated -name stale -delete', cwd)).decision, 'allow');
  });
});

void test('uses a real Git repository remote HEAD for custom default-branch force protection', async () => {
  await temporary(async cwd => {
    git(cwd, 'init', '--quiet', '--initial-branch=feature/local');
    git(cwd, 'remote', 'add', 'origin', path.join(cwd, 'unused-remote'));
    git(cwd, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/release');

    for (const command of [
      'git push --force origin release',
      'git push origin HEAD:release --force-with-lease',
      'git push --force-with-lease origin main',
      'git push -f origin dev',
      'git push origin prod --force',
      'git push --mirror --force origin',
      'git push origin +main',
      'git push --repo=origin --force HEAD:main',
      'git push --repo origin --force HEAD:main',
    ]) {
      const result = await evaluateDangerousCommand(command, cwd);
      assert.equal(result.decision, 'block', command);
      assert.match(result.diagnostics.join('\n'), /force push/i, command);
    }

    assert.equal((await evaluateDangerousCommand('git push --force-with-lease origin feature/topic', cwd)).decision, 'allow');
    assert.equal((await evaluateDangerousCommand('git push origin feature/topic --force-with-lease', cwd)).decision, 'allow');
  });
});

void test('implicit protected branches, mirror pushes and absolute targets cannot bypass guard', async () => {
  await temporary(async cwd => {
    git(cwd, 'init', '--quiet', '--initial-branch=main');
    for (const command of ['git push --mirror origin', 'git push --force origin', 'git push --force-with-lease origin']) {
      assert.equal((await evaluateDangerousCommand(command, cwd)).decision, 'block', command);
    }
    assert.equal((await evaluateDangerousCommand('rm -rf /outside/source', path.join(cwd, 'node_modules'))).decision, 'block');
    assert.equal((await evaluateDangerousCommand('cd / && rm -rf unrelated', path.join(cwd, 'node_modules'))).decision, 'block');
    assert.equal((await evaluateDangerousCommand("cd / && bash -c 'rm -rf unrelated'", path.join(cwd, 'node_modules'))).decision, 'block');
  });
});

void test('resolves implicit push destinations rather than assuming the local branch name', async () => {
  await temporary(async cwd => {
    git(cwd, 'init', '--quiet', '--initial-branch=feature/topic');
    git(cwd, 'config', 'core.hooksPath', path.join(cwd, 'no-hooks'));
    git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture');
    git(cwd, 'remote', 'add', 'origin', path.join(cwd, 'unused-remote'));
    git(cwd, 'config', 'branch.feature/topic.remote', 'origin');
    git(cwd, 'config', 'branch.feature/topic.merge', 'refs/heads/main');
    git(cwd, 'config', 'push.default', 'upstream');
    git(cwd, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    assert.equal((await evaluateDangerousCommand('git push --force-with-lease origin', cwd)).decision, 'block');
    git(cwd, 'config', 'branch.feature/topic.merge', 'refs/heads/feature/topic');
    git(cwd, 'update-ref', 'refs/remotes/origin/feature/topic', 'HEAD');
    assert.equal((await evaluateDangerousCommand('git push --force-with-lease origin', cwd)).decision, 'allow');
  });
});

void test('blocks only a force push when branch-inspection infrastructure is unavailable', async () => {
  await temporary(async cwd => {
    const missing = path.join(cwd, 'missing-directory');
    const affected = await evaluateDangerousCommand('git push --force-with-lease origin feature/topic', missing);
    assert.equal(affected.decision, 'block');
    assert.match(affected.diagnostics.join('\n'), /inspection failed/i);
    assert.deepEqual(await evaluateDangerousCommand('echo "$ORDINARY_VARIABLE"', missing), {
      decision: 'allow',
      diagnostics: [],
    });
  });
});

void test('blocks destructive SQL only in recognizable executable database contexts', async () => {
  await temporary(async cwd => {
    for (const command of [
      `mysql -e 'DROP TABLE users' app`,
      `psql --command 'TRUNCATE TABLE audit' app`,
      `sqlcmd -Q 'DROP DATABASE app'`,
      `sqlite3 app.db 'drop table users'`,
      `mysql --execute='DROP TABLE sessions' app`,
      `psql '--command=TRUNCATE TABLE logs' app`,
    ]) {
      assert.equal((await evaluateDangerousCommand(command, cwd)).decision, 'block', command);
    }
    for (const command of [
      `echo 'DROP TABLE users'`,
      `printf '%s' 'TRUNCATE TABLE audit'`,
      `echo "mysql -e 'DROP DATABASE example'"`,
      `psql -c 'SELECT 1' app`,
    ]) {
      assert.equal((await evaluateDangerousCommand(command, cwd)).decision, 'allow', command);
    }
  });
});

void test('blocks formats, raw devices, fork bombs, and broad destructive chmod', async () => {
  await temporary(async cwd => {
    for (const command of [
      'mkfs.ext4 /dev/sda1',
      'format C: /Q',
      "pwsh -Command 'Format-Volume -DriveLetter C'",
      'dd if=image.iso of=/dev/nvme0n1',
      'printf x > /dev/sda1',
      ':(){ :|:& };:',
      'chmod -R 777 /',
      'chmod -R 777 src',
      'chmod 000 .',
    ]) {
      assert.equal((await evaluateDangerousCommand(command, cwd)).decision, 'block', command);
    }
    assert.equal((await evaluateDangerousCommand(`echo ':(){ :|:& };:'`, cwd)).decision, 'allow');
    assert.equal((await evaluateDangerousCommand('chmod 755 scripts/tool.sh', cwd)).decision, 'allow');
  });
});

void test('blocks persistent Windows PATH mutation without blocking other environment variables', async () => {
  await temporary(async cwd => {
    for (const command of [
      `setx PATH '%PATH%;C:\\tools'`,
      `setx /M Path 'C:\\tools'`,
      `powershell -Command "[Environment]::SetEnvironmentVariable('PATH', 'C:\\tools', 'User')"`,
      `reg add 'HKCU\\Environment' /v PATH /d 'C:\\tools'`,
    ]) {
      assert.equal((await evaluateDangerousCommand(command, cwd)).decision, 'block', command);
    }
    assert.equal((await evaluateDangerousCommand(`setx JAVA_HOME 'C:\\Java'`, cwd)).decision, 'allow');
    assert.equal((await evaluateDangerousCommand(`echo "setx PATH C:\\example"`, cwd)).decision, 'allow');
  });
});

void test('detects NUL redirects and exposes a pure non-shell file-target check', async () => {
  await temporary(async cwd => {
    for (const command of [
      'tool.exe 2>NUL',
      "cmd /c 'tool.exe > nul'",
      'pwsh -Command \'tool.exe *> "NUL"\'',
      'printf x >> ./NuL',
    ]) {
      const result = await evaluateDangerousCommand(command, cwd);
      assert.equal(result.decision, 'block', command);
      assert.match(result.diagnostics.join('\n'), /NUL/i);
    }
    assert.equal((await evaluateDangerousCommand(`echo '2>NUL'`, cwd)).decision, 'allow');
    assert.equal((await evaluateDangerousCommand('tool.exe 2>/dev/null', cwd)).decision, 'allow');

    assert.equal(isWindowsNulFileTarget('NUL'), true);
    assert.equal(isWindowsNulFileTarget('nested\\nul'), true);
    assert.equal(isWindowsNulFileTarget('./NUL.txt'), true);
    assert.equal(isWindowsNulFileTarget('null'), false);
    assert.equal(isWindowsNulFileTarget('nested/nul-safe.txt'), false);
  });
});

void test('inspects literal shell wrappers, fails closed on opaque interpreters, and permits ordinary variables', async () => {
  await temporary(async cwd => {
    assert.equal((await evaluateDangerousCommand("bash -lc 'rm -rf src'", cwd)).decision, 'block');
    assert.equal((await evaluateDangerousCommand("eval 'git clean -fd'", cwd)).decision, 'block');
    for (const command of [
      'bash -lc "$COMMAND"',
      'cmd /c %COMMAND%',
      'powershell -EncodedCommand ZQBjAGgAbwA=',
      `python -c 'print("safe")'`,
      'printf `%s` value',
      '${RUNNER} harmless',
    ]) {
      const result = await evaluateDangerousCommand(command, cwd);
      assert.equal(result.decision, 'block', command);
      assert.match(result.diagnostics.join('\n'), /opaque|dynamic|substitution/i, command);
    }
    for (const command of [
      'echo "$(rm -rf src)"',
      `python -c 'import shutil; shutil.rmtree("src")'`,
      `node -e 'fs.rmSync("src", {recursive: true, force: true})'`,
      `python -c 'cursor.execute("DROP TABLE users")'`,
    ]) assert.equal((await evaluateDangerousCommand(command, cwd)).decision, 'block', command);
    for (const command of [
      'echo "$HOME"',
      'printf "%s" "$VALUE"',
      "bash -lc 'printf %s \"$HOME\"'",
      "pwsh -Command 'Write-Output $env:HOME'",
    ]) {
      assert.equal((await evaluateDangerousCommand(command, cwd)).decision, 'allow', command);
    }
  });
});

void test('fails closed on malformed and oversized inspection inputs', async () => {
  await temporary(async cwd => {
    assert.equal((await evaluateDangerousCommand(`echo "unterminated`, cwd)).decision, 'block');
    const oversized = await evaluateDangerousCommand(`echo ${'x'.repeat(64 * 1024)}`, cwd);
    assert.equal(oversized.decision, 'block');
    assert.match(oversized.diagnostics.join('\n'), /inspection limit/i);
  });
});

void test('never executes inspected command text', async () => {
  await temporary(async cwd => {
    const marker = path.join(cwd, 'must-not-exist').replaceAll('\\', '/');
    assert.equal((await evaluateDangerousCommand(`node -e "require('node:fs').writeFileSync('${marker}', 'ran')"`, cwd)).decision, 'block');
    await assert.rejects(access(marker), /ENOENT/);
  });
});

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { inspectStaticShell } from '../src/safeguards/shell.js';
import { gitInvocations, readOnlyPrefix } from '../src/safeguards/git-command.js';

void test('redirections are syntax metadata, not argv or background operators', () => {
  const cwd = path.resolve('fixture');
  const inspected = inspectStaticShell('2>err pnpm test > log 2>&1 & echo done &>>all; cat <&0; echo x >&-', cwd);
  assert.deepEqual(inspected.commands.map(command => command.words.map(word => word.value)), [
    ['pnpm', 'test'], ['echo', 'done'], ['cat'], ['echo', 'x'],
  ]);
  assert.equal(inspected.commands[0]?.hasRedirection, true);
  assert.equal(inspected.commands[1]?.cwd, cwd);
  assert.doesNotMatch(inspected.diagnostics.join('\n'), /pipeline or background/i);
});

void test('quoted and escaped redirect characters remain literal', () => {
  const inspected = inspectStaticShell(String.raw`printf '%s' '2>&1' \&\>`, '.');
  assert.deepEqual(inspected.commands[0]?.words.map(word => word.value), ['printf', '%s', '2>&1', '&>']);
  assert.equal(inspected.commands[0]?.hasRedirection, false);
});

void test('pipeline and AND-list scopes carry and restore cwd explicitly', () => {
  const cwd = path.resolve('fixture');
  const child = path.join(cwd, 'npm');
  assert.deepEqual(inspectStaticShell('pnpm test | tail', cwd).commands.map(call => call.cwd), [cwd, cwd]);
  assert.deepEqual(inspectStaticShell('cd npm && npm test | tail', cwd).commands.map(call => call.cwd), [child, child]);
  assert.deepEqual(inspectStaticShell('cd npm && echo x | cat && npm test', cwd).commands.map(call => call.cwd), [child, child, child]);
  assert.deepEqual(inspectStaticShell('cd npm && npm dev & pnpm test', cwd).commands.map(call => [call.words[0]?.value, call.cwd]), [
    ['npm', child], ['pnpm', cwd],
  ]);
  const unsafe = inspectStaticShell('cd npm | pnpm test', cwd);
  assert.equal(unsafe.commands.length, 1);
  assert.equal(unsafe.commands[0]?.words[0]?.value, 'pnpm');
  assert.equal(unsafe.commands[0]?.cwd, undefined);
});

void test('git parsing retains redirected mutations and redirecting prefixes are not read-only', () => {
  const parsed = gitInvocations('git status >status.log; git add . 2>&1; git commit -m ok', '.');
  assert.deepEqual(parsed.invocations.map(call => call.operation), ['status', 'add', 'commit']);
  assert.equal(readOnlyPrefix(parsed.invocations[1]!.prefix), false);
  const wrapped = gitInvocations(`bash -c 'git status' >output; git push`, '.');
  assert.equal(wrapped.invocations[1]?.prefix[0]?.hasRedirection, true);
  assert.equal(readOnlyPrefix(wrapped.invocations[1]!.prefix), false);
});

void test('unsupported heredocs and process substitutions remain uninspectable', () => {
  for (const command of ['pnpm test <<EOF', 'pnpm test <(generate)', 'pnpm test >(consume)']) {
    const result = inspectStaticShell(command, '.');
    assert.equal(result.commands.length, 0, command);
    assert.match(result.diagnostics.join('\n'), /unsupported|malformed/i, command);
  }
});

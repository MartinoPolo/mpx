import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function readContent(relativePath: string): Promise<string> {
  return readFile(new URL(`../content/${relativePath}`, import.meta.url), 'utf8');
}

const verificationDocuments = [
  'skills/playwright-test/SKILL.md',
  'skills/execute/DEV_SERVER.md',
  'skills/batch-execute/SKILL.md',
  'agents/visual-verifier.md',
];

for (const documentPath of verificationDocuments) {
  test(`${documentPath} separates inspectable evidence from disposable runners`, async () => {
    const content = await readContent(documentPath);
    assert.ok(content.includes('<MPX_AI_DUMP>/_VERIFICATION/<run>'));
    assert.match(content, /MPX_TEMP/);
    assert.match(content, /unset, relative, or/);
    assert.match(content, /never guess|no guessed fallback/i);
    assert.doesNotMatch(content, /untracked task-local artifact/);
  });
}

test('walkthrough staging leaves the repository and preserves artifact delivery', async () => {
  const content = await readContent('skills/code-walkthrough/SKILL.md');
  assert.ok(content.includes('<MPX_AI_DUMP>/_WALKTHROUGHS/<run>/<slug>-walkthrough.html'));
  assert.match(content, /unset, relative, or/);
  assert.match(content, /never guess|no guessed fallback/i);
  assert.match(content, /then publish it/);
  assert.match(content, /republish the same file path/);
  assert.doesNotMatch(content, /to the repo root|<repo root>\/<slug>-walkthrough/);
});

test('component audit reports are findings-only machine outputs', async () => {
  const content = await readContent('skills/components-audit/SKILL.md');
  assert.ok(content.includes('<MPX_AI_DUMP>/_COMPONENT_AUDITS/<run>/COMPONENT-AUDIT.md'));
  assert.match(content, /only (?:when|if) findings exist/);
  assert.match(content, /unset, relative, or/);
  assert.match(content, /never guess|no guessed fallback/i);
});

test('cleanup separates handoff artifacts from scratch without moving recovery data', async () => {
  const content = await readContent('skills/clean-pc/SKILL.md');
  assert.ok(content.includes('<MPX_AI_DUMP>/_CLEAN_PC/<run>'));
  assert.ok(content.includes('<MPX_TEMP>/_CLEAN_PC/<run>'));
  assert.ok(content.includes('<MPX_ONEDRIVE>/.mpx/clean-pc/state.json'));
  assert.match(content, /unset, relative, or/);
  assert.match(content, /never guess|no guessed fallback/i);
  assert.match(content, /dashboard directory/);
  assert.match(content, /self-contained rather than/);
  const domains = await readContent('skills/clean-pc/DOMAINS.md');
  assert.match(domains, /Quarantine roots and both resolved run directories are excluded/);
  const windows = await readContent('skills/clean-pc/WINDOWS.md');
  assert.match(windows, /<scratch>.*MPX_TEMP/);
  assert.match(windows, /<reports>.*MPX_AI_DUMP/);
  assert.doesNotMatch(windows, /export="\$env:TEMP/);
  assert.ok(windows.includes('<drive>:\\_cleanup_quarantine'));
});

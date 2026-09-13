// Migration-only evidence generator. Never imported by the compiler, launchers or runtime.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
if (!process.env.MPX_PROJECTS || !path.isAbsolute(process.env.MPX_PROJECTS)) throw new Error('An absolute MPX_PROJECTS is required.');
const sourceRoot = path.join(process.env.MPX_PROJECTS, 'mpx/content');
async function walk(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await walk(directory, relative));
    else if (entry.isFile()) result.push(relative);
  }
  return result.sort();
}
const privateCopies = {
  'skills/execute/detect-check-scripts.mjs': 'skills/check-fix/scripts/detect-check-scripts.mjs',
  'skills/board-to-issues/ISSUE_TEMPLATE.md': 'skills/issue-create/references/ISSUE_TEMPLATE.md',
  'skills/epic-review/ISSUE_TEMPLATE.md': 'skills/to-issues/ISSUE_TEMPLATE.md',
  'skills/review/scripts/detect-base-branch.js': 'skills/sync-base/scripts/detect-base-branch.js',
  'skills/grill-voice/GRILL_WORKFLOW.md': 'skills/grill/SKILL.md',
  'instructions/shared/EXECUTOR_TESTS.md': 'skills/execute/tests.md',
  'instructions/shared/EXECUTOR_MOCKING.md': 'skills/execute/mocking.md',
  'instructions/shared/AGENTS.md': 'instructions/global/AGENTS.md',
  'instructions/shared/COMPACT.md': 'instructions/COMPACT.md',
};
const files = await walk(path.join(root, 'content'));
const sourceFiles = await walk(sourceRoot);
const lines = [
  '# Retained content coverage', '',
  'Migration evidence only. `INVENTORY.md` preserves the original source/counterpart inventory;',
  'this table records the resulting canonical files, not a runtime manifest or approval digest.',
  'Every current skill is retained. Historical `mp-to-epic` maps to `epic-create`; `mp-init-repo`',
  'maps to `init-github-repo`. Original source checkouts remain intact. Native/provider/UI acceptance',
  'is separate from file coverage and compiler/support closure. See the per-slice evidence and',
  '`PROGRESS.md` for exact outstanding gates. No source deletion or archival is implied.', '',
  '| Canonical file | Dirty current source beneath mpx/content | Transfer | Evidence |',
  '| --- | --- | --- | --- |',
];
for (const file of files) {
  let source = privateCopies[file] ?? file.replace(/^agents\/(?!lib\/)([^/]+\.md)$/, 'agents/mpx-$1').replace(/^rules\//, 'instructions/rules/').replace(/^instructions\/(pi|claude)\//, 'instructions/runtime/$1/');
  if (!sourceFiles.includes(source)) {
    const matching = sourceFiles.filter(candidate => candidate.endsWith('/' + file.split('/').slice(-2).join('/')));
    if (matching.length === 1) source = matching[0];
  }
  const exists = sourceFiles.includes(source);
  const identical = exists && (await readFile(path.join(sourceRoot, source))).equals(await readFile(path.join(root, 'content', file)));
  const evidence = file.startsWith('skills/') ? 'core/remaining-skills evidence; content tests' : 'shared evidence; compiler/native-agent tests';
  lines.push(`| \`content/${file}\` | ${exists ? `\`${source}\`` : 'Decision-owned projection configuration; no byte-equivalence claim'} | ${identical ? 'byte-identical' : 'adapted'} | ${evidence} |`);
}
lines.push('', '## Runtime source disposition', '',
  'The extension/hook tables in `MIGRATION_PLAN.md` remain the per-capability authority. Shared policy',
  'replaces legacy hook implementations; native account packages remain native; the approved upstream',
  'patch replaces only selected-pack discovery/preload wiring. Orca-managed hooks are mirrored, not',
  'adopted. Explicitly retired global checks/reminders/recorders/port and worktree services are not',
  'runtime inputs. Deferred nesting/scheduling/memory/rendering and legacy sources remain preserved.',
  'Aggregate-to-Orca deployment requires the requested narrow-hook decision and live acceptance.', '');
await writeFile(path.join(root, 'migration/COVERAGE.md'), lines.join('\n'));
console.log(`Recorded ${files.length} canonical files; no legacy writes.`);

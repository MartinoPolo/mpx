import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
if (!process.env.MPX_PROJECTS) throw new Error('MPX_PROJECTS is required; no source root is guessed.');
const sourceRoot = path.join(process.env.MPX_PROJECTS, 'mpx');

const handoffSource = path.join(sourceRoot, 'content/skills/handoff/SKILL.md');
const checkerSource = path.join(sourceRoot, 'content/agents/mpx-checker.md');
const profileSource = path.join(sourceRoot, 'content/runtime-profiles.json');
const handoffDestination = path.join(root, 'content/skills/handoff/SKILL.md');
const checkerDestination = path.join(root, 'content/agents/checker.md');
const profileDestination = path.join(root, 'content/runtime-profiles.json');
const destinations = [handoffDestination, checkerDestination, profileDestination];

async function exists(file) {
  try { await fs.access(file); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

for (const destination of destinations) {
  if (await exists(destination)) throw new Error(`Refusing to overwrite existing destination: ${destination}`);
}

const [checker, profileText] = await Promise.all([
  fs.readFile(checkerSource, 'utf8'),
  fs.readFile(profileSource, 'utf8'),
]);
const profile = JSON.parse(profileText);
const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/;
const match = checker.match(frontmatter);
if (!match) throw new Error('Checker source has no frontmatter');
if (!/^name:\s*mpx-checker\s*$/m.test(match[1])) throw new Error('Unexpected checker name');
const metadata = 'metadata:\n  mpx:\n    schemaVersion: 1\n    modelClass: mechanical\n    thinking: low\n    capabilities: [read, search, shell]';
const checkerAdapted = checker.replace(frontmatter, (_, body) =>
  `---\n${body}${body.endsWith('\n') ? '' : '\n'}${metadata}\n---`
).replace(/^name: mpx-checker$/m, 'name: checker');

const adaptedProfile = {
  schemaVersion: profile.schemaVersion,
  models: profile.models,
  tools: {
    claude: {
      read: ['Read'], search: ['Grep', 'Glob'], shell: ['Bash'], write: ['Edit', 'Write'],
      browser: ['mcp__chrome-devtools__*'], context: ['mcp__context7__*'], web: ['WebSearch', 'WebFetch'],
    },
    pi: {
      read: ['read'], search: ['grep', 'find', 'ls'], shell: ['bash'], write: ['edit', 'write'],
      browser: ['ext:pi-mcp-adapter'], context: ['ext:pi-mcp-adapter'], web: ['ext:pi-web-access'],
    },
  },
};

await fs.mkdir(path.dirname(handoffDestination), { recursive: true });
await fs.mkdir(path.dirname(checkerDestination), { recursive: true });
await fs.copyFile(handoffSource, handoffDestination);
await fs.writeFile(checkerDestination, checkerAdapted);
await fs.writeFile(profileDestination, `${JSON.stringify(adaptedProfile, null, 2)}\n`);

const handoffEqual = (await fs.readFile(handoffSource)).equals(await fs.readFile(handoffDestination));
const stripFrontmatter = text => text.replace(frontmatter, '');
const checkerBodyEqual = stripFrontmatter(checker) === stripFrontmatter(checkerAdapted);
console.log(JSON.stringify({ count: destinations.length, handoffBytesEqual: handoffEqual, checkerBodyEqual }, null, 2));

#!/usr/bin/env node
// Initialize a new local project with Git and portable repository hygiene files.

import { copyFileSync, existsSync, lstatSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(SELF_DIR, '..', 'templates', 'gitignore.template');

if (!existsSync(TEMPLATE_PATH)) {
  console.error(`Error: bundled gitignore template not found: ${TEMPLATE_PATH}`);
  process.exit(1);
}

for (const variable of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) {
  if (process.env[variable] !== undefined) {
    console.error(
      `Error: ${variable} redirects Git state; run from the project without that override.`,
    );
    process.exit(1);
  }
}

for (let directory = process.cwd(); ; directory = path.dirname(directory)) {
  if (lstatSync(path.join(directory, '.git'), { throwIfNoEntry: false })) {
    console.error('Error: current directory is already inside a Git repository.');
    process.exit(1);
  }
  if (path.dirname(directory) === directory) break;
}

const repositoryCheck = spawnSync('git', ['rev-parse', '--git-dir'], {
  stdio: 'ignore',
});
if (repositoryCheck.error) {
  throw repositoryCheck.error;
}
if (repositoryCheck.status === 0) {
  console.error('Error: current directory is already inside a Git repository.');
  process.exit(1);
}

const seedFiles = ['.gitignore', '.gitattributes', '.editorconfig', 'AGENTS.md', 'CLAUDE.md'];
for (const file of seedFiles) {
  const entry = lstatSync(file, { throwIfNoEntry: false });
  if (entry && !entry.isFile()) {
    console.error(`Error: ${file} must be a regular file, not a link or directory.`);
    process.exit(1);
  }
}

console.log('Initializing git repository...');
execFileSync('git', ['init'], { stdio: 'inherit' });

if (!existsSync('.gitignore')) {
  console.log('Creating .gitignore...');
  copyFileSync(TEMPLATE_PATH, '.gitignore');
}

if (!existsSync('.gitattributes')) {
  console.log('Creating .gitattributes...');
  writeFileSync(
    '.gitattributes',
    `# Normalize all text to LF in git and working tree
* text=auto eol=lf

# Shell scripts - always LF (CRLF breaks shebangs)
*.sh text eol=lf

# Common text
*.md text eol=lf
*.json text eol=lf
*.txt text eol=lf
*.yaml text eol=lf
*.yml text eol=lf
*.toml text eol=lf
*.css text eol=lf
*.js text eol=lf
*.ts text eol=lf
*.tsx text eol=lf
*.jsx text eol=lf
*.html text eol=lf
*.py text eol=lf
*.rs text eol=lf
*.go text eol=lf

# Binary - no conversion
*.png binary
*.jpg binary
*.gif binary
*.ico binary
*.woff binary
*.woff2 binary
*.ttf binary
*.eot binary
*.pdf binary
*.zip binary
`,
  );
}

if (!existsSync('.editorconfig')) {
  console.log('Creating .editorconfig...');
  writeFileSync(
    '.editorconfig',
    `root = true

[*]
end_of_line = lf
insert_final_newline = true
charset = utf-8
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false

[*.{png,jpg,gif,ico,woff,woff2,ttf,eot,pdf,zip}]
end_of_line = unset
insert_final_newline = unset
charset = unset
trim_trailing_whitespace = unset
`,
  );
}

if (!existsSync('AGENTS.md')) {
  console.log('Creating AGENTS.md seed...');
  writeFileSync(
    'AGENTS.md',
    `# Project Instructions

Add only project-specific conventions that cannot be discovered from repository files.
Point to authoritative documentation for branch-specific workflows instead of copying it here.
`,
  );
}

if (!existsSync('CLAUDE.md')) {
  console.log('Creating CLAUDE.md pointer...');
  writeFileSync('CLAUDE.md', '@AGENTS.md\n');
}

execFileSync('git', ['add', '--', ...seedFiles], { stdio: 'inherit' });
execFileSync('git', ['commit', '-m', 'chore: initialize repository'], { stdio: 'inherit' });

console.log('Project initialized successfully!');

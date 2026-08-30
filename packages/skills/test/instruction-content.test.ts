import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const instructionsRoot = path.resolve(import.meta.dirname, '../../../content/instructions');

type Rule = Readonly<{ file: string; scope: string; selector: string; applyTo: string }>;

async function rulesIn(directory: 'languages' | 'projects'): Promise<Rule[]> {
  const root = path.join(instructionsRoot, 'rules', directory);
  const files = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) =>
      path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/'),
    )
    .sort();
  return Promise.all(
    files.map(async (file) => {
      const content = await readFile(path.join(root, file), 'utf8');
      const value = (key: string) =>
        content.match(new RegExp(`^${key}:\\s*["']?([^"'\\n]+)`, 'mu'))?.[1]?.trim() ?? '';
      return {
        file,
        scope: value('scope'),
        selector: value('selector'),
        applyTo: value('applyTo'),
      };
    }),
  );
}

async function instructionProjection(
  language: string | undefined,
  project: string | undefined,
): Promise<string[]> {
  const globalRoot = path.join(instructionsRoot, 'rules', 'global');
  const globalRules = (await readdir(globalRoot))
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => `rules/global/${file}`);
  const selected = [
    ...(await rulesIn('languages'))
      .filter((rule) => rule.selector === language)
      .map((rule) => `rules/languages/${rule.file}`),
    ...(await rulesIn('projects'))
      .filter((rule) => rule.selector === project)
      .map((rule) => `rules/projects/${rule.file}`),
  ];
  return ['global/AGENTS.md', ...globalRules, ...selected];
}

describe('canonical instruction selectors', () => {
  it('snapshots language and project selectors without globally loading either scope', async () => {
    const languageRules = await rulesIn('languages');
    const projectRules = await rulesIn('projects');

    expect({ languageRules, projectRules }).toMatchInlineSnapshot(`
      {
        "languageRules": [
          {
            "applyTo": "**/*.css,**/*.scss,**/*.pcss",
            "file": "css.md",
            "scope": "language",
            "selector": "css",
          },
          {
            "applyTo": "**/*.py",
            "file": "python.md",
            "scope": "language",
            "selector": "python",
          },
          {
            "applyTo": "**/*.rs",
            "file": "rust.md",
            "scope": "language",
            "selector": "rust",
          },
          {
            "applyTo": "**/*.svelte,**/*.svelte.ts,**/*.svelte.js",
            "file": "svelte.md",
            "scope": "language",
            "selector": "svelte",
          },
          {
            "applyTo": "**/*.ts,**/*.tsx",
            "file": "typescript.md",
            "scope": "language",
            "selector": "typescript",
          },
        ],
        "projectRules": [
          {
            "applyTo": "**/*.tsx,**/*.jsx",
            "file": "react.md",
            "scope": "project",
            "selector": "react",
          },
          {
            "applyTo": "",
            "file": "references/shadcn-svelte-component-catalog.md",
            "scope": "reference",
            "selector": "shadcn-svelte",
          },
          {
            "applyTo": "**/*.svelte,**/*.svelte.ts,**/*.svelte.js,**/*_variants.ts,**/*.stories.svelte",
            "file": "shadcn-svelte.md",
            "scope": "project",
            "selector": "shadcn-svelte",
          },
          {
            "applyTo": "**/*.tsx,**/*.jsx",
            "file": "solid.md",
            "scope": "project",
            "selector": "solid",
          },
          {
            "applyTo": "**/*.stories.svelte",
            "file": "storybook.md",
            "scope": "project",
            "selector": "storybook",
          },
          {
            "applyTo": "**/*.svelte,**/*.svelte.ts,**/*.svelte.js, **/*.context.**",
            "file": "svelte-context.md",
            "scope": "project",
            "selector": "svelte-context",
          },
          {
            "applyTo": "vite.config.*,**/+page.svelte,**/+layout.svelte",
            "file": "sveltekit-dev-warmup.md",
            "scope": "project",
            "selector": "sveltekit-dev-warmup",
          },
          {
            "applyTo": "**/src/routes/**/*.ts,**/src/hooks*.ts",
            "file": "sveltekit-paths-server.md",
            "scope": "project",
            "selector": "sveltekit-paths-server",
          },
          {
            "applyTo": "**/*.svelte,**/*.svelte.ts,**/*.svelte.js,**/src/routes/**/*.ts",
            "file": "sveltekit-paths.md",
            "scope": "project",
            "selector": "sveltekit-paths",
          },
        ],
      }
    `);
    expect([...languageRules, ...projectRules].some((rule) => rule.scope === 'global')).toBe(false);
  });

  it('snapshots global and selected rule projection boundaries', async () => {
    await expect(instructionProjection(undefined, undefined)).resolves.toEqual([
      'global/AGENTS.md',
      'rules/global/css-color-guide.instructions.md',
      'rules/global/update-docs.instructions.md',
    ]);
    await expect(instructionProjection('typescript', 'react')).resolves.toEqual([
      'global/AGENTS.md',
      'rules/global/css-color-guide.instructions.md',
      'rules/global/update-docs.instructions.md',
      'rules/languages/typescript.md',
      'rules/projects/react.md',
    ]);
  });

  it('projects common policy once while runtime layers contain only adapters', async () => {
    const files = ['global/AGENTS.md', 'runtime/claude/CLAUDE.md', 'runtime/pi/APPEND_SYSTEM.md'];
    const contents = await Promise.all(
      files.map((file) => readFile(path.join(instructionsRoot, file), 'utf8')),
    );
    expect(
      contents.flatMap(
        (content) => content.match(/Do not use em dashes in generated prose\./gu) ?? [],
      ),
    ).toHaveLength(1);
    expect(contents[1].trim()).toBe('@../../global/AGENTS.md');
    expect(contents[2]).not.toContain('Repository and worktree discipline');
  });
});

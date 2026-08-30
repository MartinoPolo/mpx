import { describe, expect, it } from 'vitest';
import { readFile, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { inventoryCanonical } from '../src/index.js';

const root = path.resolve(import.meta.dirname, '../../../content/skills');
const identities = [
  'board-setup',
  'board-to-issues',
  'clean-pc',
  'podcast',
  'project-register',
  'raycast-config',
  'tutorial-create',
  'video-to-image',
] as const;

async function files(identity: string): Promise<string[]> {
  return (await readdir(path.join(root, identity), { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

async function text(relative: string): Promise<string> {
  return readFile(path.join(root, relative), 'utf8');
}

describe('Batch C6 personal skills', () => {
  it('catalogs every imported skill as personal and explicit-only', async () => {
    const catalog = new Map(
      (await inventoryCanonical(root)).map((entry) => [entry.identity, entry]),
    );
    for (const identity of identities) {
      expect(catalog.get(identity)?.skillPacks, identity).toEqual(['personal']);
      expect(catalog.get(identity)?.defaultExposure, identity).toBe('explicit-only');
    }
  });

  it('imports the complete project-register branch documentation', async () => {
    await expect(
      stat(path.join(root, 'project-register/OBSIDIAN_REGISTRATION.md')),
    ).resolves.toBeDefined();
    await expect(
      stat(path.join(root, 'project-register/REPOSITORY_INIT.md')),
    ).resolves.toBeDefined();
  });

  it('keeps all imported support references closed', async () => {
    const missing: string[] = [];
    for (const identity of identities) {
      for (const file of await files(identity)) {
        if (!file.endsWith('.md')) {
          continue;
        }
        const content = await readFile(file, 'utf8');
        for (const match of content.matchAll(
          /\[[^\]]*\]\((?!https?:|file:|#)([^)#]+)(?:#[^)]+)?\)/gu,
        )) {
          const reference = match[1];
          if (!reference) {
            continue;
          }
          const candidate = reference.includes('../shared/')
            ? path.resolve(
                root,
                '../instructions/shared',
                reference.slice(reference.indexOf('../shared/') + 10),
              )
            : path.resolve(path.dirname(file), reference);
          try {
            await stat(candidate);
          } catch {
            missing.push(`${path.relative(root, file)} -> ${reference}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps every PowerShell, Node, and Python support file syntactically valid', async () => {
    const failures: string[] = [];
    for (const identity of identities) {
      for (const file of await files(identity)) {
        let result;
        if (/\.(?:m?js)$/u.test(file)) {
          result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
        } else if (file.endsWith('.py')) {
          result = spawnSync('python', ['-m', 'py_compile', file], {
            encoding: 'utf8',
            env: { ...process.env, PYTHONPYCACHEPREFIX: path.join(tmpdir(), 'mpx-c6-pycache') },
          });
        } else if (file.endsWith('.ps1')) {
          result = spawnSync(
            'powershell',
            [
              '-NoProfile',
              '-Command',
              `$errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file.replaceAll("'", "''")}', [ref]$null, [ref]$errors); if ($errors.Count) { $errors | Out-String | Write-Error; exit 1 }`,
            ],
            { encoding: 'utf8' },
          );
        }
        if (result && result.status !== 0) {
          failures.push(`${path.relative(root, file)}: ${result.stderr || result.stdout}`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, 30_000);

  it('contains no absolute personal paths, usernames, embedded passphrases, or legacy root fallbacks', async () => {
    const violations: string[] = [];
    const forbidden: Array<[string, RegExp]> = [
      [
        'absolute personal path',
        /(?:\b[A-Za-z]:[\\/](?:Users|_MP_projects|_MP_work|_MP_apps)[\\/]|\/(?:Users|home|_MP_projects|_MP_work|_MP_apps)\/)/iu,
      ],
      ['personal username', /\bsnapy\b/iu],
      ['native runtime state', /(?:~[\\/]|[\\/])\.(?:claude|runtime|pi)[\\/]/iu],
      ['embedded passphrase', /(?:passphrase|password)\s*[=:]\s*["'](?!<)[^"']{4,}["']/iu],
      ['AI root fallback', /process\.env\.TUTORIALS_ROOT|MPX_ONEDRIVE[^\n]{0,100}AI GENERATED/iu],
    ];
    for (const identity of identities) {
      for (const file of await files(identity)) {
        const content = await readFile(file, 'utf8');
        for (const [kind, pattern] of forbidden) {
          if (pattern.test(content)) {
            violations.push(`${path.relative(root, file)}: ${kind}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('preserves confirmation gates before destructive or wholesale changes', async () => {
    expect(await text('clean-pc/SKILL.md')).toContain(
      'remove only what the user approves group by group',
    );
    expect((await text('raycast-config/SKILL.md')).toLowerCase()).toContain(
      'wait for explicit confirmation before importing',
    );
    expect(await text('project-register/SKILL.md')).toContain(
      'Stop here and ask before touching anything',
    );
    expect(await text('tutorial-create/SKILL.md')).toContain(
      'wait for approval before writing any source',
    );
  });

  it('routes every AI-media deliverable through MPX_AI_GENERATED and rejects escaping output overrides', async () => {
    const tutorial = await text('tutorial-create/scripts/compile.js');
    const video = await text('video-to-image/scripts/video-to-sheet.mjs');
    const podcast = await text('podcast/scripts/gemini-tts-podcast.py');
    for (const [name, content] of [
      ['tutorial', tutorial],
      ['video', video],
      ['podcast', podcast],
    ] as const) {
      expect(content, name).toContain('MPX_AI_GENERATED');
    }
    expect(tutorial).not.toContain('process.env.TUTORIALS_ROOT');
    expect(video).toMatch(/isPathInside|assertOutputContainment/u);
    expect(podcast).toMatch(/is_relative_to|relative_to/u);
  });

  it('supports MPX roots containing spaces without shell interpolation', async () => {
    const fixtureRoot = path.join(process.cwd(), 'tmp mpx roots', 'AI GENERATED');
    const moduleUrl = new URL(
      `file://${path.join(root, 'video-to-image/scripts/video-to-sheet.mjs').replaceAll('\\', '/')}`,
    ).href;
    const script = `import { resolveOutputDirectory } from ${JSON.stringify(moduleUrl)}; console.log(resolveOutputDirectory('', 'A Video'));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
      env: { ...process.env, MPX_AI_GENERATED: fixtureRoot },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(path.join(fixtureRoot, '_VIDEO_SHEETS', 'A Video'));
  });

  it('rejects a video output override outside MPX_AI_GENERATED', () => {
    const fixtureRoot = path.join(process.cwd(), 'tmp mpx roots', 'AI GENERATED');
    const outside = path.join(process.cwd(), 'outside media');
    const moduleUrl = new URL(
      `file://${path.join(root, 'video-to-image/scripts/video-to-sheet.mjs').replaceAll('\\', '/')}`,
    ).href;
    const script = `import { resolveOutputDirectory } from ${JSON.stringify(moduleUrl)}; resolveOutputDirectory(${JSON.stringify(outside)}, 'A Video');`;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
      env: { ...process.env, MPX_AI_GENERATED: fixtureRoot },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Output must stay under MPX_AI_GENERATED');
  });

  it('delegates new repositories to canonical repository-setup', async () => {
    const registration = `${await text('project-register/SKILL.md')}\n${await text('project-register/REPOSITORY_INIT.md')}`;
    expect(registration).toContain('repository-setup');
    expect(registration).not.toMatch(/\.\.\/init-repo|mp-init-repo/iu);
  });
});

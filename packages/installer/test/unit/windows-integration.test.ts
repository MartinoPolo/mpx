import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildManagedLauncherBody,
  buildStableSelectorBody,
  buildWindowsIntegrationSpecs,
  WINDOWS_OWNED_PATH_VARIABLES,
} from '../../src/windows-integration.js';

describe('Phase I Windows integration specification', () => {
  it('defines a fresh Bash mpx command that forwards exact argv to the Windows selector', () => {
    const body = buildManagedLauncherBody('bash');

    expect(body).toContain('mpx() { command mpx.cmd "$@"; }');
    expect(body).not.toMatch(/\beval\b/u);
    expect(body).toContain(
      'cc-mpx() { mpx launch claude --identity personal --executor host --workspace direct --reason \'User-approved native Claude compatibility\' --approve-host "$@"; }',
    );
    expect(buildManagedLauncherBody('powershell')).not.toContain('mpx.cmd');
  });

  it('keeps native agent commands unshadowed and gives every MPX route an explicit suffix', () => {
    for (const shell of ['bash', 'powershell'] as const) {
      const body = buildManagedLauncherBody(shell);
      for (const alias of ['cc-mpx', 'ccw-mpx', 'pi-mpx', 'piw-mpx', 'ccd-mpx', 'ccwd-mpx']) {
        expect(body).toContain(alias);
      }
      expect(body).not.toMatch(/(?:^|\n)(?:function )?(?:cc|ccw|pi|piw|ccd|ccwd)(?:\(\))?\s*\{/u);
      expect(body).toContain('MPX_DIRECT_REASON');
      expect(body.toLowerCase()).toContain('tty');
      expect(body).toContain('--executor host');
      expect(body).toContain('--workspace direct');
      expect(body).toContain("--reason 'User-approved native Pi compatibility'");
      expect(body).toContain("--reason 'User-approved native Claude compatibility'");
      expect(body.match(/--approve-host/gu)).toHaveLength(6);
      expect(body).toContain('--identity personal');
      expect(body).toContain('--identity work');
      expect(body).not.toMatch(/dangerous[^\n]*(skip|bypass)|--(?:skip|bypass)[^\n]*dangerous/iu);
    }
  });

  it('hydrates missing launch paths and routes through the installer-owned stable entry', () => {
    const body = buildStableSelectorBody();

    expect(body).toContain('reg query "HKCU\\Environment"');
    expect(body).toContain('MPX_PI_EXECUTABLE MPX_CLAUDE_EXECUTABLE');
    expect(body).not.toContain('MPX_OWNER');
    expect(body).not.toContain('MPX_PATH_PREPEND');
    expect(body).not.toContain('set MPX_');
    expect(body).toContain('"%MPX_NODE_EXECUTABLE%" "%~dp0mpx-node.mjs" %*');
    expect(body).not.toContain('active-release');
    const commandAllowlist = /for %%V in \(([^)]+)\)/u.exec(body)?.[1]?.split(' ');
    expect(commandAllowlist).toEqual(WINDOWS_OWNED_PATH_VARIABLES);
    expect(WINDOWS_OWNED_PATH_VARIABLES).toEqual([
      'MPX_APPS',
      'MPX_PROJECTS',
      'MPX_WORK',
      'MPX_CLONED',
      'MPX_ONEDRIVE',
      'MPX_AI_GENERATED',
      'MPX_OBSIDIAN_VAULT',
      'MPX_NODE_EXECUTABLE',
      'MPX_PI_EXECUTABLE',
      'MPX_CLAUDE_EXECUTABLE',
    ]);
  });

  it('excludes scheduled capture from the base Windows integration specification', () => {
    const specs = buildWindowsIntegrationSpecs(
      {
        MPX_APPS: 'C:\\Apps',
        MPX_NODE_EXECUTABLE: 'C:\\Node\\node.exe',
        APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
        USERPROFILE: 'C:\\Users\\me',
      },
      'DOMAIN\\me',
      'a'.repeat(64),
    );

    expect(specs).not.toHaveProperty('task');
  });

  it('builds structured specs from MPX roots without guessing machine paths or shell quoting values', () => {
    const environment = {
      MPX_APPS: "C:\\Apps ' ; $evil",
      MPX_PROJECTS: 'C:\\Projects',
      MPX_PI_EXECUTABLE: 'C:\\Tools\\pi.exe',
      MPX_NODE_EXECUTABLE: 'C:\\Node\\node.exe',
      MPX_OWNER: 'must-not-be-published',
      MPX_PATH_PREPEND: 'C:\\Stale',
      MPX_TRANSIENT_SECRET: 'must-not-be-published',
      APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      USERPROFILE: 'C:\\Users\\me',
    };
    const specs = buildWindowsIntegrationSpecs(environment, 'DOMAIN\\me', 'a'.repeat(64));
    expect(specs.environment.desired).toMatchObject({
      MPX_APPS: environment.MPX_APPS,
      MPX_PROJECTS: environment.MPX_PROJECTS,
      MPX_PI_EXECUTABLE: environment.MPX_PI_EXECUTABLE,
      MPX_EXECUTABLE: `${environment.MPX_APPS}\\mpx\\bin\\mpx.cmd`,
      MPX_NODE_ENTRY: `${environment.MPX_APPS}\\mpx\\bin\\mpx-node.mjs`,
      MPX_NODE_EXECUTABLE: environment.MPX_NODE_EXECUTABLE,
    });
    expect(specs.environment.desired).not.toHaveProperty('MPX_OWNER');
    expect(specs.environment.desired).not.toHaveProperty('MPX_PATH_PREPEND');
    expect(specs.environment.desired).not.toHaveProperty('MPX_TRANSIENT_SECRET');
    const selector = `${environment.MPX_APPS}\\mpx\\bin\\mpx.cmd`;
    expect(specs).not.toHaveProperty('terminal');
    expect(specs.shortcuts.every((item) => item.desired.targetPath === selector)).toBe(true);
    expect(JSON.stringify(specs)).toContain("Apps ' ; $evil");
    expect(specs.shortcuts.map((item) => item.target)).toEqual([
      'C:\\Users\\me\\Desktop\\MPX.lnk',
      'C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\MPX.lnk',
    ]);
  });
});

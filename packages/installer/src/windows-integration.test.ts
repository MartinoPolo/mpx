import { describe, expect, it } from 'vitest';
import { buildManagedLauncherBody, buildWindowsIntegrationSpecs } from './windows-integration.js';

describe('Phase I Windows integration specification', () => {
  it('renders normal aliases and direct aliases that require both a TTY and explicit reason without bypass flags', () => {
    for (const shell of ['bash', 'powershell'] as const) {
      const body = buildManagedLauncherBody(shell);
      for (const alias of ['cc', 'ccw', 'pi', 'piw', 'ccd', 'ccwd']) {
        expect(body).toContain(alias);
      }
      expect(body).toContain('MPX_DIRECT_REASON');
      expect(body.toLowerCase()).toContain('tty');
      expect(body).toContain('--executor host');
      expect(body).toContain('--identity personal');
      expect(body).toContain('--identity work');
      expect(body).not.toMatch(/dangerous[^\n]*(skip|bypass)|--(?:skip|bypass)[^\n]*dangerous/iu);
    }
  });

  it('builds structured specs from MPX roots without guessing machine paths or shell quoting values', () => {
    const environment = {
      MPX_APPS: "C:\\Apps ' ; $evil",
      APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      USERPROFILE: 'C:\\Users\\me',
    };
    const specs = buildWindowsIntegrationSpecs(environment, 'DOMAIN\\me', 'a'.repeat(64));
    expect(specs.environment.desired).toMatchObject({ MPX_APPS: environment.MPX_APPS });
    const release = `${environment.MPX_APPS}\\mpx\\releases\\${'a'.repeat(64)}`;
    const selector = `${environment.MPX_APPS}\\mpx\\bin\\mpx.cmd`;
    expect(specs.terminal.desired).toMatchObject({
      commandline: { executable: selector, argv: ['shell'] },
    });
    expect(specs.shortcuts.every((item) => item.desired.targetPath === selector)).toBe(true);
    expect(specs.task.desired).toMatchObject({
      executable: process.execPath,
      argv: [
        `${release}\\bin\\mpx.mjs`,
        'session',
        'reconcile',
        '--capture',
        'scheduled',
        '--json',
      ],
      principal: 'DOMAIN\\me',
    });
    expect(JSON.stringify(specs)).toContain("Apps ' ; $evil");
    expect(JSON.stringify(specs)).not.toContain('runner.exe');
    expect(JSON.stringify(specs)).not.toContain('mpx.exe');
    expect(specs.task.desired).not.toHaveProperty('command');
    expect(specs.shortcuts.map((item) => item.target)).toEqual([
      'C:\\Users\\me\\Desktop\\MPX.lnk',
      'C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\MPX.lnk',
    ]);
  });
});

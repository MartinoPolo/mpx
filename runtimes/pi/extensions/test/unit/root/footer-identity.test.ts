import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  buildIdentityRow,
  buildModelRow,
  buildSessionRow,
  renderFooterRows,
  resolveFooterProviders,
  resolveFooterSessionIdentity,
  type FooterPalette,
  type FooterSnapshot,
} from '../../../footer.js';

const palette = Object.fromEntries(
  [
    'reset',
    'text',
    'gray',
    'dim',
    'barEmpty',
    'accent',
    'warn',
    'amber',
    'contextYellow',
    'contextOrange',
    'contextRed',
    'add',
    'del',
    'session',
    'local',
    'mr',
    'modelLuna',
    'modelTerra',
    'modelSol',
    'modelAstra',
    'effortOff',
    'effortMinimal',
    'effortLow',
    'effortMedium',
    'effortHigh',
    'effortXhigh',
    'effortMax',
  ].map((name) => [name, '']),
) as unknown as FooterPalette;

test('resolves MPX runtime and mode without retaining the removed skill-policy axis', () => {
  assert.deepEqual(
    resolveFooterSessionIdentity({
      MPX_RUNTIME: 'pi',
      MPX_IDENTITY: 'personal',
      MPX_MODE: 'project',
      MPX_SKILL_POLICY: 'obsolete',
    }),
    { runtimeLabel: 'pi (mpx)', mode: 'project' },
  );
  assert.deepEqual(
    resolveFooterSessionIdentity({
      MPX_RUNTIME: 'pi',
      MPX_IDENTITY: 'work',
      MPX_MODE: 'developer',
    }),
    { runtimeLabel: 'piw (mpx)', mode: 'developer' },
  );
});

test('uses compact native Pi labels and rejects unsafe display environment fields', () => {
  assert.deepEqual(resolveFooterSessionIdentity({ PI_CODING_AGENT_DIR: 'C:/Users/me/.pi/agent' }), {
    runtimeLabel: 'pi',
    mode: '',
  });
  assert.deepEqual(
    resolveFooterSessionIdentity({ PI_CODING_AGENT_DIR: 'C:/Users/me/.pi/agent-work' }),
    { runtimeLabel: 'piw', mode: '' },
  );
  assert.deepEqual(
    resolveFooterSessionIdentity({
      MPX_RUNTIME: 'pi',
      MPX_IDENTITY: 'personal\nspoof',
      MPX_MODE: 'developer\nspoof',
    }),
    { runtimeLabel: 'pi (mpx)', mode: '' },
  );
});

test('maps launch-bound provider environment values and preserves safe unknown providers', () => {
  assert.deepEqual(
    resolveFooterProviders({
      MPX_REPOSITORY_PROVIDER: 'gitlab',
      MPX_ISSUES_PROVIDER: 'kanbanflow',
    }),
    { repository: 'glab', issues: 'kf' },
  );
  assert.deepEqual(
    resolveFooterProviders({
      MPX_REPOSITORY_PROVIDER: 'forgejo',
      MPX_ISSUES_PROVIDER: 'none',
    }),
    { repository: 'forgejo', issues: 'none' },
  );
});

test('rejects malicious providers and does not resolve inherited object properties', () => {
  assert.deepEqual(
    resolveFooterProviders({
      MPX_REPOSITORY_PROVIDER: 'constructor',
      MPX_ISSUES_PROVIDER: 'github\nspoof',
    }),
    { repository: 'constructor', issues: '?' },
  );
});

test('uses unavailable placeholders when launch-bound providers are missing', () => {
  assert.deepEqual(resolveFooterProviders({}), { repository: '?', issues: '?' });
});

test('links runtime, mode, and provider fields to their distinct configured destinations', () => {
  const sessionIdentity = resolveFooterSessionIdentity({
    MPX_RUNTIME: 'pi',
    MPX_MODE: 'project',
    MPX_ACCOUNT_CONFIG_PATH: 'C:\\Users\\me\\MPX account.json',
    MPX_PROJECT_CONFIG_PATH: '/workspace/project mpxconfig.json',
  });
  const providers = resolveFooterProviders({
    MPX_REPOSITORY_PROVIDER: 'github',
    MPX_ISSUES_PROVIDER: 'kanbanflow',
    MPX_REPOSITORY_URL: 'https://github.com/example/repo/pull/42',
    MPX_ISSUES_URL: 'https://kanbanflow.com/board/example',
  });
  const [row] = renderFooterRows({ palette, sessionIdentity, providers } as FooterSnapshot, [
    buildIdentityRow,
  ]);

  for (const destination of [
    'file:///C:/Users/me/MPX%20account.json',
    'file:///workspace/project%20mpxconfig.json',
    'https://github.com/example/repo/pull/42',
    'https://kanbanflow.com/board/example',
  ]) {
    assert.ok(row.includes(destination), `missing ${destination}`);
  }
  assert.match(row, /pi \(mpx\).*mode:project.*gh.*kf/u);
  assert.doesNotMatch(row, /skills:/u);
});

test('leaves identity text unlinked when destinations are missing or unsafe', () => {
  const sessionIdentity = resolveFooterSessionIdentity({
    MPX_RUNTIME: 'pi',
    MPX_MODE: 'project',
    MPX_ACCOUNT_CONFIG_PATH: 'relative/config.json',
    MPX_PROJECT_CONFIG_PATH: '/safe/path\nspoof',
  });
  const providers = resolveFooterProviders({
    MPX_REPOSITORY_PROVIDER: 'gitlab',
    MPX_ISSUES_PROVIDER: 'github',
    MPX_REPOSITORY_URL: 'file:///tmp/repository',
    MPX_ISSUES_URL: 'https://user:secret@example.com/issues\u0007spoof',
  });

  assert.deepEqual(sessionIdentity, {
    runtimeLabel: 'pi (mpx)',
    mode: 'project',
  });
  assert.deepEqual(providers, { repository: 'glab', issues: 'gh' });
  assert.equal(
    renderFooterRows({ palette, sessionIdentity, providers } as FooterSnapshot, [
      buildIdentityRow,
    ])[0],
    'pi (mpx) · mode:project · glab · gh',
  );
});

test('encodes Unicode and spaces in linked native filesystem paths', () => {
  const identity = resolveFooterSessionIdentity({
    MPX_RUNTIME: 'pi',
    MPX_ACCOUNT_CONFIG_PATH: 'C:\\Users\\Zoë\\配置 files\\account.json',
  });
  assert.equal(
    identity.accountConfigUrl,
    'file:///C:/Users/Zo%C3%AB/%E9%85%8D%E7%BD%AE%20files/account.json',
  );
});

test('renders ordered mode and provider roles without collapsing duplicate badges', () => {
  const snapshot = {
    palette,
    sessionIdentity: {
      runtimeLabel: 'pi (mpx)',
      mode: 'developer',
    },
    providers: { repository: 'gh', issues: 'gh' },
  } as FooterSnapshot;

  assert.deepEqual(renderFooterRows(snapshot, [buildIdentityRow]), [
    'pi (mpx) · mode:developer · gh · gh',
  ]);
});

test('renders session details before the identity row', () => {
  const snapshot = {
    palette,
    sessionName: 'Footer identity',
    sessionShortId: '01a07ce9',
    sessionFileUrl: '',
    sessionIdentity: { runtimeLabel: 'pi (mpx)', mode: 'developer' },
    providers: { repository: 'glab', issues: 'kf' },
  } as FooterSnapshot;

  assert.deepEqual(renderFooterRows(snapshot, [buildSessionRow, buildIdentityRow]), [
    'Footer identity · #01a07ce9',
    'pi (mpx) · mode:developer · glab · kf',
  ]);
});

test('colors model families by complexity and gauges by effort', () => {
  const coloredPalette = {
    ...palette,
    reset: '</>',
    gray: '<gray>',
    accent: '<accent>',
    modelLuna: '<green>',
    modelTerra: '<yellow>',
    modelSol: '<orange>',
    modelAstra: '<purple>',
    effortOff: '<white>',
    effortMinimal: '<minimal>',
    effortLow: '<green>',
    effortMedium: '<blue>',
    effortHigh: '<yellow>',
    effortXhigh: '<orange>',
    effortMax: '<red>',
  };
  const snapshot = {
    palette: coloredPalette,
    modelName: 'gpt-5.6-sol',
    thinkingLevel: 'xhigh',
  } as FooterSnapshot;

  assert.deepEqual(renderFooterRows(snapshot, [buildModelRow]), [
    '<orange>gpt-5.6-sol</> <gray>·</> <orange>◆◆◆◆◆◇</>',
  ]);
});

import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  buildIdentityRow,
  buildModelRow,
  buildSessionRow,
  renderFooterRows,
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

test('resolves MPX launch identity details from the trusted launch environment', () => {
  assert.deepEqual(
    resolveFooterSessionIdentity({
      MPX_RUNTIME: 'pi',
      MPX_IDENTITY: 'personal',
      MPX_MODE: 'developer',
    }),
    { runtimeLabel: 'pi (mpx)', identity: 'personal', mode: 'developer' },
  );
  assert.deepEqual(
    resolveFooterSessionIdentity({
      MPX_RUNTIME: 'pi',
      MPX_IDENTITY: 'work',
      MPX_MODE: 'developer',
    }),
    { runtimeLabel: 'piw (mpx)', identity: 'work', mode: 'developer' },
  );
});

test('uses a compact native Pi label inferred from the selected account root', () => {
  assert.deepEqual(resolveFooterSessionIdentity({ PI_CODING_AGENT_DIR: 'C:/Users/me/.pi/agent' }), {
    runtimeLabel: 'pi',
    identity: '',
    mode: '',
  });
  assert.deepEqual(
    resolveFooterSessionIdentity({ PI_CODING_AGENT_DIR: 'C:/Users/me/.pi/agent-work' }),
    { runtimeLabel: 'piw', identity: '', mode: '' },
  );
});

test('renders session details first and launch identity second', () => {
  const snapshot = {
    palette,
    sessionName: 'Footer identity',
    sessionShortId: '01a07ce9',
    sessionFileUrl: '',
    sessionIdentity: { runtimeLabel: 'pi (mpx)', identity: 'personal', mode: 'developer' },
  } as FooterSnapshot;

  assert.deepEqual(renderFooterRows(snapshot, [buildSessionRow, buildIdentityRow]), [
    'Footer identity · #01a07ce9',
    'pi (mpx) · personal · developer',
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

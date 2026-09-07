import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  buildIdentityRow,
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
  ].map((name) => [name, '']),
) as unknown as FooterPalette;

test('resolves MPX launch identity details from the trusted launch environment', () => {
  assert.deepEqual(
    resolveFooterSessionIdentity({
      MPX_RUNTIME: 'pi',
      MPX_IDENTITY: 'personal',
      MPX_MODE: 'developer',
    }),
    { runtimeLabel: 'mpx-pi', identity: 'personal', mode: 'developer' },
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
    sessionIdentity: { runtimeLabel: 'mpx-pi', identity: 'personal', mode: 'developer' },
  } as FooterSnapshot;

  assert.deepEqual(renderFooterRows(snapshot, [buildSessionRow, buildIdentityRow]), [
    'Footer identity · #01a07ce9',
    'mpx-pi · personal · developer',
  ]);
});

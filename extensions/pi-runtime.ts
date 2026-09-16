import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readUserConfig } from '../src/config.js';
import { resolveFooterRepository } from '../src/pi-footer-data.js';
import { isMpx2RuntimeSelected } from '../src/runtime-selection.js';
import { createPiUiExtension } from './pi-ui.js';
import context from './pi-context.js';
import safeguards from './pi-safeguards.js';
import formatting from './pi-format.js';

/** MPX2-owned composition only; native-account MCP/web/question packages remain native. */
export default async function mpx2(pi: ExtensionAPI): Promise<void> {
  if (!(await isMpx2RuntimeSelected(fileURLToPath(new URL('../', import.meta.url))))) return;
  context(pi);
  safeguards(pi);
  formatting(pi);
  const config = process.env.APPDATA ? await readUserConfig(path.join(process.env.APPDATA, 'mpx2/config.json')).catch(() => undefined) : undefined;
  createPiUiExtension({
    title: config?.piTitle,
    loadRepository: cwd => resolveFooterRepository(cwd, config),
  })(pi);
  const instructions = await Promise.all([
    readFile(new URL('../dist/pi/instructions/shared/AGENTS.md', import.meta.url), 'utf8'),
    readFile(new URL('../dist/pi/instructions/pi/APPEND_SYSTEM.md', import.meta.url), 'utf8'),
  ]).then(parts => parts.join('\n\n')).catch(() => {
    process.stderr.write('MPX2 canonical instructions unavailable; native context retained.\n');
    return '';
  });
  pi.on('before_agent_start', event => instructions ? { systemPrompt: `${event.systemPrompt}\n\n${instructions}` } : undefined);
  const entry = new URL('../node_modules/@tintinweb/pi-subagents/src/index.ts', import.meta.url).href;
  const upstream = await import(entry);
  await upstream.default(pi);
}

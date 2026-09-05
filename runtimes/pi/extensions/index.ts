import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import agentResurrect from './agent-resurrect.js';
import autoTitle from './auto-title.js';
import compactInstructions from './compact-instructions.js';
import footer from './footer.js';
import fullscreenScrollSpeed from './fullscreen-scroll-speed.js';
import guardHooks from './guard-hooks.js';
import devServer from './dev-server/index.js';
import subagents from './subagents/index.js';
import terminalProgress from './terminal-progress/index.js';

export { resolveCompactInstructionsFile } from './compact-instructions.js';
export { resolveGuardsDirectory } from './guard-hooks.js';

export interface ExtensionComponent {
  name: string;
  register: (pi: ExtensionAPI) => void;
}

export const DEFAULT_EXTENSION_COMPONENTS: readonly ExtensionComponent[] = [
  { name: 'agent-resurrect', register: agentResurrect },
  { name: 'auto-title', register: autoTitle },
  { name: 'compact-instructions', register: compactInstructions },
  { name: 'footer', register: footer },
  { name: 'fullscreen-scroll-speed', register: fullscreenScrollSpeed },
  { name: 'guard-hooks', register: guardHooks },
  { name: 'dev-server', register: devServer },
  { name: 'subagents', register: subagents },
  { name: 'terminal-progress', register: terminalProgress },
];

export function composeExtensions(
  pi: ExtensionAPI,
  components: readonly ExtensionComponent[] = DEFAULT_EXTENSION_COMPONENTS,
): void {
  for (const component of components) {
    component.register(pi);
  }
}

export default function mpxPiExtensions(pi: ExtensionAPI): void {
  composeExtensions(pi);
}

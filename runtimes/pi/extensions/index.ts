import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import agentResurrect from './agent-resurrect.js';
import autoTitle from './auto-title.js';
import compactInstructions from './compact-instructions.js';
import canonicalSkills from './canonical-skills.js';
import footer from './footer.js';
import fullscreenScrollSpeed from './fullscreen-scroll-speed.js';
import guardHooks, { canonicalNotifications } from './guard-hooks.js';
import devServer from './dev-server/index.js';
import subagents from './subagents/index.js';
import worktree from './worktree/index.js';
import sessionLifecycle from './session-lifecycle.js';
import terminalProgress from './terminal-progress/index.js';

export { resolveCompactInstructionsFile } from './compact-instructions.js';
export { resolveGuardsDirectory } from './guard-hooks.js';

export interface ExtensionComponent {
  name: string;
  register: (pi: ExtensionAPI) => void | Promise<void>;
}

export const DEFAULT_EXTENSION_COMPONENTS: readonly ExtensionComponent[] = [
  { name: 'session-lifecycle', register: sessionLifecycle },
  { name: 'agent-resurrect', register: agentResurrect },
  { name: 'auto-title', register: autoTitle },
  { name: 'compact-instructions', register: compactInstructions },
  { name: 'canonical-skills', register: canonicalSkills },
  { name: 'footer', register: footer },
  { name: 'fullscreen-scroll-speed', register: fullscreenScrollSpeed },
  { name: 'guard-hooks', register: guardHooks },
  { name: 'notifications', register: canonicalNotifications },
  { name: 'dev-server', register: devServer },
  { name: 'subagents', register: subagents },
  { name: 'worktree', register: worktree },
  { name: 'terminal-progress', register: terminalProgress },
];

export async function composeExtensions(
  pi: ExtensionAPI,
  components: readonly ExtensionComponent[] = DEFAULT_EXTENSION_COMPONENTS,
): Promise<void> {
  for (const component of components) {
    await component.register(pi);
  }
}

export default async function mpxPiExtensions(pi: ExtensionAPI): Promise<void> {
  await composeExtensions(pi);
}

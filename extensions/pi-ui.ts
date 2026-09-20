import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerPiUi, type PiUiOptions } from '../src/pi-ui.js';

export { registerPiUi } from '../src/pi-ui.js';
export type { PiActivitySink, PiActivitySnapshot, PiTitleConfig, PiUiOptions } from '../src/pi-ui.js';

export interface PiUiExtensionConfig extends Omit<PiUiOptions, 'title'> {
  /** The shape of UserConfig.piTitle; resolution/loading remains the parent's job. */
  title?: { provider: string; model: string; thinking: NonNullable<PiUiOptions['title']>['effort'] };
}

/** Build a synchronous Pi extension from already-resolved parent composition config. */
export function createPiUiExtension(config: PiUiExtensionConfig = {}): (pi: ExtensionAPI) => void {
  const { title, ...options } = config;
  return (pi) => registerPiUi(pi, {
    ...options,
    title: title === undefined
      ? undefined
      : { provider: title.provider, model: title.model, effort: title.thinking },
  });
}

/** Standalone loading uses the safe prompt-title fallback; pi-runtime supplies configured options. */
const piUiExtension = createPiUiExtension();
export default piUiExtension;

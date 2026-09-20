import { readFile } from 'node:fs/promises';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { compact } from '@earendil-works/pi-coding-agent';
import {
  MACHINE_ROOT_CUSTOM_TYPE,
  appendStyleReinforcement,
  machineRootContext,
  machineRootMessageToInject,
  mergeCompactionInstructions,
  withoutDeletedHeaders,
} from '../src/context.js';

const COMPACT_INSTRUCTIONS_URL = new URL(
  '../dist/pi/instructions/shared/COMPACT.md',
  import.meta.url,
);

type CompactRequest = typeof compact;

export interface PiContextDependencies {
  compactRequest?: CompactRequest;
  readCompactInstructions?: () => Promise<string>;
  env?: NodeJS.ProcessEnv;
  writeWarning?: (message: string) => void;
}

export function createPiContextExtension(dependencies: PiContextDependencies = {}) {
  const compactRequest = dependencies.compactRequest ?? compact;
  const readCompactInstructions =
    dependencies.readCompactInstructions ?? (() => readFile(COMPACT_INSTRUCTIONS_URL, 'utf8'));
  const env = dependencies.env ?? process.env;
  const writeWarning = dependencies.writeWarning ?? ((message: string) => process.stderr.write(message));

  return function piContextExtension(pi: ExtensionAPI): void {
    const warn = (ctx: ExtensionContext, message: string): void => {
      if (ctx.hasUI) {
        try {
          ctx.ui.notify(message, 'warning');
          return;
        } catch {
          // Fall through to stderr when the UI cannot display the diagnostic.
        }
      }
      try {
        writeWarning(`${message}\n`);
      } catch {
        // Diagnostics must never replace native fallback behavior.
      }
    };

    const rootContent = () => machineRootContext(env);

    const injectMachineRoots = (ctx: ExtensionContext): void => {
      const content = machineRootMessageToInject(
        ctx.sessionManager.buildContextEntries(),
        rootContent(),
      );
      if (!content) return;
      pi.sendMessage({ customType: MACHINE_ROOT_CUSTOM_TYPE, content, display: false });
    };

    pi.on('session_start', (_event, ctx) => {
      try {
        injectMachineRoots(ctx);
      } catch {
        warn(ctx, 'machine roots unavailable; continuing without them');
      }
    });

    pi.on('session_compact', (_event, ctx) => {
      try {
        injectMachineRoots(ctx);
      } catch {
        warn(ctx, 'machine roots unavailable; continuing without them');
      }
    });

    pi.on('before_agent_start', (event, ctx) => {
      const result: { systemPrompt: string; message?: { customType: string; content: string; display: false } } = {
        systemPrompt: appendStyleReinforcement(event.systemPrompt),
      };
      try {
        const content = machineRootMessageToInject(
          ctx.sessionManager.buildContextEntries(),
          rootContent(),
        );
        if (content) result.message = { customType: MACHINE_ROOT_CUSTOM_TYPE, content, display: false };
      } catch {
        warn(ctx, 'machine roots unavailable; continuing without them');
      }
      return result;
    });

    pi.on('session_before_compact', async (event, ctx) => {
      try {
        if (!ctx.model) throw new Error('no model');
        const guidance = await readCompactInstructions();
        const customInstructions = mergeCompactionInstructions(event.customInstructions, guidance);
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
        if (!auth.ok) throw new Error(auth.error);

        const requestModel = auth.baseUrl ? { ...ctx.model, baseUrl: auth.baseUrl } : ctx.model;
        const result = await compactRequest(
          event.preparation,
          requestModel,
          auth.apiKey,
          withoutDeletedHeaders(auth.headers),
          customInstructions,
          event.signal,
          ctx.thinkingLevel,
          undefined,
          auth.env,
        );
        return { compaction: result };
      } catch {
        if (!event.signal.aborted) {
          warn(ctx, 'compaction guidance unavailable; using native compaction');
        }
        return undefined;
      }
    });
  };
}

export default createPiContextExtension();

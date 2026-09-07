/**
 * Adds the package's canonical continuation instructions to Pi compaction.
 *
 * Mutating `event.customInstructions` does nothing: `agent-session.js` passes its own
 * local variable (manual `/compact`) or a hard-coded `undefined` (threshold/overflow)
 * to `compact()` after the event settles. The only lever an extension has is returning
 * a finished `compaction` result — so this handler re-runs pi's own exported
 * `compact()` with COMPACT.md appended as custom instructions, keeping the summary
 * otherwise identical to default compaction.
 *
 * Every failure path returns undefined, which falls back to pi's default compaction.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { compact } from '@earendil-works/pi-coding-agent';

const PACKAGE_COMPACT_INSTRUCTIONS_FILE = fileURLToPath(
  new URL('./config/COMPACT.md', import.meta.url),
);

/** @public */
export function resolveCompactInstructionsFile(
  configured = process.env.MPX_COMPACT_INSTRUCTIONS_FILE,
): string {
  const candidate = configured?.trim();
  return candidate && !candidate.includes('\0') && isAbsolute(candidate)
    ? resolve(candidate)
    : PACKAGE_COMPACT_INSTRUCTIONS_FILE;
}

export default function (pi: ExtensionAPI) {
  pi.on('session_before_compact', async (event, ctx) => {
    let instructions: string;
    try {
      instructions = readFileSync(resolveCompactInstructionsFile(), 'utf8').trim();
    } catch {
      return undefined;
    }
    if (!instructions || !ctx.model) {
      return undefined;
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (!auth.ok) {
      return undefined;
    }

    // Manual `/compact <args>` instructions keep priority; COMPACT.md follows them.
    const mergedInstructions = event.customInstructions
      ? `${event.customInstructions}\n\n${instructions}`
      : instructions;

    // Same request-shaping `_getSummarizationRequestAuth` applies before it calls
    // `compact()`: patch baseUrl onto the model and drop deleted (null) headers.
    const requestModel = auth.baseUrl ? { ...ctx.model, baseUrl: auth.baseUrl } : ctx.model;
    const requestHeaders = auth.headers
      ? Object.fromEntries(
          Object.entries(auth.headers).filter(
            (entry): entry is [string, string] => entry[1] !== null,
          ),
        )
      : undefined;

    try {
      const result = await compact(
        event.preparation,
        requestModel,
        auth.apiKey,
        requestHeaders,
        mergedInstructions,
        event.signal,
        ctx.thinkingLevel,
        undefined,
        auth.env,
      );
      return { compaction: result };
    } catch (error) {
      if (!event.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`compact-instructions: ${message} — using default compaction`, 'warning');
      }
      return undefined;
    }
  });
}

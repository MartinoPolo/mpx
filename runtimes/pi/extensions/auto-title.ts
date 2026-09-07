import { type UserMessage, uuidv7 } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

const TITLE_PROVIDER = 'openai-codex';
const TITLE_MODEL = 'gpt-5.6-luna';
const MAX_PROMPT_CHARACTERS = 4_000;
const MAX_TITLE_CHARACTERS = 80;
const MAX_FALLBACK_WORDS = 8;

const TITLE_SYSTEM_PROMPT = `Create a concise title for a coding-agent session from the user's first prompt.

Rules:
- Return only the title, with no quotes, markdown, label, or trailing punctuation.
- Use 3-7 words when practical.
- Describe the concrete task or question, not the requested action.
- Preserve important product, library, command, and file names.
- Do not answer the prompt.`;

function textFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        typeof part === 'object' &&
        part !== null &&
        'type' in part &&
        part.type === 'text' &&
        'text' in part &&
        typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function firstUserPrompt(ctx: ExtensionContext): string | undefined {
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== 'message' || entry.message.role !== 'user') {
      continue;
    }
    const text = textFromContent(entry.message.content);
    if (text !== '') {
      return text;
    }
  }
  return undefined;
}

function normalizeGeneratedTitle(value: string): string | undefined {
  const firstLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '');
  if (firstLine === undefined) {
    return undefined;
  }

  const title = firstLine
    .replace(/^(?:title\s*:\s*)/i, '')
    .replace(/^[`"'*_]+|[`"'*_]+$/g, '')
    .replace(/[.!?,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (title === '') {
    return undefined;
  }
  return title.slice(0, MAX_TITLE_CHARACTERS).trimEnd();
}

function fallbackTitle(prompt: string): string {
  const words = prompt
    .replace(/[`*_#>[\](){}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, MAX_FALLBACK_WORDS);
  const fallback = words.join(' ').replace(/[.!?,;:]+$/g, '');
  return (fallback === '' ? 'New Pi Session' : fallback).slice(0, MAX_TITLE_CHARACTERS).trimEnd();
}

async function generateTitle(
  prompt: string,
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<string> {
  const model = ctx.modelRegistry.find(TITLE_PROVIDER, TITLE_MODEL) ?? ctx.model;
  if (model === undefined) {
    return fallbackTitle(prompt);
  }

  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      return fallbackTitle(prompt);
    }
    const { apiKey } = auth;

    const message: UserMessage = {
      role: 'user',
      content: [{ type: 'text', text: prompt.slice(0, MAX_PROMPT_CHARACTERS) }],
      timestamp: Date.now(),
    };
    const response = await ctx.modelRegistry.complete(
      model,
      { systemPrompt: TITLE_SYSTEM_PROMPT, messages: [message] },
      {
        apiKey,
        headers: auth.headers,
        env: auth.env,
        signal,
        reasoning: 'minimal',
        maxTokens: 128,
        cacheRetention: 'none',
        maxRetries: 0,
        sessionId: uuidv7(),
        timeoutMs: 30_000,
      },
    );
    const generated = normalizeGeneratedTitle(textFromContent(response.content));
    return generated ?? fallbackTitle(prompt);
  } catch {
    return fallbackTitle(prompt);
  }
}

export default function (pi: ExtensionAPI): void {
  let sessionId = '';
  let firstPrompt: string | undefined;
  let generationStarted = false;
  let explicitlyNamed = false;
  let pendingAutomaticName: string | undefined;
  let generationController: AbortController | undefined;

  const abortGeneration = (): void => {
    generationController?.abort();
    generationController = undefined;
  };

  pi.on('session_start', (_event, ctx) => {
    abortGeneration();
    sessionId = ctx.sessionManager.getSessionId();
    firstPrompt = firstUserPrompt(ctx);
    generationStarted = false;
    explicitlyNamed = pi.getSessionName() !== undefined;
    pendingAutomaticName = undefined;
  });

  pi.on('input', (event) => {
    if (event.source !== 'extension' && firstPrompt === undefined && event.text.trim() !== '') {
      firstPrompt = event.text.trim();
    }
  });

  pi.on('session_info_changed', (event) => {
    if (pendingAutomaticName !== undefined && event.name === pendingAutomaticName) {
      pendingAutomaticName = undefined;
      return;
    }
    explicitlyNamed = true;
    abortGeneration();
  });

  pi.on('agent_settled', (_event, ctx) => {
    if (generationStarted || explicitlyNamed || pi.getSessionName() !== undefined) {
      return;
    }
    firstPrompt ??= firstUserPrompt(ctx);
    if (firstPrompt === undefined) {
      return;
    }

    generationStarted = true;
    const generationSessionId = sessionId;
    const prompt = firstPrompt;
    const controller = new AbortController();
    generationController = controller;

    void generateTitle(prompt, ctx, controller.signal).then((title) => {
      if (
        controller.signal.aborted ||
        sessionId !== generationSessionId ||
        explicitlyNamed ||
        pi.getSessionName() !== undefined
      ) {
        return;
      }
      pendingAutomaticName = title;
      pi.setSessionName(title);
    });
  });

  pi.on('session_before_switch', () => abortGeneration());
  pi.on('session_shutdown', () => abortGeneration());
}

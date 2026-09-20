import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { parseFooterQuota } from './pi-footer-data.js';
import type { FooterQuotaWindow } from './pi-footer.js';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const PROVIDER = 'openai-codex';
const AUTH_CLAIM = 'https://api.openai.com/auth';
const DEADLINE_MS = 5_000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TOKEN_LENGTH = 16 * 1024;
const MAX_ACCOUNT_ID_LENGTH = 512;

export interface FooterQuotaObservation {
  windows: FooterQuotaWindow[];
  observedAt: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function validNumber(value: unknown, maximum = Number.POSITIVE_INFINITY): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum;
}

export function parseFooterQuotaResponse(value: unknown, now: number): FooterQuotaWindow[] | undefined {
  const limits = record(record(value)?.rate_limit);
  if (!limits) return undefined;
  const headers: Record<string, string> = {};
  for (const [name, fallbackMinutes] of [['primary', 300], ['secondary', 10_080]] as const) {
    const window = record(limits[`${name}_window`]);
    if (!window || !validNumber(window.used_percent, 100)) continue;
    const seconds = window.limit_window_seconds;
    const resetAt = window.reset_at;
    const resetAfter = window.reset_after_seconds;
    if ((seconds !== undefined && !validNumber(seconds))
      || (resetAt !== undefined && !validNumber(resetAt))
      || (resetAfter !== undefined && !validNumber(resetAfter))) continue;
    const prefix = `x-codex-${name}-`;
    headers[`${prefix}used-percent`] = String(window.used_percent);
    headers[`${prefix}window-minutes`] = String(seconds === undefined ? fallbackMinutes : Math.round(seconds / 60));
    if (resetAt !== undefined) headers[`${prefix}reset-at`] = String(resetAt);
    if (resetAfter !== undefined) headers[`${prefix}reset-after-seconds`] = String(resetAfter);
  }
  return parseFooterQuota(headers, now);
}

function accountIdFromToken(token: string): string | undefined {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return undefined;
  try {
    const payloadPart = token.split('.')[1]!;
    if (payloadPart.length > MAX_TOKEN_LENGTH) return undefined;
    const payload = record(JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')));
    const auth = record(payload?.[AUTH_CLAIM]);
    const id = auth?.chatgpt_account_id;
    return typeof id === 'string' && id.length > 0 && id.length <= MAX_ACCOUNT_ID_LENGTH && !/[\x00-\x20\x7f-\x9f]/.test(id)
      ? id : undefined;
  } catch {
    return undefined;
  }
}

async function readBounded(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error('Missing response body');
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > MAX_BODY_BYTES) throw new Error('Response body too large');
      chunks.push(item.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function requestFooterQuota(
  context: Pick<ExtensionContext, 'modelRegistry'>,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<FooterQuotaObservation | undefined> {
  if (signal.aborted) return undefined;
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Quota request deadline exceeded')), DEADLINE_MS);
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(controller.signal.reason ?? new Error('Aborted'));
    if (controller.signal.aborted) rejectAbort();
    else controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  try {
    const token = await Promise.race([context.modelRegistry.getApiKeyForProvider(PROVIDER), aborted]);
    if (controller.signal.aborted || typeof token !== 'string') return undefined;
    const accountId = accountIdFromToken(token);
    if (!accountId || controller.signal.aborted) return undefined;
    const response = await Promise.race([request(USAGE_URL, {
      method: 'GET', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, 'chatgpt-account-id': accountId },
    }), aborted]);
    if (!response.ok) {
      await Promise.race([response.body?.cancel().catch(() => undefined), aborted]);
      return undefined;
    }
    const body = await Promise.race([readBounded(response, controller.signal), aborted]);
    if (controller.signal.aborted) return undefined;
    const observedAt = Date.now();
    const windows = parseFooterQuotaResponse(body, observedAt);
    return windows ? { windows, observedAt } : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
  }
}

import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function nonNegativeFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function assistantInputUsage(entry: unknown): number | undefined {
  const source = object(entry);
  if (source?.type !== 'message') return undefined;
  const message = object(source.message);
  if (message?.role !== 'assistant') return undefined;
  const usage = object(message.usage);
  const input = nonNegativeFinite(usage?.input);
  if (input === undefined) return undefined;
  const cacheRead = usage && 'cacheRead' in usage ? nonNegativeFinite(usage.cacheRead) : 0;
  const cacheWrite = usage && 'cacheWrite' in usage ? nonNegativeFinite(usage.cacheWrite) : 0;
  if (cacheRead === undefined || cacheWrite === undefined) return undefined;
  const total = input + cacheRead + cacheWrite;
  return Number.isFinite(total) ? total : undefined;
}

export async function readPeakInputTokens(
  transcriptUrl: string,
  signal?: AbortSignal,
): Promise<number | undefined> {
  try {
    const url = new URL(transcriptUrl);
    if (url.protocol !== 'file:') return undefined;
    const transcriptPath = fileURLToPath(url);
    if (!path.isAbsolute(transcriptPath)) return undefined;

    const input = createReadStream(transcriptPath, { encoding: 'utf8', signal });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let peak: number | undefined;
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const requestInput = assistantInputUsage(JSON.parse(line));
        if (requestInput !== undefined && (peak === undefined || requestInput > peak)) peak = requestInput;
      } catch {
        // A malformed or truncated JSONL entry does not invalidate complete usage entries.
      }
    }
    return peak;
  } catch {
    return undefined;
  }
}

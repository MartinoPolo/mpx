/** Deterministic `unfinished` command shared by the Claude prompt hook and the Pi extension. */
const SCRIPT = new URL('../content/skills/unfinished/scripts/unfinished.mjs', import.meta.url).href;

export const CLAUDE_UNFINISHED_PROMPT = /^\/mpx-unfinished(?:\s+([\s\S]*))?$/;

export interface UnfinishedRequest { sessionId: string; cwd: string; argument: string; title?: string; transcriptPath?: string; env?: NodeJS.ProcessEnv }

export async function saveUnfinished(request: UnfinishedRequest): Promise<string> {
  const vault = (request.env ?? process.env).MPX_OBSIDIAN_VAULT;
  if (!vault) return 'MPX_OBSIDIAN_VAULT is not set, so the unfinished list cannot be updated.';
  const script = await import(SCRIPT);
  const argument = request.argument.trim();
  const done = /^-{0,2}done$/i.test(argument);
  const title = request.title ?? (request.transcriptPath ? await script.claudeSessionTitle(request.transcriptPath) : undefined);
  return script.recordUnfinished({ vault, sessionId: request.sessionId, cwd: request.cwd, title, note: done ? undefined : argument || undefined, done });
}

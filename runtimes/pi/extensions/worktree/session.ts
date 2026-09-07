import { existsSync, writeFileSync } from 'node:fs';

import { SessionManager, type ExtensionContext } from '@earendil-works/pi-coding-agent';

export function forkWorktreeSession(context: ExtensionContext, target: string): string {
  const source = context.sessionManager;
  const sourceFile = source.getSessionFile();
  if (!sourceFile) {
    throw new Error('Worktree handoff requires a saved session; --no-session is not supported.');
  }
  let destination: SessionManager;
  if (existsSync(sourceFile)) {
    destination = SessionManager.forkFrom(sourceFile, target);
  } else {
    destination = SessionManager.create(target);
    const file = destination.getSessionFile()!;
    writeFileSync(
      file,
      [destination.getHeader(), ...source.getEntries()]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n',
      { flag: 'wx' },
    );
    destination = SessionManager.open(file);
  }
  const leaf = source.getLeafId();
  if (leaf === null) {
    destination.resetLeaf();
  } else {
    destination.branch(leaf);
  }
  if (context.model) {
    destination.appendModelChange(context.model.provider, context.model.id);
  }
  if (context.thinkingLevel !== undefined) {
    destination.appendThinkingLevelChange(context.thinkingLevel);
  }
  destination.appendCustomMessageEntry(
    'worktree-handoff',
    `Working directory changed from ${context.cwd} to ${target}. This is the active checkout for all subsequent work. ` +
      'Older absolute paths in the conversation still refer to the previous checkout; do not use them for implementation. ' +
      "Follow the destination's loaded instructions and read its .worktree-ports.json before starting servers. " +
      'Worktree Hub may still be installing dependencies in the background; .worktree-install.log appears only if installation fails.',
    true,
    { sourceSession: sourceFile, sourceCwd: context.cwd, cwd: target },
  );
  return destination.getSessionFile()!;
}

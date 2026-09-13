import { constants } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createEditToolDefinition, createWriteToolDefinition, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { formatEditedFile } from '../src/safeguards/format.js';
import { repositoryRoot } from '../src/safeguards/fallow.js';

/** Formatting runs inside native edit/write's per-file mutation queue, not after its release. */
export function createPiFormatExtension(format = formatEditedFile): (pi: ExtensionAPI) => void {
  return pi => {
    const writer = (ctx: ExtensionContext, diagnostics: string[]) => async (file: string, content: string) => {
      await writeFile(file, content, 'utf8');
      const currentRoot = await repositoryRoot(ctx.cwd);
      try {
        const result = await format(file, ctx.cwd, { isTrusted: root => ctx.isProjectTrusted() && currentRoot !== undefined && path.resolve(root) === path.resolve(currentRoot) });
        diagnostics.push(...result.diagnostics);
      } catch { diagnostics.push('Formatter failed; the successful agent edit is preserved. Use the project formatting command.'); }
    };
    pi.registerTool({
      ...createWriteToolDefinition(process.cwd()),
      async execute(id, input, signal, onUpdate, ctx) {
        const diagnostics: string[] = [];
        const native = createWriteToolDefinition(ctx.cwd, { operations: { writeFile: writer(ctx, diagnostics), mkdir: async directory => { await mkdir(directory, { recursive: true }); } } });
        const result = await native.execute(id, input, signal, onUpdate, ctx);
        return { ...result, content: [...result.content, ...diagnostics.map(text => ({ type: 'text' as const, text }))] };
      },
    });
    pi.registerTool({
      ...createEditToolDefinition(process.cwd()),
      async execute(id, input, signal, onUpdate, ctx) {
        const diagnostics: string[] = [];
        const native = createEditToolDefinition(ctx.cwd, { operations: { readFile, writeFile: writer(ctx, diagnostics), access: file => access(file, constants.R_OK | constants.W_OK) } });
        const result = await native.execute(id, input, signal, onUpdate, ctx);
        return { ...result, content: [...result.content, ...diagnostics.map(text => ({ type: 'text' as const, text: `${text} (Native edit diff describes the requested edit; reread for final formatted bytes.)` }))] };
      },
    });
  };
}
export default createPiFormatExtension();

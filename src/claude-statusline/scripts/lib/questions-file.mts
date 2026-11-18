import { readFileSync } from "node:fs";
import path from "node:path";

/** A numbered HITL item's first line: `N. **Title:** …`, with an optional blocker mark. */
export const HITL_ITEM_LINE = /^(\d+)\.\s+(?:🛑\s*)?\*\*(.+?)\*\*(.*)$/u;

/**
 * Claude Code keeps a folder named after the session beside its transcript, so
 * a file there needs no registry and is found from the transcript path alone.
 */
export function questionsFilePath(transcriptPath: string): string {
    return path.join(transcriptPath.replace(/\.jsonl$/i, ""), "questions.md");
}

/** Open items in the session's questions file; 0 when the session has none. */
export function countWaitingItems(transcriptPath: string): number {
    try {
        return readFileSync(questionsFilePath(transcriptPath), "utf8")
            .split(/\r?\n/)
            .filter((line) => HITL_ITEM_LINE.test(line)).length;
    } catch {
        return 0;
    }
}

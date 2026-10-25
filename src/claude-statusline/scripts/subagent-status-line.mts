#!/usr/bin/env node

// Tasks-panel status line: collapses every running sub-agent into one summary
// row (count, tiers, tokens, longest elapsed) and records each agent in the
// session state file the main bar's finished-agent tally reads.
//
// Contract (verified against the 2.1.310 bundle): stdin is a JSON object
// {columns, session_id, cwd, transcript_path, tasks:[{id,name,type,agentType,
// status,description,label,startTime,model,effort,contextWindowSize,tokenCount,
// tokenSamples,cwd}]}; stdout is JSONL, one {"id","content"} object per row, 5s
// timeout. Rows whose id is not emitted keep the built-in rendering, and a row
// whose content is "" is dropped from the panel — that is what hides the
// per-agent rows behind the single summary row.
//
// The summary hangs off the first running task: the panel only renders rows for
// ids in the payload, so a session-wide line has nowhere of its own to live.
// Terminal tasks stay in the payload for 30s (the bundle's eviction delay); they
// are hidden too, because the main bar's tally already counts them.
//
// A task's tokens and elapsed time freeze the first tick it is seen terminal, so
// a finished agent stops accruing time in the state file.

import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    realpathSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RESET, readStdin, toNonNegativeInt } from "./lib/statusline-ansi.mts";
import { loadPalette } from "./lib/terminal-theme.mts";
import { isSafeStatusIdentifier } from "./lib/compaction.mts";
import {
    TIER_COLORS,
    TIER_ORDER,
    UNKNOWN_TIER,
    capitalize,
    countLabel,
    formatDuration,
    formatTokens,
    groupByOrder,
    isTerminalStatus,
    modelTier,
    readSessionRecords,
    serializeRecord,
    sessionStateDir,
    statusStyle,
    type StateRecord,
} from "./lib/subagent-history.mts";

const PALETTE = loadPalette();
const GRAY = PALETTE.gray;
const DIM = PALETTE.dim;

const CONFIG_DIR =
    process.env.CLAUDE_CONFIG_DIR || `${process.env.HOME || homedir()}/.claude`;
const STATE_DIR = sessionStateDir(CONFIG_DIR);

const PRUNE_AFTER_DAYS = 7;

/** One task from the payload, every field already flattened to a string. */
export interface TaskFields {
    id: string;
    model: string;
    effort: string;
    status: string;
    startTime: string;
    tokenCount: string;
}

export function taskRecord(task: TaskFields, nowMs: number): StateRecord {
    const startTime = toNonNegativeInt(task.startTime, 0);
    return {
        id: task.id,
        tier: modelTier(task.model) || UNKNOWN_TIER,
        effort: task.effort,
        tokens: task.tokenCount === "" ? "0" : task.tokenCount,
        elapsedMs: String(startTime > 0 ? nowMs - startTime : 0),
        status: task.status,
    };
}

/**
 * Merges this tick's records into the session state. A record already terminal
 * keeps its frozen tokens and elapsed time; everything else is overwritten. New
 * ids append in encounter order, existing ids keep their original position.
 */
export function mergeSessionState(fresh: StateRecord[], prior: StateRecord[]): StateRecord[] {
    // Map insertion order is first-seen order, and re-setting an existing key
    // updates the value without moving it — which is exactly the freeze rule.
    const merged = new Map<string, StateRecord>();
    for (const record of prior) {
        if (record.id !== "") merged.set(record.id, record);
    }
    for (const record of fresh) {
        const existing = merged.get(record.id);
        if (existing !== undefined && isTerminalStatus(existing.status)) continue;
        merged.set(record.id, record);
    }
    return [...merged.values()];
}

/** `● 3 running · 2×Sonnet 1×Opus · 412.3k tokens · 4m12s`, or "" when none run. */
export function buildRunningSummary(running: StateRecord[]): string {
    if (running.length === 0) return "";
    const members = running.map((record) => ({
        label: record.tier,
        tokens: Number.parseFloat(record.tokens) || 0,
        drifted: false,
    }));
    const tiers = groupByOrder(members, TIER_ORDER)
        .map((group) => `${TIER_COLORS[group.label] ?? GRAY}${countLabel(group.count, capitalize(group.label))}${RESET}`)
        .join(" ");
    const tokens = members.reduce((sum, member) => sum + member.tokens, 0);
    const longest = Math.max(...running.map((record) => Number.parseFloat(record.elapsedMs) || 0));
    const status = statusStyle("running");
    return (
        `${status.color}${status.glyph}${RESET} ${running.length} running` +
        ` ${DIM}·${RESET} ${tiers}` +
        ` ${DIM}· ${formatTokens(Math.trunc(tokens))} tokens · ${formatDuration(longest)}${RESET}`
    );
}

/** jq's `tostring`: strings pass through, everything else renders as JSON. */
function toText(value: unknown): string {
    if (typeof value === "string") return value;
    return JSON.stringify(value) ?? "";
}

/** jq's `//`: null and false fall through to the alternative. */
function orDefault(value: unknown, fallback: string): string {
    if (value === null || value === undefined || value === false) return fallback;
    return toText(value);
}

export function extractTasks(payload: unknown): TaskFields[] {
    const tasks = (payload as { tasks?: unknown })?.tasks;
    if (!Array.isArray(tasks)) return [];
    return tasks.map((raw) => {
        const task = (raw ?? {}) as Record<string, unknown>;
        return {
            id: orDefault(task.id, ""),
            model: orDefault(task.model, ""),
            effort: orDefault(task.effort, ""),
            status: orDefault(task.status, ""),
            startTime: orDefault(task.startTime, "0"),
            tokenCount: orDefault(task.tokenCount, "0"),
        };
    });
}

/**
 * Writes through a temp file: the panel kills in-flight scripts when a new
 * update arrives, and a tick cancelled mid-write would otherwise truncate the
 * session tally.
 */
function writeState(stateFile: string, records: StateRecord[]): void {
    const temporaryFile = `${stateFile}.tmp`;
    try {
        const body = records.map((record) => `${serializeRecord(record)}\n`).join("");
        writeFileSync(temporaryFile, body);
        if (statSync(temporaryFile).size > 0) renameSync(temporaryFile, stateFile);
    } catch {
        // A tally that fails to persist is not worth breaking the panel over.
    }
}

/** `find -mtime +7 -delete`: strictly more than seven whole days old. */
function pruneStaleState(nowMs: number): void {
    try {
        for (const entry of readdirSync(STATE_DIR)) {
            if (!entry.endsWith(".tsv")) continue;
            const path = `${STATE_DIR}/${entry}`;
            const ageDays = Math.floor((nowMs - statSync(path).mtimeMs) / 86400000);
            if (ageDays > PRUNE_AFTER_DAYS) unlinkSync(path);
        }
    } catch {
        // Pruning is housekeeping; a missing or busy file must not stop a render.
    }
}

function main(): void {
    const input = readStdin();

    // Raw-payload capture, gated on a marker file rather than an env var: the
    // panel runs this from inside Claude Code, so there is no shell in which to
    // export one. `touch ~/.claude/subagent-statusline-debug` to record, delete
    // it to stop.
    if (existsSync(`${CONFIG_DIR}/subagent-statusline-debug`)) {
        try {
            appendFileSync(
                `${CONFIG_DIR}/subagent-statusline-debug.jsonl`,
                `${input.replace(/\n+$/, "")}\n`,
            );
        } catch {
            // Debug capture never blocks a render.
        }
    }

    let payload: unknown;
    try {
        payload = JSON.parse(input);
    } catch {
        return;
    }

    const sessionId = orDefault((payload as { session_id?: unknown })?.session_id, "nosession") || "nosession";
    if (!isSafeStatusIdentifier(sessionId)) return;

    // Second granularity: elapsed time is rendered in whole seconds, so a
    // millisecond clock would only add render churn.
    const nowMs = Math.floor(Date.now() / 1000) * 1000;
    const records = extractTasks(payload)
        .filter((task) => isSafeStatusIdentifier(task.id))
        .map((task) => taskRecord(task, nowMs));
    if (records.length === 0) return;

    const stateFile = `${STATE_DIR}/${sessionId}.tsv`;
    if (!existsSync(stateFile)) {
        try {
            mkdirSync(STATE_DIR, { recursive: true });
        } catch {
            // Absent state only costs the tally, not the rows.
        }
        // Prune on first tick of a session only; a scan on every tick would be
        // paid several times a second for a directory that changes once.
        pruneStaleState(nowMs);
    }
    writeState(stateFile, mergeSessionState(records, readSessionRecords(stateFile)));

    const running = records.filter((record) => !isTerminalStatus(record.status));
    const summaryId = running[0]?.id;
    const summary = buildRunningSummary(running);
    process.stdout.write(
        records
            .map((record) => `${JSON.stringify({ id: record.id, content: record.id === summaryId ? summary : "" })}\n`)
            .join(""),
    );
}

/**
 * Compared through realpath because the panel may invoke this via a symlink.
 * Node resolves `import.meta.url` to the link target while `process.argv[1]`
 * keeps the link path, so a plain compare silently fails and every row falls
 * back to the built-in rendering.
 */
function resolveRealPath(target: string): string {
    try {
        return realpathSync(path.resolve(target));
    } catch {
        return path.resolve(target);
    }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolveRealPath(invokedPath) === resolveRealPath(fileURLToPath(import.meta.url))) {
    main();
}

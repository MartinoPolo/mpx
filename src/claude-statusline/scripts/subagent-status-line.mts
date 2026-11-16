#!/usr/bin/env node

// Tasks-panel status line: collapses every running sub-agent into one summary
// row (count, tiers, tokens, longest elapsed). Stateless: each tick renders only
// the payload it was given.
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
// Terminal tasks stay in the payload for 30s (the bundle's eviction delay) and
// are hidden too.

import { appendFileSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RESET, isNonNegativeInt, readStdin, toNonNegativeInt } from "./lib/statusline-ansi.mts";
import { loadPalette } from "./lib/terminal-theme.mts";

const PALETTE = loadPalette();
const GRAY = PALETTE.gray;
const DIM = PALETTE.dim;
/** `●` U+25CF is in plain Cascadia Mono's cmap, so it never falls back to an emoji face. */
const RUNNING_GLYPH = `${PALETTE.effortBudget}●${RESET}`;

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || `${process.env.HOME || homedir()}/.claude`;

/** Model tier colors; declaration order is the order the summary lists tiers in. */
const TIER_COLORS: Readonly<Record<string, string>> = {
    opus: PALETTE.accent,
    sonnet: PALETTE.contextYellow,
    haiku: PALETTE.tierHaiku,
    fable: PALETTE.contextOrange
};
const UNKNOWN_TIER = "unknown";
const TIER_ORDER = [...Object.keys(TIER_COLORS), UNKNOWN_TIER];

const TERMINAL_STATUSES = ["completed", "failed", "killed"];

/** One task from the payload, every field already flattened to a string. */
export interface TaskFields {
    id: string;
    model: string;
    status: string;
    startTime: string;
    tokenCount: string;
}

/** Normalizes either an alias ("sonnet") or a full id ("claude-sonnet-5.5"). */
function modelTier(model: string): string {
    return Object.keys(TIER_COLORS).find((tier) => model.includes(tier)) ?? UNKNOWN_TIER;
}

/** `95000` -> `1m35s`. Whole seconds, matching the clock the panel ticks on. */
export function formatDuration(milliseconds: number): string {
    const totalSeconds = Math.max(0, Math.trunc(milliseconds / 1000));
    if (totalSeconds < 60) {
        return `${totalSeconds}s`;
    }
    if (totalSeconds < 3600) {
        return `${Math.trunc(totalSeconds / 60)}m${String(totalSeconds % 60).padStart(2, "0")}s`;
    }
    const minutes = Math.trunc((totalSeconds % 3600) / 60);
    return `${Math.trunc(totalSeconds / 3600)}h${String(minutes).padStart(2, "0")}m`;
}

/**
 * 25032 -> 25.0k ; below 1000 stays exact. Integer arithmetic on purpose: 25032
 * rounds to 25082, whose hundreds digit is 0, so it reads 25.0k rather than the
 * 25.1k a float divide would give.
 */
export function formatTokens(value: number): string {
    if (isNonNegativeInt(value) && value >= 1000) {
        const rounded = value + 50;
        return `${Math.trunc(rounded / 1000)}.${Math.trunc((rounded % 1000) / 100)}k`;
    }
    return String(value);
}

/** `● 3 running · 1×Opus 2×Sonnet · 412.3k tokens · 4m12s`, or "" when none run. */
export function buildRunningSummary(running: readonly TaskFields[], nowMs: number): string {
    if (running.length === 0) return "";
    const tierCounts = new Map<string, number>();
    for (const task of running) {
        const tier = modelTier(task.model);
        tierCounts.set(tier, (tierCounts.get(tier) ?? 0) + 1);
    }
    const tiers = [...tierCounts]
        .sort(([left], [right]) => TIER_ORDER.indexOf(left) - TIER_ORDER.indexOf(right))
        .map(([tier, count]) => `${TIER_COLORS[tier] ?? GRAY}${count}×${tier[0]!.toUpperCase()}${tier.slice(1)}${RESET}`)
        .join(" ");
    const tokens = running.reduce((sum, task) => sum + Math.trunc(Number.parseFloat(task.tokenCount) || 0), 0);
    const longest = Math.max(
        ...running.map((task) => {
            const startTime = toNonNegativeInt(task.startTime, 0);
            return startTime > 0 ? nowMs - startTime : 0;
        })
    );
    return (
        `${RUNNING_GLYPH} ${running.length} running` +
        ` ${DIM}·${RESET} ${tiers}` +
        ` ${DIM}· ${formatTokens(tokens)} tokens · ${formatDuration(longest)}${RESET}`
    );
}

/** jq's `//` then `tostring`: null and false fall through, non-strings render as JSON. */
function orDefault(value: unknown, fallback: string): string {
    if (value === null || value === undefined || value === false) return fallback;
    return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}

export function extractTasks(payload: unknown): TaskFields[] {
    const tasks = (payload as { tasks?: unknown })?.tasks;
    if (!Array.isArray(tasks)) return [];
    return tasks.map((raw) => {
        const task = (raw ?? {}) as Record<string, unknown>;
        return {
            id: orDefault(task.id, ""),
            model: orDefault(task.model, ""),
            status: orDefault(task.status, ""),
            startTime: orDefault(task.startTime, "0"),
            tokenCount: orDefault(task.tokenCount, "0")
        };
    });
}

function main(): void {
    const input = readStdin();

    // Raw-payload capture, gated on a marker file rather than an env var: the
    // panel runs this from inside Claude Code, so there is no shell in which to
    // export one. `touch ~/.claude/subagent-statusline-debug` to record, delete
    // it to stop.
    if (existsSync(`${CONFIG_DIR}/subagent-statusline-debug`)) {
        try {
            appendFileSync(`${CONFIG_DIR}/subagent-statusline-debug.jsonl`, `${input.replace(/\n+$/, "")}\n`);
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

    const tasks = extractTasks(payload).filter((task) => task.id !== "");
    if (tasks.length === 0) return;

    // Second granularity: elapsed time is rendered in whole seconds, so a
    // millisecond clock would only add render churn.
    const nowMs = Math.floor(Date.now() / 1000) * 1000;
    const running = tasks.filter((task) => !TERMINAL_STATUSES.includes(task.status));
    const summaryId = running[0]?.id;
    const summary = buildRunningSummary(running, nowMs);
    process.stdout.write(
        tasks.map((task) => `${JSON.stringify({ id: task.id, content: task.id === summaryId ? summary : "" })}\n`).join("")
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

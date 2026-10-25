// Session-wide sub-agent history, shared by both status-line renderers.
//
// The tasks panel only ever renders agents Claude Code still has in its payload,
// and it evicts a terminal task 30s after it finishes — so the panel is a live
// view, never a ledger. The main bar wants the opposite: what ran, in total,
// long after the last agent is gone. Both read the same file.
//
//   ~/.claude/subagent-statusline-state/<session>.tsv
//       written by subagent-status-line.mts on every tick, one row per agent:
//       id, tier, effort, tokens, elapsed, status. Terminal rows freeze, so a
//       finished agent's numbers are final. It is complete, because the panel
//       ticks continuously for as long as any agent is running.

import { readFileSync } from "node:fs";

import { isSafeStatusIdentifier } from "./compaction.mts";
import { isNonNegativeInt } from "./statusline-ansi.mts";
import { loadPalette } from "./terminal-theme.mts";

const PALETTE = loadPalette();

/**
 * Model tier colors. Shared with the effort scale where the hue means the same
 * thing, so the two columns read as one palette rather than two. Declaration
 * order is also the order every tally groups tiers in.
 */
export const TIER_COLORS: Readonly<Record<string, string>> = {
    opus: PALETTE.accent, // blue
    sonnet: PALETTE.contextYellow, // yellow
    haiku: PALETTE.tierHaiku, // pink
    fable: PALETTE.contextOrange // orange
};

export const UNKNOWN_TIER = "unknown";
export const TIER_ORDER = [...Object.keys(TIER_COLORS), UNKNOWN_TIER];

const TERMINAL_STATUSES = ["completed", "failed", "killed"];

export function isTerminalStatus(status: string): boolean {
    return TERMINAL_STATUSES.includes(status);
}

export interface StatusStyle {
    glyph: string;
    color: string;
}

/**
 * The status column, shared so a finished agent looks the same on the live panel
 * and in the main bar's ledger.
 *
 * Glyphs are constrained to what Cascadia Mono (Windows Terminal's default face)
 * actually carries. `✗ U+2717` was not one of them: it font-fell-back to Segoe UI
 * Emoji, which drew double-width into this one-cell column and smeared over the
 * model beside it, so `× U+00D7` replaces it. `✓ U+2713` does render in Cascadia
 * and stays — it is the clearest "completed" mark and this column is too narrow
 * for words. Consolas lacks it, so a face change there would need the same
 * treatment.
 */
export const STATUS_STYLES: Readonly<Record<string, StatusStyle>> = {
    running: { glyph: "●", color: PALETTE.effortBudget }, // cyan
    completed: { glyph: "✓", color: PALETTE.add }, // green
    failed: { glyph: "×", color: PALETTE.contextRed }, // red
    killed: { glyph: "×", color: PALETTE.contextRed }
};
export const UNKNOWN_STATUS_STYLE: StatusStyle = { glyph: "○", color: PALETTE.gray };

export function statusStyle(status: string): StatusStyle {
    return STATUS_STYLES[status] ?? UNKNOWN_STATUS_STYLE;
}

/** `95000` -> `1m35s`. Whole seconds, matching the clock both renderers tick on. */
export function formatDuration(milliseconds: number): string {
    let totalSeconds = Math.trunc(milliseconds / 1000);
    if (totalSeconds < 0) {
        totalSeconds = 0;
    }
    if (totalSeconds < 60) {
        return `${totalSeconds}s`;
    }
    if (totalSeconds < 3600) {
        const seconds = totalSeconds % 60;
        return `${Math.trunc(totalSeconds / 60)}m${String(seconds).padStart(2, "0")}s`;
    }
    const minutes = Math.trunc((totalSeconds % 3600) / 60);
    return `${Math.trunc(totalSeconds / 3600)}h${String(minutes).padStart(2, "0")}m`;
}

/** Normalizes either an alias ("sonnet") or a full id ("claude-sonnet-5.5"). */
export function modelTier(model: string): string {
    return Object.keys(TIER_COLORS).find((tier) => model.includes(tier)) ?? "";
}

/**
 * 25032 -> 25.0k ; below 1000 stays exact.
 *
 * The integer arithmetic is the point, not an approximation of a rounded
 * divide: 25032 rounds to 25082, whose thousands digit is 25 and whose hundreds
 * digit is 0, so the tenth reads 0 rather than the 25.1k a float would give.
 */
export function formatTokens(value: string | number): string {
    if (isNonNegativeInt(value) && Number(value) >= 1000) {
        const rounded = Number(value) + 50;
        return `${Math.trunc(rounded / 1000)}.${Math.trunc((rounded % 1000) / 100)}k`;
    }
    const text = String(value);
    return text === "" ? "0" : text;
}

// --- Session state file --------------------------------------------------------

/** One line of the session state file, tab-delimited on disk. */
export interface StateRecord {
    id: string;
    tier: string;
    effort: string;
    tokens: string;
    elapsedMs: string;
    status: string;
}

export function serializeRecord(record: StateRecord): string {
    return [record.id, record.tier, record.effort, record.tokens, record.elapsedMs, record.status].join("\t");
}

export function parseRecord(line: string): StateRecord {
    const fields = line.split("\t");
    return {
        id: fields[0] ?? "",
        tier: fields[1] ?? "",
        effort: fields[2] ?? "",
        tokens: fields[3] ?? "",
        elapsedMs: fields[4] ?? "",
        status: fields[5] ?? ""
    };
}

export function sessionStateDir(configDir: string): string {
    return `${configDir}/subagent-statusline-state`;
}

export function sessionStateFile(configDir: string, sessionId: string): string {
    return isSafeStatusIdentifier(sessionId) ? `${sessionStateDir(configDir)}/${sessionId}.tsv` : "";
}

/** Every agent this session has spawned, in spawn order. `[]` when none have. */
export function readSessionRecords(stateFile: string): StateRecord[] {
    try {
        return readFileSync(stateFile, "utf8")
            .split("\n")
            .filter((line) => line !== "")
            .map(parseRecord)
            .filter((record) => record.id !== "");
    } catch {
        return [];
    }
}

// --- Grouping ------------------------------------------------------------------

/**
 * Model class is selected intentionally at the call site or in agent frontmatter;
 * the task payload has no information about whether a frontier selection was the
 * exceptional manual escalation the policy recommends. Do not infer a violation
 * from a resolved tier alone.
 *
 * The effort rules live with the tasks panel instead, because they only apply to
 * a *declared* level and the state file records the resolved one — an inherited
 * level is the session's own setting, so flagging it here would accuse an agent
 * of a choice it never made.
 */
export function tierDriftReasons(_tier: string): string[] {
    return [];
}

export interface CountedGroup {
    label: string;
    count: number;
    /** Every member's tokens, summed. */
    tokens: number;
    /** At least one member broke a tier rule — see `tierDriftReasons`. */
    drifted: boolean;
}

/** One agent, seen through the label being tallied. */
export interface GroupMember {
    label: string;
    tokens: number;
    drifted: boolean;
}

/**
 * `2×Explore`, not `Explore 2`. One multiplication idiom carries every count on
 * both renderers — tiers, effort levels and agent types alike — so a number in
 * front of a name always means the same thing wherever it appears.
 */
export function countLabel(count: number, name: string): string {
    return `${count}×${name}`;
}

/** Tally names are capitalized (`Opus`); agent types keep their real spelling. */
export function capitalize(text: string): string {
    return text === "" ? "" : text[0]!.toUpperCase() + text.slice(1);
}

/** Tallies members by label, in first-seen order. Unlabelled members are skipped. */
export function groupMembers(members: readonly GroupMember[]): CountedGroup[] {
    const groups = new Map<string, CountedGroup>();
    for (const member of members) {
        if (member.label === "") {
            continue;
        }
        const existing = groups.get(member.label);
        if (existing === undefined) {
            groups.set(member.label, {
                label: member.label,
                count: 1,
                tokens: member.tokens,
                drifted: member.drifted
            });
            continue;
        }
        existing.count += 1;
        existing.tokens += member.tokens;
        existing.drifted ||= member.drifted;
    }
    return [...groups.values()];
}

/**
 * Groups in `order` first, then anything unranked in first-seen order — an
 * unrecognized tier or effort level is an anomaly worth reading rather than
 * dropping.
 */
export function groupByOrder(members: readonly GroupMember[], order: readonly string[]): CountedGroup[] {
    const rank = (label: string): number => {
        const index = order.indexOf(label);
        return index === -1 ? order.length : index;
    };
    // Array.sort is stable, so unranked groups keep the order they were seen in.
    return groupMembers(members).sort((left, right) => rank(left.label) - rank(right.label));
}

export interface SubagentSummary {
    /** Finished agents only — the running ones are the tasks panel's job. */
    agents: number;
    /** Tiers in `TIER_ORDER`, each carrying its own share of the tokens. */
    tiers: CountedGroup[];
}

/**
 * The main bar's view of the session: what has finished. Running agents are
 * excluded on purpose — the tasks panel renders directly beneath the main bar
 * for as long as any agent is alive, and showing the same agent in both places
 * would say the same thing twice while it runs and nothing at all afterwards.
 */
export function summarizeFinishedAgents(records: StateRecord[]): SubagentSummary {
    const members = records
        .filter((record) => isTerminalStatus(record.status))
        .map((record) => ({
            label: record.tier,
            tokens: Math.trunc(Number.parseFloat(record.tokens) || 0),
            drifted: tierDriftReasons(record.tier).length > 0
        }));
    return { agents: members.length, tiers: groupByOrder(members, TIER_ORDER) };
}

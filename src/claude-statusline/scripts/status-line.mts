#!/usr/bin/env node
// Claude Code `statusLine` renderer: one JSON object on stdin, three rows of
// status text on stdout. It is re-run on every render tick and Claude Code
// cancels a status line that blocks, so the render path is one git call plus
// cache reads, with no network and no background processes.
//
//   P · session name · #6fdaff6d · project/worktree
//   Opus 5 (1M) · ◆◆◆◇◇ · 84k ████░░ · 󰘕 3
//   5h ██░░ 37% 2h · 7d ████ 62% 3d

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    BOLD,
    RESET,
    cacheKey,
    effortGauge,
    isNonNegativeInt,
    readFileOrEmpty,
    readStdin,
    toNonNegativeInt,
    visibleWidth
} from "./lib/statusline-ansi.mts";
import { loadPalette } from "./lib/terminal-theme.mts";
import { autoCompactLimit, readCompactionHistory } from "./lib/compaction.mts";

// --- Theme -------------------------------------------------------------------

/** Colors derive from the terminal's own scheme; see lib/terminal-theme.mts. */
const PALETTE = loadPalette();

const GRAY = PALETTE.gray;
const DIM = PALETTE.dim;
const ACCENT = PALETTE.accent;
const BAR_EMPTY = PALETTE.barEmpty;
/** Brightest foreground, spent only on the folder that answers "where am I". */
const WHITE = PALETTE.white;
/** A state the user has to act on: quota data too old to trust. */
const WARN = PALETTE.warn;
const CONTEXT_YELLOW = PALETTE.contextYellow;
const CONTEXT_ORANGE = PALETTE.contextOrange;
const CONTEXT_RED = PALETTE.contextRed;
/** The session name is the row's title, so it alone carries weight as well as hue. */
const SESSION = `${BOLD}${PALETTE.session}`;

// --- Glyph vocabulary --------------------------------------------------------

// Windows Terminal draws this bar with `Cascadia Mono, Symbols Nerd Font`, and
// Orca with Cascadia Mono. Every glyph must be in plain Cascadia Mono's cmap
// (◆ ◇ █ ░ ● ·) or be a Nerd Font Private Use Area icon; anything else falls
// back to Segoe UI Emoji, which draws double-width over its neighbour. That is
// why ⟳ ↻ ✎ ⊘ ⇅ ✗ ✔ are never used. Probe a new glyph's cmap before adding it.

/** Nerd Font `md-arrow_collapse_vertical` (U+F0615): the compaction counter. */
const COMPACTION_ICON = "󰘕";

const CONTEXT_BAR_CELLS = 6;
const QUOTA_BAR_CELLS = 4;
const LOCATION_LABEL_WIDTH = 20;
const ELLIPSIS = "…";

/**
 * "Opus 5 (1M context)" -> "Opus 5 (1M)". The payload's display_name spells the
 * enlarged window out in words; the number alone says the same thing.
 */
export function trimModelName(model: string): string {
    return model.replace(/\((\d+[KMG]?) context\)/i, "($1)");
}

/** The one field separator on every row. U+00B7 renders in Cascadia Mono and Consolas. */
export const SEPARATOR = ` ${GRAY}·${RESET} `;

/** Joins pre-colored segments, dropping the empty ones so no separator dangles. */
function joinSegments(segments: string[]): string {
    return segments.filter((segment) => segment !== "").join(SEPARATOR);
}

/**
 * OSC-8 hyperlink, terminated with BEL rather than the usual `ESC \`. Every line
 * is emitted through `expandBackslashEscapes`, which would pair that trailing
 * backslash with the first character of the label: a directory named `trace`
 * would render as a tab followed by `race`, and one named `code` would truncate
 * the whole line at `\c`. BEL contains no backslash, so no label can collide.
 */
export function hyperlink(url: string, label: string): string {
    return `\x1b]8;;${url}\x07${label}\x1b]8;;\x07`;
}

/** A link when the URL could be built, the bare label when it could not. */
function maybeLink(url: string, label: string): string {
    return url === "" ? label : hyperlink(url, label);
}

/**
 * `file:` URL for an absolute path, no trailing slash.
 *
 * Windows Terminal opens a hyperlink only when its scheme is http, https or file
 * (`TerminalPage::_IsUriSupported`); anything else raises a dialog instead of
 * reaching the registered handler. So file is the only scheme worth emitting.
 * Backslashes are not legal in a URL path, and `#`/`?` would start a fragment or
 * a query — `encodeURI` leaves both alone, hence the explicit replacements.
 */
export function toFileUrl(absolutePath: string): string {
    const forwardSlashed = absolutePath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
    return `file:///${encodeURI(forwardSlashed).replace(/#/g, "%23").replace(/\?/g, "%3F")}`;
}

// --- Cache layout ------------------------------------------------------------

const CACHE_DIR = tmpdir();

/**
 * ASCII Unit Separator. The quota cache is delimited with it so a field that
 * happens to contain a tab or a space can never shift a column.
 */
const UNIT_SEPARATOR = "\x1f";

const USAGE_STALE_SECONDS = 900; // 15 min: cached quota older than this gets a muted age note
const USAGE_WARN_SECONDS = 1800; // 30 min: older than this is flagged coral (genuinely outdated)

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || "";

function resolveConfigDir(): string {
    return process.env.CLAUDE_CONFIG_DIR || `${HOME_DIR}/.claude`;
}

/**
 * `autoCompactWindow` from settings.json — the window auto-compaction measures
 * against, which for a 1M model is the only number that governs anything. Absent
 * or malformed falls back to 0, which leaves the model's own window in charge.
 */
function readAutoCompactWindow(configDir: string): number {
    try {
        const settings = JSON.parse(readFileOrEmpty(path.join(configDir, "settings.json"))) as {
            autoCompactWindow?: unknown;
        };
        return toNonNegativeInt(settings.autoCompactWindow, 0);
    } catch {
        return 0;
    }
}

export type AccountLabel = "Work" | "Personal";

export function resolveAccountLabel(configDir: string): AccountLabel {
    const selectedAccount = process.env.MPX_ACCOUNT?.toLowerCase();
    if (selectedAccount === "work") return "Work";
    if (selectedAccount === "personal") return "Personal";
    return configDir.includes("claude-work") ? "Work" : "Personal";
}

/**
 * Quota cache keyed by account, NOT by config-dir path — the path arrives in two
 * forms (C:\Users\... vs /c/Users/...) which used to split one account across
 * two caches.
 */
function usageCachePath(account: AccountLabel): string {
    return path.join(CACHE_DIR, `claude-usage-${account}.tsv`);
}

// --- Small filesystem/format primitives --------------------------------------

function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
}

function mtimeSeconds(file: string): number | undefined {
    try {
        return Math.floor(statSync(file).mtimeMs / 1000);
    } catch {
        return undefined;
    }
}

/**
 * Splits one cache line into exactly `count` fields. The final field absorbs any
 * remaining separators, and missing fields come back as empty strings.
 */
export function readFields(line: string, count: number): string[] {
    const parts = line.split(UNIT_SEPARATOR);
    if (parts.length > count) {
        return [...parts.slice(0, count - 1), parts.slice(count - 1).join(UNIT_SEPARATOR)];
    }
    while (parts.length < count) {
        parts.push("");
    }
    return parts;
}

/** Leading-numeric prefix parse, matching the string-to-number coercion in awk/printf. */
export function numericPrefix(value: string): number {
    const match = /^[ \t]*[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(value);
    return match ? Number(match[0]) : 0;
}

function incrementDecimalDigits(digits: string): string {
    const out = digits.split("");
    for (let i = out.length - 1; i >= 0; i--) {
        if (out[i] === "9") {
            out[i] = "0";
        } else {
            out[i] = String(Number(out[i]) + 1);
            return out.join("");
        }
    }
    return `1${out.join("")}`;
}

/**
 * C `printf("%.*f")`. It differs from `toFixed` on exact ties: libc rounds half
 * to even (0.5 -> "0", 1.5 -> "2", 2.5 -> "2") while `toFixed` always rounds up.
 */
export function formatFixed(value: number, decimals: number): string {
    if (!Number.isFinite(value)) {
        return Number.isNaN(value) ? "nan" : value > 0 ? "inf" : "-inf";
    }
    const negative = value < 0 || Object.is(value, -0);
    const magnitude = Math.abs(value);

    // Enough extra digits to tell an exact tie (which terminates) from a double
    // that merely rounds to one; a tie shows only zeros past this point.
    const guardDigits = Math.min(100, decimals + 40);
    const [integerPart = "0", fractionPart = ""] = magnitude.toFixed(guardDigits).split(".");
    const kept = fractionPart.slice(0, decimals).padEnd(decimals, "0");
    const rest = fractionPart.slice(decimals);

    let roundUp = false;
    if (rest.length > 0) {
        const first = rest[0]!;
        if (first > "5") {
            roundUp = true;
        } else if (first === "5") {
            const lastKeptDigit = decimals > 0 ? kept[decimals - 1]! : integerPart[integerPart.length - 1]!;
            roundUp = /[1-9]/.test(rest.slice(1)) || Number(lastKeptDigit) % 2 === 1;
        }
    }

    let digits = integerPart + kept;
    if (roundUp) {
        digits = incrementDecimalDigits(digits);
    }

    const whole = decimals > 0 ? digits.slice(0, digits.length - decimals) : digits;
    const fraction = decimals > 0 ? digits.slice(digits.length - decimals) : "";
    const rendered = decimals > 0 ? `${whole}.${fraction}` : whole;
    // libc keeps the sign even when every rendered digit rounded to zero ("-0").
    return negative ? `-${rendered}` : rendered;
}

/** `printf '%.0f'` over a raw stdin field; empty for absent values. */
export function formatPct(raw: string): string {
    if (raw === "" || raw === "null") {
        return "";
    }
    return formatFixed(numericPrefix(raw), 0);
}

/**
 * `basename`, splitting on both separators so a `C:\...\repo` cwd still yields
 * `repo` and git's forward-slashed paths do too.
 */
export function basename(input: string): string {
    if (input === "") {
        return "";
    }
    const trimmed = input.replace(/[/\\]+$/, "");
    if (trimmed === "") {
        return input[0] === "/" ? "/" : "\\";
    }
    const lastSeparator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    return lastSeparator === -1 ? trimmed : trimmed.slice(lastSeparator + 1);
}

const BACKSLASH_ESCAPES: Record<string, string> = {
    a: "\x07",
    b: "\b",
    e: "\x1b",
    E: "\x1b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    "\\": "\\"
};

/**
 * The bash renderer emitted every line through `printf '%b'`, which expands
 * backslash escapes in the *data* too — a session name containing `\t` really
 * did render as a tab. Reproduced so no payload can diverge. `\c` truncates the
 * rest of the output, newline included.
 */
export function expandBackslashEscapes(input: string): { text: string; truncated: boolean } {
    if (!input.includes("\\")) {
        return { text: input, truncated: false };
    }
    let out = "";
    let i = 0;
    while (i < input.length) {
        const char = input[i]!;
        if (char !== "\\" || i + 1 >= input.length) {
            out += char;
            i++;
            continue;
        }
        const next = input[i + 1]!;
        if (next === "c") {
            return { text: out, truncated: true };
        }
        const simple = BACKSLASH_ESCAPES[next];
        if (simple !== undefined) {
            out += simple;
            i += 2;
            continue;
        }
        if (/[0-7]/.test(next)) {
            const start = next === "0" ? i + 2 : i + 1;
            const octal = /^[0-7]{1,3}/.exec(input.slice(start))?.[0] ?? "";
            out += String.fromCharCode(octal === "" ? 0 : parseInt(octal, 8));
            i = start + octal.length;
            continue;
        }
        const hexMatch = next === "x" ? /^[0-9a-fA-F]{1,2}/.exec(input.slice(i + 2)) : null;
        if (hexMatch) {
            out += String.fromCharCode(parseInt(hexMatch[0], 16));
            i += 2 + hexMatch[0].length;
            continue;
        }
        const unicodeWidth = next === "u" ? 4 : next === "U" ? 8 : 0;
        const unicodeMatch = unicodeWidth
            ? new RegExp(`^[0-9a-fA-F]{1,${unicodeWidth}}`).exec(input.slice(i + 2))
            : null;
        if (unicodeMatch) {
            out += String.fromCodePoint(parseInt(unicodeMatch[0], 16));
            i += 2 + unicodeMatch[0].length;
            continue;
        }
        out += char + next;
        i += 2;
    }
    return { text: out, truncated: false };
}

// --- Display helpers ---------------------------------------------------------

/**
 * `color` defaults to ACCENT for the quota bars, whose hue means nothing beyond
 * "this is a bar". The context bar passes its own escalating color instead, so
 * the bar and the token count beside it always agree.
 */
export function progressBar(pct: number, width: number, color: string = ACCENT): string {
    const filled = Math.trunc((pct * width) / 100);
    let out = "";
    for (let i = 0; i < width; i++) {
        out += i < filled ? `${color}█${RESET}` : `${BAR_EMPTY}░${RESET}`;
    }
    return out;
}

/**
 * Accepts either a Unix epoch (stdin `rate_limits.*.resets_at`) or an ISO-8601
 * string. Renders the largest whole unit — "3d", "2h", "45m" — or nothing once
 * the reset is in the past.
 */
export function timeUntil(value: string, now: number = nowSeconds()): string {
    if (value === "" || value === "null") {
        return "";
    }
    let resetEpoch: number;
    if (/^[0-9]+(\.[0-9]+)?$/.test(value)) {
        resetEpoch = Number(value.replace(/\.[^.]*$/, ""));
    } else {
        const parsed = Date.parse(value);
        if (Number.isNaN(parsed)) {
            return "";
        }
        resetEpoch = Math.floor(parsed / 1000);
    }
    const diff = resetEpoch - now;
    if (diff <= 0) {
        return "";
    }
    return humanAge(diff);
}

/** Compact age like "2d", "2h", "7m", "45s". */
export function humanAge(seconds: number | string): string {
    if (!isNonNegativeInt(seconds)) {
        return "?";
    }
    const value = Number(seconds);
    if (value >= 86400) {
        return `${Math.trunc(value / 86400)}d`;
    }
    if (value >= 3600) {
        return `${Math.trunc(value / 3600)}h`;
    }
    if (value >= 60) {
        return `${Math.trunc(value / 60)}m`;
    }
    return `${value}s`;
}

function truncateDisplayLabel(label: string, maximumWidth: number): string {
    if (visibleWidth(label) <= maximumWidth) {
        return label;
    }
    const contentWidth = maximumWidth - visibleWidth(ELLIPSIS);
    let truncated = "";
    for (const character of label) {
        if (visibleWidth(truncated + character) > contentWidth) {
            break;
        }
        truncated += character;
    }
    return `${truncated}${ELLIPSIS}`;
}

// --- stdin payload -----------------------------------------------------------

export interface PayloadFields {
    sessionName: string;
    sessionId: string;
    model: string;
    cwd: string;
    transcriptPath: string;
    maxContext: string;
    sessionTokensIn: string;
    effortLevel: string;
    fiveRaw: string;
    fiveResets: string;
    sevenRaw: string;
    sevenResets: string;
}

function lookup(root: unknown, keys: string[]): unknown {
    let current = root;
    for (const key of keys) {
        if (current === null || typeof current !== "object") {
            return undefined;
        }
        current = (current as Record<string, unknown>)[key];
    }
    return current;
}

/** jq's `//` operator: null and false count as absent, 0 and "" do not. */
function alternative(value: unknown, fallback: unknown): unknown {
    return value === null || value === undefined || value === false ? fallback : value;
}

function toDisplayString(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    return (JSON.stringify(value) ?? "").replace(/[\n\r]/g, " ");
}

function field(root: unknown, keys: string[], fallback: unknown = ""): string {
    return toDisplayString(alternative(lookup(root, keys), fallback)).replace(/[\n\r]/g, " ");
}

export function extractPayloadFields(input: string): PayloadFields {
    let root: unknown;
    try {
        root = JSON.parse(input);
    } catch {
        root = undefined;
    }
    const model = alternative(lookup(root, ["model", "display_name"]), alternative(lookup(root, ["model", "id"]), "?"));
    return {
        sessionName: field(root, ["session_name"]),
        sessionId: field(root, ["session_id"]),
        model: toDisplayString(model).replace(/[\n\r]/g, " ") || "?",
        cwd: field(root, ["cwd"]),
        transcriptPath: field(root, ["transcript_path"]),
        maxContext: field(root, ["context_window", "context_window_size"], 200000),
        sessionTokensIn: field(root, ["context_window", "total_input_tokens"]),
        effortLevel: field(root, ["effort", "level"]),
        fiveRaw: field(root, ["rate_limits", "five_hour", "used_percentage"]),
        fiveResets: field(root, ["rate_limits", "five_hour", "resets_at"]),
        sevenRaw: field(root, ["rate_limits", "seven_day", "used_percentage"]),
        sevenResets: field(root, ["rate_limits", "seven_day", "resets_at"])
    };
}

// --- Location ----------------------------------------------------------------

export interface WorktreePaths {
    commonDir: string;
    toplevel: string;
}

/** The two lines `git rev-parse --git-common-dir --show-toplevel` prints, in order. */
export function parseWorktreePaths(output: string): WorktreePaths | undefined {
    const [commonDir = "", toplevel = ""] = output.split("\n").map((line) => line.trim());
    return commonDir === "" || toplevel === "" ? undefined : { commonDir, toplevel };
}

/** Case- and separator-insensitive path equality, because git mixes `/` into Windows paths. */
function samePath(a: string, b: string): boolean {
    const normalize = (value: string) => path.resolve(value).replace(/\\/g, "/").toLowerCase();
    return normalize(a) === normalize(b);
}

export interface ProjectLocation {
    /** Main project folder name, or the cwd's folder outside a linked worktree. */
    projectName: string;
    /** Linked worktree folder name; "" in the main checkout or outside git. */
    worktreeName: string;
    /** Folder the label opens: the worktree, or the cwd. */
    folderUrl: string;
}

/**
 * In a linked worktree the shared `.git` lives under the *main* checkout, so
 * `dirname(--git-common-dir)` names the original project while `--show-toplevel`
 * is the worktree. Anywhere else the location is just the cwd.
 */
export function resolveProjectLocation(cwd: string, worktree: WorktreePaths | undefined): ProjectLocation {
    const plain: ProjectLocation = {
        projectName: basename(cwd),
        worktreeName: "",
        folderUrl: cwd === "" ? "" : toFileUrl(cwd)
    };
    if (worktree === undefined) {
        return plain;
    }
    const mainProjectDir = path.dirname(worktree.commonDir);
    if (samePath(mainProjectDir, worktree.toplevel)) {
        return plain;
    }
    return {
        projectName: basename(mainProjectDir),
        worktreeName: basename(worktree.toplevel),
        folderUrl: toFileUrl(worktree.toplevel)
    };
}

/**
 * The render's only git call. Refs and config only, so it never waits on the
 * network; stderr is discarded so a non-repo cwd cannot leak into the bar.
 */
function readWorktreePaths(cwd: string): WorktreePaths | undefined {
    try {
        if (cwd === "" || !statSync(cwd).isDirectory()) {
            return undefined;
        }
        const output = execFileSync(
            "git",
            ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"],
            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }
        );
        return parseWorktreePaths(output);
    } catch {
        return undefined;
    }
}

/**
 * `project/worktree`, or just the folder. The worktree half takes WHITE because
 * it, not the project, answers "where am I"; it is capped by rendered cells.
 */
export function buildLocationLabel(location: ProjectLocation): string {
    if (location.projectName === "") {
        return "";
    }
    const label =
        location.worktreeName === ""
            ? `${WHITE}${location.projectName}`
            : `${GRAY}${location.projectName}/${WHITE}${truncateDisplayLabel(location.worktreeName, LOCATION_LABEL_WIDTH)}`;
    return `${maybeLink(location.folderUrl, label)}${RESET}`;
}

// --- Row builders ------------------------------------------------------------

export interface SessionLineInput {
    /** Pre-colored `P`/`W` badge, or "" to omit; it never renders alone. */
    accountMarker: string;
    sessionName: string;
    shortId: string;
    /** `file:` URL of the transcript `.jsonl`; "" leaves the id unlinked. */
    transcriptUrl: string;
    locationLabel: string;
}

/** Account · title · id · where: identity of the session in one row. */
export function buildSessionLine(input: SessionLineInput): string {
    const body = joinSegments([
        input.sessionName === "" ? "" : `${SESSION}${input.sessionName}${RESET}`,
        input.shortId === "" ? "" : `${GRAY}${maybeLink(input.transcriptUrl, `#${input.shortId}`)}${RESET}`,
        input.locationLabel
    ]);
    if (body === "" || input.accountMarker === "") {
        return body;
    }
    return `${input.accountMarker}${SEPARATOR}${body}`;
}

/**
 * Context escalation, as a fraction of the auto-compaction limit: at the default
 * 200,000-token window the cut-offs land on 100k/140k/180k, and they follow
 * `autoCompactWindow` when it is raised.
 */
const CONTEXT_YELLOW_FRACTION = 0.5;
const CONTEXT_ORANGE_FRACTION = 0.7;
const CONTEXT_RED_FRACTION = 0.9;

export interface ModelLineInput {
    model: string;
    effortLevel: string;
    sessionTokensIn: string;
    /** Tokens at which auto-compaction fires; 0 renders no bar. */
    compactLimit: number;
    compactionCount: number;
}

/**
 * Model · effort · context · compactions. The context bar measures against the
 * auto-compaction limit, not the model window: a full bar means compaction is
 * about to fire, which is the only threshold anyone acts on.
 */
export function buildModelLine(input: ModelLineInput): string {
    const tokens = isNonNegativeInt(input.sessionTokensIn) ? Number(input.sessionTokensIn) : undefined;
    let context = "";
    if (tokens !== undefined) {
        const scale = input.compactLimit > 0 ? input.compactLimit : 200000;
        let color = GRAY;
        if (tokens >= scale * CONTEXT_RED_FRACTION) {
            color = CONTEXT_RED;
        } else if (tokens >= scale * CONTEXT_ORANGE_FRACTION) {
            color = CONTEXT_ORANGE;
        } else if (tokens >= scale * CONTEXT_YELLOW_FRACTION) {
            color = CONTEXT_YELLOW;
        }
        context = `${color}${Math.trunc((tokens + 500) / 1000)}k${RESET}`;
        if (input.compactLimit > 0) {
            const pct = Math.min(100, Math.trunc((tokens * 100) / input.compactLimit));
            context += ` ${progressBar(pct, CONTEXT_BAR_CELLS, color)}`;
        }
    }
    return joinSegments([
        `${ACCENT}${trimModelName(input.model)}${RESET}`,
        input.effortLevel === "" ? "" : `${GRAY}${effortGauge(input.effortLevel)}${RESET}`,
        context,
        input.compactionCount > 0 ? `${GRAY}${COMPACTION_ICON} ${input.compactionCount}${RESET}` : ""
    ]);
}

export interface QuotaInput {
    fiveRaw: string;
    fiveResets: string;
    sevenRaw: string;
    sevenResets: string;
    /** Staleness applies only to the cache path; live stdin data is always current. */
    usageSource: "live" | "cache" | "";
    usageAgeSeconds: number;
    now?: number;
}

/** Where the `5h`/`7d` labels lead: the account's usage page on claude.ai. */
const USAGE_DASHBOARD_URL = "https://claude.ai/settings/usage";

export function buildQuotaLine(input: QuotaInput): string {
    const now = input.now ?? nowSeconds();
    const isCache = input.usageSource === "cache" && isNonNegativeInt(input.usageAgeSeconds);
    const isStale = isCache && input.usageAgeSeconds > USAGE_STALE_SECONDS;
    const isOld = isCache && input.usageAgeSeconds > USAGE_WARN_SECONDS;

    const percentOrUndefined = (raw: string): number | undefined => {
        const pct = formatPct(raw);
        return pct !== "" && isNonNegativeInt(pct) ? Math.min(100, Number(pct)) : undefined;
    };
    const five = percentOrUndefined(input.fiveRaw);
    const seven = percentOrUndefined(input.sevenRaw);
    if (five === undefined && seven === undefined) {
        return `${DIM}quota unknown${RESET}`;
    }

    const label = isOld ? WARN : GRAY;
    const text = isOld ? WARN : "";

    // The countdown stays DIM even when the row is coral: when the window
    // reopens never asks anything of you.
    const window = (name: string, pct: number, resets: string): string => {
        const segment = `${label}${hyperlink(USAGE_DASHBOARD_URL, name)} ${progressBar(pct, QUOTA_BAR_CELLS)}${text} ${pct}%`;
        const countdown = timeUntil(resets, now);
        return countdown === "" ? segment : `${segment} ${DIM}${countdown}${RESET}`;
    };

    // Plans without a 5-hour window report only the weekly one.
    const windows = [
        five === undefined ? "" : window("5h", five, input.fiveResets),
        seven === undefined ? "" : window("7d", seven, input.sevenResets)
    ].filter((segment) => segment !== "");
    let line = (isOld ? `${WARN}⚠ ` : "") + windows.join(SEPARATOR);

    if (isOld) {
        line += `${SEPARATOR}${WARN}${humanAge(input.usageAgeSeconds)} old ⚠${RESET}`;
    } else if (isStale) {
        line += `${SEPARATOR}${DIM}${humanAge(input.usageAgeSeconds)}${RESET}`;
    } else {
        line += RESET;
    }
    return line;
}

// --- Render ------------------------------------------------------------------

/** Renders one expanded line, honoring `\c` truncation (which ate its own newline). */
function emitRow(line: string): string {
    const expanded = expandBackslashEscapes(line);
    return expanded.truncated ? expanded.text : `${expanded.text}\n`;
}

/**
 * Quota source order: stdin `rate_limits`, then the last-known account cache.
 * Missing data remains explicit; this renderer never reads credentials.
 */
function readQuota(fields: PayloadFields, account: AccountLabel): QuotaInput {
    const cache = usageCachePath(account);
    const { fiveRaw, fiveResets, sevenRaw, sevenResets } = fields;
    if (fiveRaw !== "" || sevenRaw !== "") {
        try {
            writeFileSync(cache, [fiveRaw, fiveResets, sevenRaw, sevenResets].join(UNIT_SEPARATOR) + "\n");
        } catch {
            // Losing the cache write only costs the next cold start.
        }
        return { fiveRaw, fiveResets, sevenRaw, sevenResets, usageSource: "live", usageAgeSeconds: 0 };
    }
    if (!existsSync(cache)) {
        return { fiveRaw, fiveResets, sevenRaw, sevenResets, usageSource: "", usageAgeSeconds: 0 };
    }
    const [cachedFive = "", cachedFiveResets = "", cachedSeven = "", cachedSevenResets = ""] = readFields(
        readFileOrEmpty(cache).split("\n")[0]!,
        4
    );
    const cachedAt = mtimeSeconds(cache);
    return {
        fiveRaw: cachedFive,
        fiveResets: cachedFiveResets,
        sevenRaw: cachedSeven,
        sevenResets: cachedSevenResets,
        usageSource: "cache",
        usageAgeSeconds: cachedAt === undefined ? 0 : nowSeconds() - cachedAt
    };
}

function render(): string {
    const fields = extractPayloadFields(readStdin());
    const configDir = resolveConfigDir();
    const accountLabel = resolveAccountLabel(configDir);
    const accountMarker =
        accountLabel === "Work" ? `${BOLD}${PALETTE.work}W${RESET}` : `${BOLD}${PALETTE.personal}P${RESET}`;

    const location = resolveProjectLocation(fields.cwd, readWorktreePaths(fields.cwd));
    const compactLimit = autoCompactLimit(toNonNegativeInt(fields.maxContext, 200000), readAutoCompactWindow(configDir));
    // Incremental read of the transcript already on disk; see lib/compaction.mts.
    const compactionCount =
        fields.transcriptPath === ""
            ? 0
            : readCompactionHistory(
                  fields.transcriptPath,
                  path.join(CACHE_DIR, `claude-compact-${cacheKey(fields.transcriptPath)}.tsv`)
              ).length;

    return [
        buildSessionLine({
            accountMarker,
            sessionName: fields.sessionName,
            shortId: fields.sessionId.slice(0, 8),
            transcriptUrl: fields.transcriptPath === "" ? "" : toFileUrl(fields.transcriptPath),
            locationLabel: buildLocationLabel(location)
        }),
        buildModelLine({
            model: fields.model,
            effortLevel: fields.effortLevel,
            sessionTokensIn: fields.sessionTokensIn,
            compactLimit,
            compactionCount
        }),
        buildQuotaLine(readQuota(fields, accountLabel))
    ]
        .filter((line) => line !== "")
        .map(emitRow)
        .join("");
}

/**
 * Both sides are compared through realpath because Claude Code may invoke this
 * through a symlink. Node resolves `import.meta.url` to the link target while
 * `process.argv[1]` keeps the link path, so a plain string compare silently
 * fails and the status line renders nothing at all.
 */
function isEntryPoint(): boolean {
    const invoked = process.argv[1];
    if (!invoked) {
        return false;
    }
    return resolveRealPath(invoked) === resolveRealPath(fileURLToPath(import.meta.url));
}

function resolveRealPath(target: string): string {
    try {
        return realpathSync(path.resolve(target));
    } catch {
        return path.resolve(target);
    }
}

if (isEntryPoint()) {
    process.stdout.write(render());
}

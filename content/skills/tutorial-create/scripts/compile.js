#!/usr/bin/env node
/**
 * tutorial-create compiler.
 * Usag<configured-path>node compile.js <source.md> [--out <dir>] [--no-index]
 *
 * Compiles a compact `<slug>.source.md` (see reference/SOURCE_FORMAT.md) into a
 * self-contained interactive HTML tutorial using TEMPLATE.html, then regenerates
 * the OneDrive tutorials index. Zero runtime dependencies in the output.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { createHighlighter, bundledLanguages } from "shiki";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(SCRIPT_DIR, "..", "TEMPLATE.html");
const TUTORIALS_ROOT = resolveTutorialsRoot();
const SHIKI_THEME = "one-dark-pro";

/* ---------------- helpers ---------------- */

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fail(message) {
  console.error(`[compile] ERRO<configured-path>${message}`);
  process.exit(1);
}

function resolveTutorialsRoot() {
  if (process.env.TUTORIALS_ROOT) return process.env.TUTORIALS_ROOT;
  if (process.env.MPX_AI_GENERATED) return join(process.env.MPX_AI_GENERATED, "_TUTORIALS");
  if (process.env.MPX_ONEDRIVE) return join(process.env.MPX_ONEDRIVE, "AI GENERATED", "_TUTORIALS");
  fail("cannot locate the tutorials roo<configured-path>set the machine environment variable MPX_AI_GENERATED (or TUTORIALS_ROOT / MPX_ONEDRIVE).");
}

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/* ---------------- inline markup ---------------- */

/**
 * Renders inline marku<configured-path>code`, **bold**, [text](url), ((glossary term)).
 * Escapes HTML first; code spans are protected from further processing.
 */
function renderInline(text) {
  let html = escapeHtml(text);
  const codeSpans = [];
  html = html.replace(/`([^`]+)`/g, (_, code) => {
    codeSpans.push(`<code>${code}</code>`);
    return `\x00${codeSpans.length - 1}\x00`;
  });
  // glossar<configured-path>((display|key)) or ((key))
  html = html.replace(/\(\(([^)|]+)(?:\|([^)]+))?\)\)/g, (_, a, b) => {
    const display = a.trim();
    const key = (b || a).trim();
    return `<span class="gloss" tabindex="0" data-term="${escapeHtml(key)}">${display}</span>`;
  });
  // link<configured-path>text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    if (url.startsWith("fil<configured-path>")) {
      return `<a class="inline-file-link" href="${url}" target="_blank" rel="noopener noreferrer"><span aria-hidden="true">\u{1F4C1}</span>${label}</a>`;
    }
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // after bold, so any asterisk pair still standing is unambiguously emphasis
  html = html.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  html = html.replace(/\x00(\d+)\x00/g, (_, i) => codeSpans[Number(i)]);
  return html;
}

/* ---------------- source parsing ---------------- */

/* Format presets. `words` is the per-section prose budget (paragraphs, callouts, recap,
   reveal bodies) — annotated-code notes are excluded, since in `brief` they carry the
   content rather than padding it. Budgets warn; they never fail the build. */
const FORMATS = {
  brie<configured-path>{ word<configured-path>60, qui<configured-path>false, reveal<configured-path>false },
  standar<configured-path>{ word<configured-path>200, qui<configured-path>true, reveal<configured-path>true },
  dee<configured-path>{ word<configured-path>Infinity, qui<configured-path>true, reveal<configured-path>true },
};
const TITLE_MAX_CHARS = 40;

function parseSource(raw) {
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!fmMatch) fail("missing YAML frontmatter");
  const meta = parseYaml(fmMatch[1]);
  for (const field of ["title", "type", "category", "slug", "date"]) {
    if (!meta[field]) fail(`frontmatter missing required fiel<configured-path>${field}`);
  }
  if (!["topic", "code-showcase"].includes(meta.type)) fail(`type must be topic|code-showcase, go<configured-path>${meta.type}`);
  meta.format = meta.format || "standard";
  if (!FORMATS[meta.format]) fail(`format must be ${Object.keys(FORMATS).join("|")}, go<configured-path>${meta.format}`);
  const body = raw.slice(fmMatch[0].length);
  const lines = body.split(/\r?\n/);

  const sections = [];
  let quiz = null;
  let current = null;
  let i = 0;

  const pushParagraph = (buffer) => {
    const text = buffer.join(" ").trim();
    if (text && current) current.blocks.push({ kin<configured-path>"p", text });
    buffer.length = 0;
  };

  let para = [];
  while (i < lines.length) {
    const line = lines[i];

    const heading = line.match(/^# +([a-z0-9-]+) *\| *(.+)$/);
    if (heading) {
      pushParagraph(para);
      current = { slu<configured-path>heading[1], titl<configured-path>heading[2].trim(), block<configured-path>};
      sections.push(current);
      i++;
      continue;
    }

    const fence = line.match(/^```(\w+)?(?: +(.+))?$/);
    if (fence && current) {
      pushParagraph(para);
      const { block, next } = parseCodeFence(lines, i);
      current.blocks.push(block);
      i = next;
      continue;
    }

    const container = line.match(/^:::(\w+)(?: +(.+))?$/);
    if (container) {
      pushParagraph(para);
      const name = container[1];
      const arg = (container[2] || "").trim();
      const inner = [];
      i++;
      while (i < lines.length && lines[i].trim() !== ":::") {
        inner.push(lines[i]);
        i++;
      }
      i++; // skip closing :::
      if (name === "quiz") {
        quiz = parseQuiz(inner);
      } else if (current) {
        current.blocks.push(parseContainer(name, arg, inner));
      }
      continue;
    }

    if (line.trim() === "") {
      pushParagraph(para);
    } else {
      para.push(line.trim());
    }
    i++;
  }
  pushParagraph(para);

  if (!sections.length) fail("no sections found (use `# slug | Title` headings)");
  return { meta, sections, quiz };
}

/** Parses a fenced code block starting at lines[start]; consumes trailing @<configured-path>annotation lines. */
function parseCodeFence(lines, start) {
  const open = lines[start].match(/^```(\w+)?(?: +(.+))?$/);
  const lang = open[1] || "text";
  const fname = (open[2] || "").trim();
  const codeLines = [];
  let i = start + 1;
  while (i < lines.length && !lines[i].startsWith("```")) {
    codeLines.push(lines[i]);
    i++;
  }
  i++; // closing fence

  if (lang === "mermaid") {
    return { bloc<configured-path>{ kin<configured-path>"mermaid", cod<configured-path>codeLines.join("\n") }, nex<configured-path>i };
  }

  // strip //@N or #@N markers, remember which line owns which note
  const noteByLine = {};
  const cleaned = codeLines.map((codeLine, index) => {
    const marker = codeLine.match(/^(.*?)\s*(?:\/\/|#)@(\d+)\s*$/);
    if (marker) {
      noteByLine[index] = Number(marker[2]);
      return marker[1].replace(/\s+$/, "");
    }
    return codeLine;
  });

  // trailing @<configured-path>Title | body lines
  const notes = {};
  while (i < lines.length) {
    const note = lines[i].match(/^@(\d+): *([^|]+?) *\| *(.+)$/);
    if (!note) break;
    notes[Number(note[1])] = { titl<configured-path>note[2].trim(), bod<configured-path>note[3].trim() };
    i++;
  }

  const annotated = Object.keys(noteByLine).length > 0;
  return {
    bloc<configured-path>{ kin<configured-path>annotated ? "annotated-code" : "code", lang, fname, cod<configured-path>cleaned.join("\n"), noteByLine, notes },
    nex<configured-path>i,
  };
}

function parseContainer(name, arg, inner) {
  if (name === "info" || name === "warn") {
    return { kin<configured-path>"callout", ton<configured-path>name, titl<configured-path>arg || (name === "info" ? "Good to know" : "Watch out"), bod<configured-path>inner.join(" ").trim() };
  }
  if (name === "recap") {
    const bullets = inner.filter((l) => l.trim().startsWith("- ")).map((l) => l.trim().slice(2));
    return { kin<configured-path>"recap", bullets };
  }
  if (name === "reveal") {
    return { kin<configured-path>"reveal", questio<configured-path>arg, bod<configured-path>inner.join(" ").trim() };
  }
  if (name === "walkthrough") {
    return parseWalkthrough(inner);
  }
  if (name === "playground") {
    return parsePlayground(inner);
  }
  fail(`unknown container :::${name}`);
}

/* ---------------- playground parsing ---------------- */

const PLAYGROUND_LABEL_POOL = ["A", "B — wide", "C", "D — wider still", "E", "F — wide"];
const PLAYGROUND_MIN_ITEMS = 2;
const PLAYGROUND_MAX_ITEMS = 6;

function parsePlaygroundControls(raw) {
  const controls = {};
  for (const [prop, value] of Object.entries(raw || {})) {
    const text = String(value).trim();
    const range = text.match(/^(-?\d+)\.\.(-?\d+)(?: +step +(\d+))?$/);
    if (range) {
      controls[prop] = {
        typ<configured-path>"range",
        mi<configured-path>Number(range[1]),
        ma<configured-path>Number(range[2]),
        ste<configured-path>range[3] ? Number(range[3]) : 1,
        uni<configured-path>prop === "gap" ? "px" : "",
        defaul<configured-path>Number(range[1]),
      };
    } else {
      const values = text.split("|").map((v) => v.trim()).filter(Boolean);
      if (values.length < 2) fail(`playgroun<configured-path>control "${prop}" needs "a | b" enum or "min..max" range, go<configured-path>${text}`);
      controls[prop] = { typ<configured-path>"enum", values, defaul<configured-path>values[0] };
    }
  }
  return controls;
}

function validatePlaygroundTarget(scope, controls, target, challengeTitle) {
  const out = {};
  for (const [prop, value] of Object.entries(target || {})) {
    const control = controls[prop];
    if (!control) fail(`playground challenge "${challengeTitle}": target uses undeclared ${scope} control "${prop}"`);
    if (control.type === "enum") {
      if (!control.values.includes(String(value))) {
        fail(`playground challenge "${challengeTitle}": ${prop}: ${value} is not among declared values`);
      }
      out[prop] = String(value);
    } else {
      const num = Number(value);
      if (Number.isNaN(num) || num < control.min || num > control.max) {
        fail(`playground challenge "${challengeTitle}": ${prop}: ${value} outside range ${control.min}..${control.max}`);
      }
      out[prop] = num;
    }
  }
  return out;
}

function clampItemCount(n, fallback) {
  const num = Number(n);
  if (!num) return fallback;
  return Math.min(PLAYGROUND_MAX_ITEMS, Math.max(PLAYGROUND_MIN_ITEMS, num));
}

function parsePlayground(inner) {
  let raw;
  try {
    raw = parseYaml(inner.join("\n"));
  } catch (error) {
    fail(`playgroun<configured-path>invalid YAML — ${error.message}`);
  }
  if (!raw || typeof raw !== "object") fail("playgroun<configured-path>empty config");

  const container = parsePlaygroundControls(raw.container);
  const item = parsePlaygroundControls(raw.item);
  if (!Object.keys(container).length) fail("playgroun<configured-path>needs at least one container control");

  const itemCount = clampItemCount(raw.items, 3);
  const authoredLabels = typeof raw["item-labels"] === "string"
    ? raw["item-labels"].split("|").map((s) => s.trim()).filter(Boolean)
    : [];
  const itemLabels = [];
  for (let i = 0; i < PLAYGROUND_MAX_ITEMS; i++) itemLabels.push(authoredLabels[i] || PLAYGROUND_LABEL_POOL[i]);

  const challenges = (raw.challenges || []).map((challenge, index) => {
    if (!challenge || !challenge.title || !challenge.target) fail(`playground challenge ${index + 1}: needs title and target`);
    const target = challenge.target;
    const nested = Boolean(target.container) || Object.keys(target).some((k) => /^item-\d+$/.test(k));
    const targetContainer = validatePlaygroundTarget("container", container, nested ? target.container : target, challenge.title);
    const targetItems = {};
    const count = clampItemCount(challenge.items, itemCount);
    if (nested) {
      for (const [key, value] of Object.entries(target)) {
        if (key === "container") continue;
        const match = key.match(/^item-(\d+)$/);
        if (!match) fail(`playground challenge "${challenge.title}": unknown target key "${key}"`);
        const n = Number(match[1]);
        if (n < 1 || n > count) fail(`playground challenge "${challenge.title}": item-${n} outside 1..${count}`);
        targetItems[n] = validatePlaygroundTarget("item", item, value, challenge.title);
      }
    }
    return {
      titl<configured-path>String(challenge.title),
      brie<configured-path>String(challenge.brief || ""),
      hin<configured-path>challenge.hint ? String(challenge.hint) : "",
      item<configured-path>count,
      targe<configured-path>{ containe<configured-path>targetContainer, item<configured-path>targetItems },
    };
  });

  return { kin<configured-path>"playground", confi<configured-path>{ itemCount, itemLabels, container, item, challenges } };
}

function parseWalkthrough(inner) {
  let code = null;
  const steps = [];
  let i = 0;
  while (i < inner.length) {
    const line = inner[i];
    if (line.startsWith("```")) {
      const { block, next } = parseCodeFence(inner, i);
      code = block;
      i = next;
      continue;
    }
    const step = line.match(/^== *(\d+(?:-\d+)?) *\| *(.+)$/);
    if (step) {
      steps.push({ rang<configured-path>step[1], titl<configured-path>step[2].trim(), bod<configured-path>});
      i++;
      continue;
    }
    if (steps.length && line.trim()) steps[steps.length - 1].body.push(line.trim());
    i++;
  }
  if (!code || !steps.length) fail("walkthrough needs a code fence and at least one `== range | title` step");
  return { kin<configured-path>"walkthrough", code, steps };
}

function parseQuiz(inner) {
  const questions = [];
  let q = null;
  for (const line of inner) {
    const question = line.match(/^<configured-path>*(.+)$/);
    if (question) {
      q = { tex<configured-path>question[1].trim(), option<configured-path>, explanatio<configured-path>"" };
      questions.push(q);
      continue;
    }
    const option = line.match(/^- \[([ x])\] *(.+)$/);
    if (option && q) {
      q.options.push({ correc<configured-path>option[1] === "x", tex<configured-path>option[2].trim() });
      continue;
    }
    const explain = line.match(/^> *(.+)$/);
    if (explain && q) {
      q.explanation += (q.explanation ? " " : "") + explain[1].trim();
    }
  }
  if (!questions.length) fail("quiz container has no questions");
  for (const question of questions) {
    if (!question.options.some((o) => o.correct)) fail(`quiz question has no correct optio<configured-path>${question.text}`);
  }
  return questions;
}

/* ---------------- code highlighting ---------------- */

let highlighter = null;

async function initHighlighter(langs) {
  const valid = [...new Set(langs)].filter((l) => l in bundledLanguages);
  highlighter = await createHighlighter({ theme<configured-path>SHIKI_THEME], lang<configured-path>valid.length ? valid : ["javascript"] });
}

/** Returns per-line HTML (token spans, fully escaped). */
function highlightLines(code, lang) {
  const effectiveLang = lang in bundledLanguages ? lang : "text";
  if (effectiveLang === "text" || !highlighter) {
    return code.split("\n").map((l) => escapeHtml(l) || " ");
  }
  const { tokens } = highlighter.codeToTokens(code, { lan<configured-path>effectiveLang, them<configured-path>SHIKI_THEME });
  return tokens.map((lineTokens) => {
    if (!lineTokens.length) return " ";
    return lineTokens
      .map((t) => (t.color ? `<span style="color:${t.color}">${escapeHtml(t.content)}</span>` : escapeHtml(t.content)))
      .join("");
  });
}

/* ---------------- HTML rendering ---------------- */

const SVG = {
  chec<configured-path>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  checkThi<configured-path>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  inf<configured-path>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg>',
  war<configured-path>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
  cloc<configured-path>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  pla<configured-path>'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  boo<configured-path>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
  qui<configured-path>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/><circle cx="12" cy="12" r="10"/></svg>',
  chevro<configured-path>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
  ta<configured-path>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3 8-8"/><path d="M21 12A9 9 0 1 1 3 12"/></svg>',
  okSmal<configured-path>'<svg class="ok-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  errSmal<configured-path>'<svg class="err-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
};

let revealCounter = 0;
let mermaidCounter = 0;
let mermaidRenderer; // lazy-resolved once

async function getMermaidRenderer() {
  if (mermaidRenderer !== undefined) return mermaidRenderer;
  try {
    const mod = await import("@mermaid-js/mermaid-cli");
    mermaidRenderer = mod;
  } catch {
    mermaidRenderer = null;
  }
  return mermaidRenderer;
}

const MERMAID_THEMES = {
  ligh<configured-path>{ them<configured-path>"neutral" },
  dar<configured-path>{ them<configured-path>"dark" },
};

async function renderMermaidVariant(renderer, code, workDir, variant) {
  const input = join(workDir, `diagram-${mermaidCounter}-${variant}.mmd`);
  const output = join(workDir, `diagram-${mermaidCounter}-${variant}.svg`);
  writeFileSync(input, code, "utf8");
  await renderer.run(input, output, {
    quie<configured-path>true,
    outputForma<configured-path>"svg",
    puppeteerConfi<configured-path>{ headles<configured-path>"new" },
    parseMMDOption<configured-path>{
      backgroundColo<configured-path>"transparent",
      svgI<configured-path>mermaid-${mermaidCounter}-${variant}`,
      mermaidConfi<configured-path>{
        ...MERMAID_THEMES[variant],
        fontFamil<configured-path>'"Segoe UI", system-ui, sans-serif',
        flowchar<configured-path>{ nodeSpacin<configured-path>30, rankSpacin<configured-path>36 },
      },
    },
  });
  return readFileSync(output, "utf8").replace(/^<\?xml[^>]*\?>\s*/, "");
}

async function renderMermaid(code) {
  const renderer = await getMermaidRenderer();
  if (!renderer) {
    console.warn("[compile] WARNIN<configured-path>diagram skipped — install @mermaid-js/mermaid-cli to render mermaid blocks");
    return "<!-- mermaid diagram skippe<configured-path>@mermaid-js/mermaid-cli not installed -->";
  }
  mermaidCounter++;
  const workDir = join(tmpdir(), `tutorial-mermaid-${process.pid}`);
  mkdirSync(workDir, { recursiv<configured-path>true });
  try {
    const lightSvg = await renderMermaidVariant(renderer, code, workDir, "light");
    const darkSvg = await renderMermaidVariant(renderer, code, workDir, "dark");
    return `<figure class="diagram"><div class="diagram-light">${lightSvg}</div><div class="diagram-dark">${darkSvg}</div></figure>`;
  } catch (error) {
    console.warn(`[compile] WARNIN<configured-path>diagram skipped — mermaid render faile<configured-path>${error.message}`);
    return "<!-- mermaid diagram skippe<configured-path>render failed -->";
  } finally {
    rmSync(workDir, { recursiv<configured-path>true, forc<configured-path>true });
  }
}

function codeTopbar(fname, lang) {
  return `<div class="code-topbar"><span class="dots"><i></i><i></i><i></i></span>${
    fname ? `<span class="fname">${escapeHtml(fname)}</span>` : ""
  }<span class="lang">${escapeHtml(lang)}</span></div>`;
}

function renderPlainCode(block) {
  const lines = highlightLines(block.code, block.lang);
  const body = lines.map((h) => `<span class="cl">${h}</span>`).join("");
  return `<div class="code-block plain">${codeTopbar(block.fname, block.lang)}<pre class="code"><code>${body}</code></pre></div>`;
}

function renderAnnotatedCode(block) {
  const lines = highlightLines(block.code, block.lang);
  let codeHtml = "";
  const railCards = [];
  lines.forEach((lineHtml, index) => {
    const noteNum = block.noteByLine[index];
    const note = noteNum ? block.notes[noteNum] : null;
    if (note) {
      codeHtml +=
        `<span class="cl has-note" data-line="${noteNum}" role="button" tabindex="0" aria-expanded="false">${lineHtml}` +
        `<span class="note-badge">${noteNum}</span></span>` +
        `<span class="cl-note-inline" data-inline="${noteNum}">` +
        `<span class="nih"><span class="nn">${noteNum}</span>${renderInline(note.title)}</span>` +
        `<span>${renderInline(note.body)}</span></span>`;
      railCards.push(
        `<div class="anno" data-anno="${noteNum}"><div class="anno-head"><span class="anno-num">${noteNum}</span>` +
          `<span class="anno-title">${renderInline(note.title)}</span></div>` +
          `<div class="anno-body">${renderInline(note.body)}</div></div>`
      );
    } else {
      codeHtml += `<span class="cl">${lineHtml}</span>`;
    }
  });
  return (
    `<div class="mobile-hint">${SVG.tap}Tap a numbered badge in the code to read its note.</div>` +
    `<div class="code-region"><div class="code-block">${codeTopbar(block.fname, block.lang)}` +
    `<pre class="code"><code>${codeHtml}</code></pre></div>` +
    `<div class="annos">${railCards.join("")}</div>` +
    `<svg class="wires" aria-hidden="true"></svg></div>`
  );
}

function renderWalkthrough(block) {
  const lines = highlightLines(block.code.code, block.code.lang);
  const codeHtml = lines.map((h, i) => `<span class="cl" data-wtline="${i + 1}">${h}</span>`).join("");
  const total = block.steps.length;
  const cards = block.steps
    .map(
      (step, i) =>
        `<div class="wt-card" data-step="${i + 1}" data-range="${step.range}" role="button" tabindex="0" aria-pressed="false">` +
        `<div class="wt-step-head"><span class="wt-step-num">${i + 1}</span>` +
        `<span class="wt-step-title">${renderInline(step.title)}</span>` +
        `<span class="wt-step-nav">${i + 1} / ${total}</span></div>` +
        `<div class="wt-step-body">${renderInline(step.body.join(" "))}</div></div>`
    )
    .join("");
  return (
    `<div class="wt-region"><div class="wt-steps" role="list">${cards}</div>` +
    `<div class="wt-code-col"><div class="wt-code"><div class="code-block">${codeTopbar(block.code.fname, block.code.lang)}` +
    `<pre class="code"><code>${codeHtml}</code></pre></div></div></div></div>`
  );
}

function renderCallout(block) {
  return (
    `<div class="callout ${block.tone}"><span class="cico">${block.tone === "info" ? SVG.info : SVG.warn}</span>` +
    `<span class="cbody"><span class="ctitle">${renderInline(block.title)}</span>${renderInline(block.body)}</span></div>`
  );
}

function renderRecap(block) {
  const items = block.bullets.map((b) => `<li>${renderInline(b)}</li>`).join("");
  return `<div class="recap"><div class="recap-head"><span class="rmark">✦</span>Key takeaways</div><ul>${items}</ul></div>`;
}

function renderReveal(block) {
  revealCounter++;
  const id = `revealAns${revealCounter}`;
  return (
    `<div class="reveal"><div class="reveal-q"><span class="rq-emoji">\u{1F914}</span>` +
    `<span class="rq-text">Check yourself — ${renderInline(block.question)}</span></div>` +
    `<button class="reveal-btn" type="button" aria-expanded="false" aria-controls="${id}">${SVG.chevron}<span class="rb-label">Reveal answer</span></button>` +
    `<div class="reveal-ans" id="${id}">${renderInline(block.body)}</div></div>`
  );
}

/* ---------------- playground rendering ---------------- */

function shikiTokenSpan(color, text) {
  const escaped = escapeHtml(text);
  return color ? `<span style="color:${color}">${escaped}</span>` : escaped;
}

/**
 * Highlights one CSS line whose [valueStart, valueEnd) range is a mutable value.
 * The value range is re-emitted as a single <span class="pg-slot"> (fixed color)
 * so runtime JS can swap textContent without losing highlighting.
 */
function renderSlotLine(lineTokens, valueStart, valueEnd, slotId, rawValue) {
  let column = 0;
  let before = "";
  let after = "";
  let slotColor = null;
  for (const token of lineTokens) {
    const start = column;
    const end = column + token.content.length;
    column = end;
    if (end <= valueStart) {
      before += shikiTokenSpan(token.color, token.content);
    } else if (start >= valueEnd) {
      after += shikiTokenSpan(token.color, token.content);
    } else {
      if (start < valueStart) before += shikiTokenSpan(token.color, token.content.slice(0, valueStart - start));
      if (!slotColor) slotColor = token.color || null;
      if (end > valueEnd) after += shikiTokenSpan(token.color, token.content.slice(valueEnd - start));
    }
  }
  const colorAttr = slotColor ? ` style="color:${slotColor}"` : "";
  return `${before}<span class="pg-slot" data-slot="${slotId}"${colorAttr}>${escapeHtml(rawValue)}</span>${after}`;
}

function controlValueText(control, value) {
  return String(value) + (control.unit || "");
}

/** Builds the Shiki-highlighted CSS readout with slot spans and rule/decl metadata. */
function renderPlaygroundReadout(config) {
  const cssLines = [];
  const lineMeta = [];
  const pushLine = (text, meta) => {
    cssLines.push(text);
    lineMeta.push(meta || {});
  };

  pushLine(".container {");
  pushLine("  displa<configured-path>flex;");
  for (const [prop, control] of Object.entries(config.container)) {
    const value = controlValueText(control, control.default);
    pushLine(`  ${prop}: ${value};`, { slo<configured-path>c:${prop}`, value });
  }
  pushLine("}");

  const itemProps = Object.entries(config.item);
  if (itemProps.length) {
    for (let n = 1; n <= PLAYGROUND_MAX_ITEMS; n++) {
      pushLine("", { rul<configured-path>n, hidde<configured-path>true });
      pushLine(`.item:nth-child(${n}) {`, { rul<configured-path>n, hidde<configured-path>true });
      for (const [prop, control] of itemProps) {
        const value = controlValueText(control, control.default);
        pushLine(`  ${prop}: ${value};`, { rul<configured-path>n, hidde<configured-path>true, slo<configured-path>i${n}:${prop}`, dec<configured-path>i${n}:${prop}`, value });
      }
      pushLine("}", { rul<configured-path>n, hidde<configured-path>true });
    }
  }

  const cssText = cssLines.join("\n");
  let tokenLines;
  if (highlighter && "css" in bundledLanguages) {
    tokenLines = highlighter.codeToTokens(cssText, { lan<configured-path>"css", them<configured-path>SHIKI_THEME }).tokens;
  } else {
    tokenLines = cssLines.map((line) => [{ conten<configured-path>line, colo<configured-path>null }]);
  }

  const htmlLines = cssLines.map((line, index) => {
    const meta = lineMeta[index];
    const tokens = tokenLines[index] || [];
    let inner;
    if (meta.slot) {
      const valueStart = line.indexOf(": ") + 2;
      const valueEnd = valueStart + meta.value.length;
      inner = renderSlotLine(tokens, valueStart, valueEnd, meta.slot, meta.value);
    } else if (!tokens.length || !line) {
      inner = " ";
    } else {
      inner = tokens.map((t) => shikiTokenSpan(t.color, t.content)).join("");
    }
    const classes = ["cl"];
    if (meta.hidden) classes.push("pg-line-hidden");
    const ruleAttr = meta.rule ? ` data-pgrule="${meta.rule}"` : "";
    const declAttr = meta.decl ? ` data-pgdecl="${meta.decl}"` : "";
    return `<span class="${classes.join(" ")}"${ruleAttr}${declAttr}>${inner}</span>`;
  });

  return (
    `<div class="code-block pg-readout">${codeTopbar("playground.css", "css")}` +
    `<pre class="code"><code>${htmlLines.join("")}</code></pre></div>`
  );
}

function renderPlaygroundControlRow(scope, prop, control) {
  const label = `<span class="pg-ctrl-label"><code>${escapeHtml(prop)}</code></span>`;
  if (control.type === "enum") {
    const buttons = control.values
      .map(
        (value) =>
          `<button type="button" class="pg-seg-btn" data-value="${escapeHtml(value)}" aria-pressed="${value === control.default}">${escapeHtml(value)}</button>`
      )
      .join("");
    return `<div class="pg-ctrl" data-scope="${scope}" data-prop="${escapeHtml(prop)}" data-kind="enum">${label}<div class="pg-seg" role="group" aria-label="${escapeHtml(prop)}">${buttons}</div></div>`;
  }
  return (
    `<div class="pg-ctrl" data-scope="${scope}" data-prop="${escapeHtml(prop)}" data-kind="range">${label}` +
    `<div class="pg-step"><button type="button" class="pg-step-btn" data-dir="-1" aria-label="Decrease ${escapeHtml(prop)}">−</button>` +
    `<span class="pg-step-val">${controlValueText(control, control.default)}</span>` +
    `<button type="button" class="pg-step-btn" data-dir="1" aria-label="Increase ${escapeHtml(prop)}">+</button></div></div>`
  );
}

function renderPlayground(block, sectionSlug) {
  const config = { sectio<configured-path>sectionSlug, ...block.config };
  const uid = `pg-${sectionSlug}`;

  const tabs = [
    `<button type="button" class="pg-tab active" data-mode="explore" aria-pressed="true">Explore</button>`,
    ...config.challenges.map(
      (challenge, i) =>
        `<button type="button" class="pg-tab" data-mode="challenge" data-challenge="${i}" aria-pressed="false">` +
        `<span class="pg-tab-num">${i + 1}</span>${escapeHtml(challenge.title)}<span class="pg-tab-check" hidden>✓</span></button>`
    ),
  ].join("");

  const challengeInfos = config.challenges
    .map((challenge, i) => {
      const hint = challenge.hint
        ? `<div class="pg-hint"><button type="button" class="reveal-btn" data-show-label="Show hint" data-hide-label="Hide hint" aria-expanded="false" aria-controls="${uid}-hint-${i}">${SVG.chevron}<span class="rb-label">Show hint</span></button>` +
          `<div class="reveal-ans" id="${uid}-hint-${i}">${renderInline(challenge.hint)}</div></div>`
        : "";
      const next = i + 1 < config.challenges.length
        ? `<button type="button" class="pg-next" data-next="${i + 1}">Next challenge →</button>`
        : "";
      return (
        `<div class="pg-chal-info" data-chal-info="${i}" hidden>` +
        `<p class="pg-brief"><span class="pg-brief-num">${i + 1}</span>${renderInline(challenge.brief)}</p>${hint}` +
        `<div class="pg-success" hidden>${SVG.checkThin}<span>Solved — the ghosts agree.</span>${next}</div></div>`
      );
    })
    .join("");

  const containerRows = Object.entries(config.container)
    .map(([prop, control]) => renderPlaygroundControlRow("container", prop, control))
    .join("");
  const itemRows = Object.entries(config.item)
    .map(([prop, control]) => renderPlaygroundControlRow("item", prop, control))
    .join("");
  const itemGroup = itemRows
    ? `<div class="pg-ctrl-group pg-item-group"><div class="pg-ctrl-title">Item <span class="pg-item-which"></span></div>` +
      `<div class="pg-item-hint">Select an item in the preview to adjust it.</div>` +
      `<div class="pg-item-ctrls" hidden>${itemRows}</div></div>`
    : "";

  const realItems = Array.from(
    { lengt<configured-path>config.itemCount },
    (_, i) => `<button type="button" class="pg-item">${escapeHtml(config.itemLabels[i])}</button>`
  ).join("");

  const configJson = JSON.stringify(config).replace(/</g, "\\u003c");

  return (
    `<div class="pg-region" data-pg-section="${sectionSlug}" data-mode="explore">` +
    `<script type="application/json" class="pg-config">${configJson}</script>` +
    `<div class="pg-tabs" role="group" aria-label="Playground mode">${tabs}</div>` +
    challengeInfos +
    `<div class="pg-body">` +
    `<div class="pg-controls">` +
    `<div class="pg-ctrl-group"><div class="pg-ctrl-title">Container</div>${containerRows}</div>` +
    itemGroup +
    `<div class="pg-actions">` +
    `<button type="button" class="pg-action-btn pg-add">+ item</button>` +
    `<button type="button" class="pg-action-btn pg-remove">− item</button>` +
    `<button type="button" class="pg-action-btn pg-reset">Reset</button>` +
    `</div></div>` +
    `<div class="pg-stage">` +
    `<div class="pg-canvas"><div class="pg-flex pg-ghost" aria-hidden="true"></div><div class="pg-flex pg-real">${realItems}</div></div>` +
    renderPlaygroundReadout(config) +
    `</div></div></div>`
  );
}

async function renderBlock(block, nextBlock, sectionSlug) {
  switch (block.kind) {
    case "p": {
      const introNext = nextBlock && ["annotated-code", "code", "walkthrough", "mermaid", "playground"].includes(nextBlock.kind);
      return `<p${introNext ? ' class="intro-line"' : ""}>${renderInline(block.text)}</p>`;
    }
    case "code":
      return renderPlainCode(block);
    case "annotated-code":
      return renderAnnotatedCode(block);
    case "walkthrough":
      return renderWalkthrough(block);
    case "callout":
      return renderCallout(block);
    case "recap":
      return renderRecap(block);
    case "reveal":
      return renderReveal(block);
    case "playground":
      return renderPlayground(block, sectionSlug);
    case "mermaid":
      return await renderMermaid(block.code);
    defaul<configured-path>fail(`unknown block kin<configured-path>${block.kind}`);
  }
}

async function renderSection(section, index) {
  const num = String(index + 1).padStart(2, "0");
  const parts = [];
  for (let i = 0; i < section.blocks.length; i++) {
    parts.push(await renderBlock(section.blocks[i], section.blocks[i + 1], section.slug));
  }
  return `    <section class="section" id="${section.slug}" data-slug="${section.slug}">
      <div class="section-head">
        <h2><span class="snum">${num}</span>${renderInline(section.title)}</h2>
        <button class="understand-btn" data-understand="${section.slug}" aria-pressed="false">
          <span class="ic"><svg class="ring-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/></svg><svg class="check-ic" style="display:none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>
          <span class="btn-label">Mark as understood</span>
        </button>
      </div>
      <div class="section-body">
${parts.join("\n")}
        <div class="done-banner">${SVG.checkThin}Section understood — nicely done.</div>
      </div>
    </section>`;
}

function renderTocItems(sections) {
  return sections
    .map(
      (s, i) =>
        `          <li><a class="toc-link" href="#${s.slug}" data-toc="${s.slug}">` +
        `<span class="toc-dot">${SVG.check}</span>` +
        `<span class="toc-num">${String(i + 1).padStart(2, "0")}</span><span class="toc-label">${renderInline(s.title)}</span></a></li>`
    )
    .join("\n");
}

function renderVideos(videos) {
  if (!videos || !videos.length) return "";
  const cards = videos
    .map(
      (v) =>
        `        <a class="video-card" href="${escapeHtml(v.url)}" target="_blank" rel="noopener noreferrer" aria-label="Watc<configured-path>${escapeHtml(v.title)} on ${escapeHtml(v.channel)}">
          <span class="video-thumb"><span class="play">${SVG.play}</span></span>
          <span class="video-info">
            <span class="vtitle">${escapeHtml(v.title)}</span>
            <span class="vmeta">${escapeHtml(v.channel)} <span class="dur">${SVG.clock}${escapeHtml(v.duration || "")}</span></span>
          </span>
        </a>`
    )
    .join("\n");
  return `\n      <div class="videos">\n${cards}\n      </div>`;
}

function renderReferences(references) {
  if (!references || !references.length) return "";
  const docs = references.filter((r) => r.url);
  const locals = references.filter((r) => r.file);
  const group = (title, items) => {
    if (!items.length) return "";
    const list = items
      .map((r) => {
        if (r.url) {
          let sub = r.url;
          try { sub = new URL(r.url).hostname; } catch { /* keep raw */ }
          return `            <li><a class="ref-link" href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer"><span class="rl-mark">\u{1F4C4}</span><span class="rl-body"><span class="rl-title">${escapeHtml(r.title)}</span><span class="rl-sub">${escapeHtml(sub)}</span></span><span class="rl-arrow" aria-hidden="true">↗</span></a></li>`;
        }
        const fileUrl = "fil<configured-path>" + String(r.file).replace(/\\/g, "/").replace(/^\/+/, "");
        const sub = String(r.file).replace(/\\/g, "/").split("/").slice(-2).join("/");
        return `            <li><a class="ref-link" href="${escapeHtml(fileUrl)}"><span class="rl-mark">\u{1F4C1}</span><span class="rl-body"><span class="rl-title">${escapeHtml(r.title)}</span><span class="rl-sub">${escapeHtml(sub)}</span></span></a></li>`;
      })
      .join("\n");
    return `        <div class="refs-group">\n          <h3>${title}</h3>\n          <ul class="refs-list">\n${list}\n          </ul>\n        </div>`;
  };
  return `    <div class="refs">
      <div class="refs-head">
        <span class="ribadge">${SVG.book}</span>
        <div>
          <h2>References &amp; further reading</h2>
          <p>Docs to go deeper, plus where this lives in your codebase</p>
        </div>
      </div>
      <div class="refs-groups">
${[group("Docs", docs), group("In your code", locals)].filter(Boolean).join("\n")}
      </div>
    </div>`;
}

function renderQuiz(questions) {
  if (!questions) return "";
  const qHtml = questions
    .map((q, qi) => {
      const letters = ["A", "B", "C", "D", "E"];
      const correctLetter = letters[q.options.findIndex((o) => o.correct)];
      const opts = q.options
        .map(
          (o, oi) =>
            `          <button class="option" data-opt="${letters[oi]}">
            <span class="marker"><span class="opt-letter">${letters[oi]}</span>${SVG.okSmall}${SVG.errSmall}</span>
            ${renderInline(o.text)}
          </button>`
        )
        .join("\n");
      return `      <div class="question" data-correct="${correctLetter}">
        <div class="qtext"><span class="qn">Q${qi + 1}.</span>${renderInline(q.text)}</div>
        <div class="options">
${opts}
        </div>
        <div class="explain good" data-for="${correctLetter}">${SVG.checkThin}<span><b>Correct.</b> ${renderInline(q.explanation)}</span></div>
      </div>`;
    })
    .join("\n");
  return `    <div class="quiz-wrap">
      <div class="quiz-head">
        <span class="qibadge">${SVG.quiz}</span>
        <div>
          <h2>Quick check</h2>
          <p>${questions.length} question${questions.length > 1 ? "s" : ""} · answers reveal instantly</p>
        </div>
      </div>
${qHtml}
    </div>`;
}

/* ---------------- reading time ---------------- */

/* Counts code by LINE, not by bloc<configured-path>a four-line diff is not a page of code, and a flat
   per-block cost made short-form tutorials read as three times longer than they are.
   Annotation note bodies count as prose — in `brief` they are the actual reading. */
function estimateReadMinutes(sections) {
  let words = 0;
  let codeLines = 0;
  const addCode = (code) => { codeLines += code.split("\n").length; };
  for (const section of sections) {
    for (const block of section.blocks) {
      if (block.kind === "p") words += countWords(block.text);
      else if (block.kind === "callout") words += countWords(block.body);
      else if (block.kind === "recap") words += countWords(block.bullets.join(" "));
      else if (block.kind === "reveal") words += countWords(block.question) + countWords(block.body);
      else if (block.kind === "walkthrough") {
        addCode(block.code);
        for (const step of block.steps) words += countWords(step.title) + countWords(step.body.join(" "));
      } else if (block.kind === "code" || block.kind === "annotated-code") {
        addCode(block.code);
        for (const note of Object.values(block.notes)) words += countWords(note.title) + countWords(note.body);
      } else if (block.kind === "mermaid") codeLines += 10;
      else codeLines += 20; // playgroun<configured-path>interactive, so budget more than its config implies
    }
  }
  return Math.max(1, Math.round(words / 180 + codeLines / 30));
}

/* ---------------- index generation ---------------- */

function collectTutorials(root) {
  const tutorials = [];
  if (!existsSync(root)) return tutorials;
  for (const entry of readdirSync(root)) {
    const categoryDir = join(root, entry);
    if (!statSync(categoryDir).isDirectory()) continue;
    for (const file of readdirSync(categoryDir)) {
      if (!file.endsWith(".html")) continue;
      const filePath = join(categoryDir, file);
      const head = readFileSync(filePath, "utf8").slice(0, 4000);
      const metaMatch = head.match(/<!--tutorial-meta (.*?)-->/s);
      let meta = null;
      if (metaMatch) {
        try { meta = JSON.parse(metaMatch[1]); } catch { /* fall through */ }
      }
      if (!meta) {
        const titleMatch = head.match(/<title>([^<]*)<\/title>/);
        meta = { titl<configured-path>titleMatch ? titleMatch[1] : file, slu<configured-path>basename(file, ".html"), section<configured-path>};
      }
      tutorials.push({ ...meta, categor<configured-path>entry, hre<configured-path>${entry}/${file}` });
    }
  }
  return tutorials;
}

function generateIndex(root) {
  const tutorials = collectTutorials(root);
  if (!existsSync(root)) {
    console.warn(`[compile] WARNIN<configured-path>tutorials root not found, index skippe<configured-path>${root}`);
    return;
  }
  const byCategory = {};
  for (const t of tutorials) (byCategory[t.category] ??= []).push(t);

  const groups = Object.keys(byCategory)
    .sort()
    .map((category) => {
      const cards = byCategory[category]
        .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))
        .map((t) => {
          const sections = JSON.stringify((t.sections || []).map((s) => s.slug || s));
          const typeLabel = t.type === "code-showcase" ? "Code showcase" : "Topic tutorial";
          return `      <a class="tut-card" href="${escapeHtml(t.href)}" data-slug="${escapeHtml(t.slug)}" data-sections='${escapeHtml(sections)}'>
        <span class="tc-eyebrow">${typeLabel}</span>
        <span class="tc-title">${escapeHtml(t.title || t.slug)}</span>
        ${t.subtitle ? `<span class="tc-sub">${escapeHtml(t.subtitle)}</span>` : ""}
        <span class="tc-meta">${t.date ? `<span class="chip">${escapeHtml(String(t.date))}</span>` : ""}${t.readMin ? `<span class="chip">~${t.readMin} min</span>` : ""}</span>
        <span class="tc-progress"><span class="tc-bar"><span class="tc-fill"></span></span><span class="tc-count"></span></span>
      </a>`;
        })
        .join("\n");
      return `    <section class="cat">
      <h2>${escapeHtml(category)}</h2>
      <div class="grid">
${cards}
      </div>
    </section>`;
    })
    .join("\n");

  const empty = tutorials.length ? "" : '    <p class="empty">No tutorials yet. Compile one with tutorial-create.</p>';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="light dark" />
<title>Tutorials</title>
<script>
  (function () {
    try {
      var stored = localStorage.getItem('tutorial-theme') || 'system';
      var mql = window.matchMedia('(prefers-color-schem<configured-path>dark)');
      var resolved = stored === 'system' ? (mql.matches ? 'dark' : 'light') : stored;
      document.documentElement.setAttribute('data-theme', resolved);
    } catch (e) { document.documentElement.setAttribute('data-theme', 'light'); }
  })();
</script>
<style>
  :root {
    --fon<configured-path>system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --mon<configured-path>ui-monospace, "SF Mono", "Cascadia Code", "Consolas", "Menlo", monospace;
    --accent-1: #7c5cff;
    --accent-gra<configured-path>linear-gradient(135deg, #7c5cff 0%, #5b6dff 55%, #4aa8ff 100%);
  }
  html[data-theme="light"] {
    --b<configured-path>#f4f5fb; --surfac<configured-path>#ffffff; --surface-2: #f7f8fd; --surface-3: #eef1fa;
    --borde<configured-path>#e4e7f2; --border-stron<configured-path>#d3d8ea;
    --tex<configured-path>#1a1c2e; --text-2: #4a5069; --text-3: #757b96;
    --shadow-car<configured-path>0 1px 2px rgba(24,28,55,.06), 0 8px 24px -12px rgba(24,28,55,.16);
    --shadow-po<configured-path>0 4px 12px rgba(24,28,55,.10), 0 24px 48px -16px rgba(24,28,55,.28);
    --ring-trac<configured-path>#e6e9f5;
  }
  html[data-theme="dark"] {
    --b<configured-path>#0d0d13; --surfac<configured-path>#16161f; --surface-2: #1b1c27; --surface-3: #22232f;
    --borde<configured-path>#262735; --border-stron<configured-path>#33344a;
    --tex<configured-path>#ecedf6; --text-2: #b3b6cc; --text-3: #7f8299;
    --shadow-car<configured-path>0 1px 1px rgba(0,0,0,.4), 0 12px 32px -18px rgba(0,0,0,.7);
    --shadow-po<configured-path>0 8px 40px -8px rgba(90,80,220,.35), 0 24px 60px -20px rgba(0,0,0,.8);
    --ring-trac<configured-path>#262735;
  }
  * { box-sizin<configured-path>border-box; }
  html, body { max-widt<configured-path>100%; overflow-<configured-path>hidden; }
  body { margi<configured-path>0; font-famil<configured-path>var(--font); backgroun<configured-path>var(--bg); colo<configured-path>var(--text); line-heigh<configured-path>1.6; -webkit-font-smoothin<configured-path>antialiased; transitio<configured-path>background .35s ease, color .35s ease; }
  html[data-theme="dark"] body {
    backgroun<configured-path>radial-gradient(1000px 500px at 15% -10%, rgba(124,92,255,.10), transparent 60%),
                radial-gradient(900px 500px at 100% 0%, rgba(74,168,255,.07), transparent 55%), var(--bg);
  }
  .topbar { positio<configured-path>sticky; to<configured-path>0; z-inde<configured-path>50; displa<configured-path>flex; align-item<configured-path>center; justify-conten<configured-path>space-between; ga<configured-path>16px;
    paddin<configured-path>12px clamp(16px, 4vw, 40px); backgroun<configured-path>color-mix(in srgb, var(--bg) 78%, transparent);
    backdrop-filte<configured-path>saturate(1.4) blur(14px); border-botto<configured-path>1px solid var(--border); }
  .brand { displa<configured-path>flex; align-item<configured-path>center; ga<configured-path>10px; font-weigh<configured-path>700; letter-spacin<configured-path>-.01em; font-siz<configured-path>15px; }
  .brand .logo { widt<configured-path>28px; heigh<configured-path>28px; border-radiu<configured-path>9px; backgroun<configured-path>var(--accent-grad); displa<configured-path>grid; place-item<configured-path>center;
    box-shado<configured-path>0 4px 14px -4px rgba(124,92,255,.6); fle<configured-path>none; }
  .brand .logo svg { widt<configured-path>16px; heigh<configured-path>16px; colo<configured-path>#fff; }
  .theme-toggle { displa<configured-path>inline-flex; paddin<configured-path>3px; ga<configured-path>2px; backgroun<configured-path>var(--surface-2); borde<configured-path>1px solid var(--border); border-radiu<configured-path>11px; }
  .theme-toggle button { displa<configured-path>grid; place-item<configured-path>center; widt<configured-path>34px; heigh<configured-path>30px; borde<configured-path>none; border-radiu<configured-path>8px; backgroun<configured-path>transparent;
    colo<configured-path>var(--text-3); curso<configured-path>pointer; transitio<configured-path>background .2s ease, color .2s ease; }
  .theme-toggle button svg { widt<configured-path>17px; heigh<configured-path>17px; }
  .theme-toggle button:hover { colo<configured-path>var(--text); backgroun<configured-path>var(--surface-3); }
  .theme-toggle button[aria-pressed="true"] { backgroun<configured-path>var(--surface); colo<configured-path>var(--accent-1); box-shado<configured-path>var(--shadow-card); }
  .wrap { max-widt<configured-path>1200px; margi<configured-path>0 auto; paddin<configured-path>40px clamp(16px, 4vw, 40px) 96px; }
  h1 { font-siz<configured-path>clamp(30px, 5vw, 42px); letter-spacin<configured-path>-.03em; margi<configured-path>0 0 6px; font-weigh<configured-path>820; }
  .sub { colo<configured-path>var(--text-2); margi<configured-path>0 0 34px; font-siz<configured-path>16px; }
  .cat h2 { font-siz<configured-path>13px; font-weigh<configured-path>800; text-transfor<configured-path>uppercase; letter-spacin<configured-path>.09em; colo<configured-path>var(--text-3); margi<configured-path>34px 0 14px; }
  .grid { displa<configured-path>grid; grid-template-column<configured-path>repeat(auto-fill, minmax(300px, 1fr)); ga<configured-path>16px; }
  .tut-card { displa<configured-path>flex; flex-directio<configured-path>column; ga<configured-path>8px; paddin<configured-path>20px; backgroun<configured-path>var(--surface); borde<configured-path>1px solid var(--border);
    border-radiu<configured-path>18px; text-decoratio<configured-path>none; colo<configured-path>inherit; box-shado<configured-path>var(--shadow-card);
    transitio<configured-path>transform .22s cubic-bezier(.16,1,.3,1), box-shadow .22s ease, border-color .22s ease; }
  .tut-card:hover { transfor<configured-path>translateY(-3px); box-shado<configured-path>var(--shadow-pop); border-colo<configured-path>var(--border-strong); }
  .tc-eyebrow { displa<configured-path>inline-flex; align-sel<configured-path>flex-start; paddin<configured-path>4px 10px; border-radiu<configured-path>999px;
    backgroun<configured-path>color-mix(in srgb, var(--accent-1) 12%, transparent); colo<configured-path>var(--accent-1); font-siz<configured-path>11px; font-weigh<configured-path>700; letter-spacin<configured-path>.02em; }
  .tc-title { font-weigh<configured-path>750; font-siz<configured-path>17px; letter-spacin<configured-path>-.02em; line-heigh<configured-path>1.25; }
  .tc-sub { font-siz<configured-path>13.5px; colo<configured-path>var(--text-2); line-heigh<configured-path>1.45; }
  .tc-meta { displa<configured-path>flex; flex-wra<configured-path>wrap; ga<configured-path>6px; margin-to<configured-path>2px; }
  .chip { displa<configured-path>inline-flex; align-item<configured-path>center; paddin<configured-path>3px 10px; backgroun<configured-path>var(--surface-2); borde<configured-path>1px solid var(--border);
    border-radiu<configured-path>999px; font-siz<configured-path>11.5px; colo<configured-path>var(--text-3); font-weigh<configured-path>600; }
  .tc-progress { displa<configured-path>flex; align-item<configured-path>center; ga<configured-path>10px; margin-to<configured-path>6px; }
  .tc-bar { fle<configured-path>1; heigh<configured-path>6px; border-radiu<configured-path>999px; backgroun<configured-path>var(--ring-track); overflo<configured-path>hidden; }
  .tc-fill { displa<configured-path>block; heigh<configured-path>100%; widt<configured-path>0; border-radiu<configured-path>999px; backgroun<configured-path>var(--accent-grad); transitio<configured-path>width .5s cubic-bezier(.16,1,.3,1); }
  .tc-count { font-siz<configured-path>11.5px; font-weigh<configured-path>700; colo<configured-path>var(--text-3); font-variant-numeri<configured-path>tabular-nums; white-spac<configured-path>nowrap; }
  .empty { colo<configured-path>var(--text-3); }
  @media (prefers-reduced-motio<configured-path>reduce) { * { animation-duratio<configured-path>.001ms !important; transition-duratio<configured-path>.001ms !important; } }
</style>
</head>
<body>
<header class="topbar">
  <div class="brand">
    <span class="logo" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg></span>
    <span>Learn <small style="color:var(--text-3);font-weight:500">· all tutorials</small></span>
  </div>
  <div class="theme-toggle" role="group" aria-label="Color theme">
    <button data-set="light" title="Light" aria-label="Light theme" aria-pressed="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg></button>
    <button data-set="dark" title="Dark" aria-label="Dark theme" aria-pressed="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/></svg></button>
    <button data-set="system" title="System" aria-label="System theme" aria-pressed="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg></button>
  </div>
</header>
<div class="wrap">
  <h1>Tutorials</h1>
  <p class="sub">Interactive, offline-ready tutorial pages. Progress is saved in this browser.</p>
${groups}
${empty}
</div>
<script>
(function () {
  "use strict";
  var mql = window.matchMedia('(prefers-color-schem<configured-path>dark)');
  function currentPref() { return localStorage.getItem('tutorial-theme') || 'system'; }
  function applyTheme(pref) {
    var resolved = pref === 'system' ? (mql.matches ? 'dark' : 'light') : pref;
    document.documentElement.setAttribute('data-theme', resolved);
    document.querySelectorAll('.theme-toggle button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.set === pref));
    });
  }
  document.querySelectorAll('.theme-toggle button').forEach(function (b) {
    b.addEventListener('click', function () { localStorage.setItem('tutorial-theme', b.dataset.set); applyTheme(b.dataset.set); });
  });
  mql.addEventListener('change', function () { if (currentPref() === 'system') applyTheme('system'); });
  applyTheme(currentPref());

  // Per-tutorial progress read from localStorage at view time.
  document.querySelectorAll('.tut-card').forEach(function (card) {
    var slug = card.dataset.slug;
    var sections = [];
    try { sections = JSON.parse(card.dataset.sections || '[]'); } catch (e) {}
    if (!sections.length) { card.querySelector('.tc-progress').style.display = 'none'; return; }
    var done = sections.filter(function (s) {
      return localStorage.getItem('tutorial-progress:' + slug + ':' + s) === '1';
    }).length;
    card.querySelector('.tc-fill').style.width = Math.round((done / sections.length) * 100) + '%';
    card.querySelector('.tc-count').textContent = done + '/' + sections.length;
  });
})();
</script>
</body>
</html>
`;
  writeFileSync(join(root, "index.html"), html, "utf8");
  console.log(`[compile] index regenerate<configured-path>${join(root, "index.html")} (${tutorials.length} tutorial${tutorials.length === 1 ? "" : "s"})`);
}

/* ---------------- main ---------------- */

/* ---------------- authoring budget checks (warn only) ---------------- */

function countWords(text) {
  return (text || "").trim().split(/\s+/).filter(Boolean).length;
}

function sectionProseWords(section) {
  let words = 0;
  for (const block of section.blocks) {
    if (block.kind === "p") words += countWords(block.text);
    else if (block.kind === "callout") words += countWords(block.body);
    else if (block.kind === "recap") words += block.bullets.reduce((sum, b) => sum + countWords(b), 0);
    else if (block.kind === "reveal") words += countWords(block.question) + countWords(block.body);
  }
  return words;
}

function lintAuthoring(meta, sections, format) {
  const warn = (message) => console.warn(`[compile] WARNIN<configured-path>${message}`);
  for (const section of sections) {
    if (section.title.length > TITLE_MAX_CHARS) {
      warn(`${section.slug}: title is ${section.title.length} chars (max ${TITLE_MAX_CHARS}) — it will wrap in the contents rail`);
    }
    const words = sectionProseWords(section);
    if (words > format.words) {
      warn(`${section.slug}: ${words} prose words (forma<configured-path>${meta.format} budget is ${format.words})`);
    }
    if (!format.reveals && section.blocks.some((b) => b.kind === "reveal")) {
      warn(`${section.slug}: :::reveal is not used in forma<configured-path>${meta.format}`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const sourceArg = args.find((a) => !a.startsWith("--"));
  if (!sourceArg) fail("usag<configured-path>node compile.js <source.md> [--out <dir>] [--no-index]");
  const outFlag = args.indexOf("--out");
  const outDir = outFlag >= 0 ? resolve(args[outFlag + 1]) : null;
  const skipIndex = args.includes("--no-index");

  const sourcePath = resolve(sourceArg);
  if (!existsSync(sourcePath)) fail(`source not foun<configured-path>${sourcePath}`);
  const raw = readFileSync(sourcePath, "utf8");
  const { meta, sections, quiz } = parseSource(raw);

  if (meta.type === "code-showcase" && quiz) fail("code-showcase tutorials must not contain a quiz");
  const format = FORMATS[meta.format];
  if (!format.quiz && quiz) fail(`forma<configured-path>${meta.format} must not contain a quiz`);
  if (format.quiz && meta.type === "topic" && !quiz) console.warn("[compile] WARNIN<configured-path>topic tutorial has no quiz (expected one)");
  lintAuthoring(meta, sections, format);

  // collect languages for shiki
  const langs = [];
  for (const section of sections) {
    for (const block of section.blocks) {
      if (block.kind === "code" || block.kind === "annotated-code") langs.push(block.lang);
      if (block.kind === "walkthrough") langs.push(block.code.lang);
      if (block.kind === "playground") langs.push("css");
    }
  }
  await initHighlighter(langs);

  const readMin = estimateReadMinutes(sections);
  const typeLabel = meta.type === "code-showcase" ? "Code showcase" : "Topic tutorial";
  const sectionHtml = [];
  for (let i = 0; i < sections.length; i++) sectionHtml.push(await renderSection(sections[i], i));

  const glossary = {};
  for (const [key, def] of Object.entries(meta.glossary || {})) {
    glossary[key] = { ter<configured-path>key.charAt(0).toUpperCase() + key.slice(1), de<configured-path>renderInline(def) };
  }

  const indexMeta = {
    titl<configured-path>meta.title,
    subtitl<configured-path>meta.subtitle || "",
    typ<configured-path>meta.type,
    categor<configured-path>meta.category,
    slu<configured-path>meta.slug,
    dat<configured-path>String(meta.date),
    readMin,
    section<configured-path>sections.map((s) => ({ slu<configured-path>s.slug, titl<configured-path>s.title })),
  };
  const metaComment = `<!--tutorial-meta ${JSON.stringify(indexMeta).replace(/--/g, "-\\u002d")}-->`;

  const countWord = sections.length <= 10 ? NUMBER_WORDS[sections.length] : String(sections.length);

  let html = readFileSync(TEMPLATE_PATH, "utf8");
  const replacements = {
    "{{META_COMMENT}}": metaComment,
    "{{TITLE}}": escapeHtml(meta.title),
    "{{SUBTITLE}}": renderInline(meta.subtitle || ""),
    "{{BRAND_SMALL}}": meta.track ? ` <small>· ${escapeHtml(meta.track)}</small>` : "",
    "{{TYPE_LABEL}}": typeLabel,
    "{{TYPE_LABEL_LOWER}}": typeLabel.toLowerCase(),
    "{{DATE}}": escapeHtml(String(meta.date)),
    "{{READ_MIN}}": String(readMin),
    "{{SECTION_COUNT}}": String(sections.length),
    "{{SECTION_COUNT_WORD}}": countWord,
    "{{SLUG}}": meta.slug,
    "{{TOC_ITEMS}}": renderTocItems(sections),
    "{{VIDEOS}}": renderVideos(meta.videos),
    "{{SECTIONS}}": sectionHtml.join("\n"),
    "{{REFERENCES}}": renderReferences(meta.references),
    "{{QUIZ}}": meta.type === "topic" ? renderQuiz(quiz) : "",
    "{{GLOSSARY_JSON}}": JSON.stringify(glossary, null, 2),
    "{{SLUGS_JSON}}": JSON.stringify(sections.map((s) => s.slug)),
  };
  for (const [key, value] of Object.entries(replacements)) {
    html = html.split(key).join(value);
  }

  const leftover = html.match(/\{\{[A-Z_]+\}\}/);
  if (leftover) fail(`unfilled template placeholde<configured-path>${leftover[0]}`);

  const targetDir = outDir || dirname(sourcePath);
  mkdirSync(targetDir, { recursiv<configured-path>true });
  const outPath = join(targetDir, `${meta.slug}.html`);
  writeFileSync(outPath, html, "utf8");
  console.log(`[compile] wrote ${outPath}`);

  if (!skipIndex) generateIndex(TUTORIALS_ROOT);
}

main().catch((error) => {
  console.error(`[compile] ERRO<configured-path>${error.stack || error.message}`);
  process.exit(1);
});

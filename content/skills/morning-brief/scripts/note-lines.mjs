// Reads a vault note line by line, as the Alfred control center finds a task: a list line by its text without marker
// and checkbox, a heading by its text, and the lines nested under a list line by their indentation.
const LIST_LINE = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[(.)\]\s+)?(.*\S)\s*$/;
const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])(?:\s+|$)/;
const EMPTY_CHECKBOX = /^\[(.)\]$/;
const HEADING = /^(#{1,6})\s+(.*\S)\s*$/;
const FRONTMATTER_FENCE = /^---\s*$/;
// Obsidian's default tab width: a tab indents to the next multiple of it.
const TAB_COLUMNS = 4;

function columnsOf(line) {
  let columns = 0;
  for (const character of line.match(/^\s*/)[0]) columns = character === '\t' ? columns + TAB_COLUMNS - (columns % TAB_COLUMNS) : columns + 1;
  return columns;
}

// Each line of the note as `blank` (frontmatter included), `heading` (`level`, `text` as written), `text` or `list`
// (`indent` in columns and `content`, a list line's without its marker but with its checkbox). A list line also has
// `box`, the character between its brackets or null, and `text`, empty for a bare marker or checkbox.
export function readNote(noteText) {
  const lines = noteText.replace(/^﻿/, '').split(/\r?\n/);
  const frontmatterEnd = FRONTMATTER_FENCE.test(lines[0]) ? lines.findIndex((line, index) => index > 0 && FRONTMATTER_FENCE.test(line)) : -1;
  return lines.map((line, index) => {
    if (index <= frontmatterEnd || !line.trim()) return { kind: 'blank' };
    const heading = HEADING.exec(line);
    if (heading) return { kind: 'heading', level: heading[1].length, text: heading[2] };
    const indent = columnsOf(line);
    if (!LIST_MARKER.test(line)) return { kind: 'text', indent, content: line.trim() };
    const content = line.replace(LIST_MARKER, '').trim();
    const [, box = null, text = ''] = LIST_LINE.exec(line) ?? [];
    const emptyBox = box === null ? EMPTY_CHECKBOX.exec(text)?.[1] : undefined;
    return emptyBox === undefined ? { kind: 'list', indent, content, box, text } : { kind: 'list', indent, content, box: emptyBox, text: '' };
  });
}

// The non-blank lines indented deeper than the list line at `index`, up to the next line indented as far or less,
// each with its `depth` below that line (1 for a direct child) and its `content`. A bare list marker shows nothing.
export function nestedLines(entries, index) {
  const parentIndents = [entries[index].indent];
  const nested = [];
  for (const entry of entries.slice(index + 1)) {
    if (entry.kind === 'blank') continue;
    if (entry.kind === 'heading' || entry.indent <= parentIndents[0]) break;
    while (parentIndents.at(-1) >= entry.indent) parentIndents.pop();
    if (entry.content) nested.push({ depth: parentIndents.length, text: entry.content });
    parentIndents.push(entry.indent);
  }
  return nested;
}

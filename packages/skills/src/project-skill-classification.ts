const MAX_PROJECT_SKILL_FRONTMATTER_BYTES = 64 * 1024;

function ambiguous(): never {
  throw new Error('project skill metadata ownership is ambiguous');
}

function quotedToken(text: string): { value: string; length: number } {
  const quote = text[0];
  for (let index = 1; index < text.length; index += 1) {
    if (quote === '"' && text[index] === '\\') {
      index += 1;
      continue;
    }
    if (text[index] !== quote) {
      continue;
    }
    if (quote === "'" && text[index + 1] === "'") {
      index += 1;
      continue;
    }
    const token = text.slice(0, index + 1);
    try {
      return {
        value:
          quote === '"' ? (JSON.parse(token) as string) : token.slice(1, -1).replaceAll("''", "'"),
        length: token.length,
      };
    } catch {
      return ambiguous();
    }
  }
  return ambiguous();
}

function mappingEntry(text: string): { key: string; value: string } {
  if (text.startsWith('"') || text.startsWith("'")) {
    const token = quotedToken(text);
    const remainder = text.slice(token.length).trimStart();
    if (!remainder.startsWith(':')) {
      return ambiguous();
    }
    return { key: token.value, value: remainder.slice(1).trimStart() };
  }
  const match = /^([^\s:[\]{},&*!?]+)\s*:(?:\s|$)([\s\S]*)$/u.exec(text);
  if (!match) {
    return ambiguous();
  }
  return { key: match[1]!, value: match[2]!.trimStart() };
}

function flowMetadata(text: string): number | 'managed' {
  let remaining = text.slice(1).trimStart();
  const keys = new Set<string>();
  while (remaining && !remaining.startsWith('}')) {
    if (remaining.startsWith('#')) {
      const newline = remaining.indexOf('\n');
      if (newline < 0) {
        return ambiguous();
      }
      remaining = remaining.slice(newline + 1).trimStart();
      continue;
    }
    const entry = mappingEntry(remaining);
    if (entry.key === 'mpx') {
      return 'managed';
    }
    if (entry.key === '<<' || keys.has(entry.key)) {
      return ambiguous();
    }
    keys.add(entry.key);
    remaining = entry.value;
    const stack: string[] = [];
    let index = 0;
    for (; index < remaining.length; index += 1) {
      const character = remaining[index]!;
      if (character === '"' || character === "'") {
        index += quotedToken(remaining.slice(index)).length - 1;
      } else if (character === '#' && (index === 0 || /\s/u.test(remaining[index - 1]!))) {
        const newline = remaining.indexOf('\n', index);
        if (newline < 0) {
          return ambiguous();
        }
        index = newline;
      } else if (character === '{' || character === '[') {
        stack.push(character === '{' ? '}' : ']');
      } else if (character === '}' || character === ']') {
        if (stack.length === 0) {
          if (character !== '}') {
            return ambiguous();
          }
          break;
        }
        if (stack.pop() !== character) {
          return ambiguous();
        }
      } else if (character === ',' && stack.length === 0) {
        break;
      } else if (
        character === ':' &&
        stack.length === 0 &&
        /[\s{[]/u.test(remaining[index + 1] ?? '')
      ) {
        return ambiguous();
      }
    }
    if (stack.length || index === remaining.length) {
      return ambiguous();
    }
    remaining = remaining.slice(index);
    if (remaining.startsWith(',')) {
      remaining = remaining.slice(1).trimStart();
    }
  }
  if (!/^\}[ \t]*(?:#[^\n]*)?(?:\n|$)/u.test(remaining)) {
    return ambiguous();
  }
  const closingOffset = text.length - remaining.length + 1;
  return text.slice(0, closingOffset).split('\n').length - 1;
}

export function classifyProjectSkill(text: string): 'managed' | 'native' {
  const normalized = text.replace(/^\uFEFF/u, '');
  const opening = /^---[ \t]*\r?\n/u.exec(normalized);
  if (!opening) {
    return ambiguous();
  }
  const bounded = normalized.slice(opening[0].length, MAX_PROJECT_SKILL_FRONTMATTER_BYTES);
  const closing = /^---[ \t]*\r?$/mu.exec(bounded);
  if (!closing) {
    return ambiguous();
  }
  const header = bounded.slice(0, closing.index);
  if (Buffer.byteLength(header, 'utf8') > MAX_PROJECT_SKILL_FRONTMATTER_BYTES) {
    return ambiguous();
  }
  const lines = header.split(/\r?\n/u);
  let rootIndent: number | undefined;
  let metadata = false;
  let rootScalar = false;
  let metadataScalar = false;
  let metadataSeen = false;
  let metadataIndent: number | undefined;
  let metadataChildContainer = false;
  let scalarIndent: number | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim() || line.trimStart().startsWith('#')) {
      continue;
    }
    const indentation = /^\s*/u.exec(line)![0];
    if (indentation.includes('\t')) {
      return ambiguous();
    }
    const indent = indentation.length;
    if (scalarIndent !== undefined && indent > scalarIndent) {
      continue;
    }
    scalarIndent = undefined;
    rootIndent ??= indent;
    if (indent < rootIndent) {
      return ambiguous();
    }
    if (indent === rootIndent) {
      metadata = false;
      metadataScalar = false;
      metadataIndent = undefined;
    } else if (metadataScalar) {
      return ambiguous();
    } else if (!metadata) {
      if (rootScalar) {
        return ambiguous();
      }
      continue;
    } else {
      metadataIndent ??= indent;
      if (indent < metadataIndent) {
        return ambiguous();
      }
      if (indent > metadataIndent) {
        if (!metadataChildContainer) {
          return ambiguous();
        }
        continue;
      }
    }
    const entry = mappingEntry(line.trimStart());
    if (indent === rootIndent) {
      rootScalar = Boolean(entry.value) && !entry.value.startsWith('#');
    }
    if (entry.key === '<<') {
      return ambiguous();
    }
    if (metadata && entry.key === 'mpx') {
      return 'managed';
    }
    if (metadata) {
      metadataChildContainer = !entry.value || entry.value.startsWith('#');
    }
    if (/^[|>](?:[1-9][+-]?|[+-][1-9]?)?(?:\s*(?:#.*)?)$/u.test(entry.value)) {
      scalarIndent = indent;
    }
    if (indent !== rootIndent || entry.key !== 'metadata') {
      continue;
    }
    if (metadataSeen) {
      return ambiguous();
    }
    metadataSeen = true;
    if (/^[&*!]/u.test(entry.value)) {
      return ambiguous();
    }
    if (entry.value.startsWith('{')) {
      const flow = flowMetadata([entry.value, ...lines.slice(index + 1)].join('\n').trimEnd());
      if (flow === 'managed') {
        return 'managed';
      }
      index += flow;
      metadataScalar = true;
      continue;
    }
    metadata = !entry.value || entry.value.startsWith('#');
    metadataScalar = !metadata && scalarIndent === undefined;
  }
  return 'native';
}

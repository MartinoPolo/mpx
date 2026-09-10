export type SkillNamespace = 'mpx' | 'skill';

export interface CursorSkillReference {
  readonly namespace: SkillNamespace;
  readonly prefix: string;
  readonly partial: string;
  readonly startColumn: number;
  readonly endColumn: number;
}

export interface SubmittedSkillReference {
  readonly namespace: SkillNamespace;
  readonly identity: string;
  readonly start: number;
  readonly end: number;
}

export type AcceptedSkillReferences = Readonly<Record<SkillNamespace, ReadonlySet<string>>>;

const namePattern = '[a-z0-9]+(?:-[a-z0-9]+)*';

export function findSkillReferenceAtCursor(
  lines: readonly string[],
  line: number,
  column: number,
): CursorSkillReference | undefined {
  const beforeCursor = (lines[line] ?? '').slice(0, column);
  const match = beforeCursor.match(/(?:^|\s)\/(mpx|skill):([a-z0-9-]*)$/u);
  if (!match) {
    return undefined;
  }
  const namespace = match[1] as SkillNamespace;
  const partial = match[2] ?? '';
  const prefix = `/${namespace}:${partial}`;
  const startColumn = column - prefix.length;
  const suffix = (lines[line] ?? '').slice(column).match(/^[a-z0-9-]*/u)?.[0] ?? '';
  return { namespace, prefix, partial, startColumn, endColumn: column + suffix.length };
}

export function findSubmittedSkillReferences(
  text: string,
  accepted: AcceptedSkillReferences,
): SubmittedSkillReference[] {
  const masked = maskLiteralRegions(text);
  const pattern = new RegExp(`(^|\\s)/(mpx|skill):(${namePattern})(?=$|[\\s.,;:!?()[\\]{}])`, 'gu');
  const found: SubmittedSkillReference[] = [];
  for (const match of masked.matchAll(pattern)) {
    const namespace = match[2] as SkillNamespace;
    const identity = match[3]!;
    if (!accepted[namespace].has(identity)) {
      continue;
    }
    const start = match.index + match[1]!.length;
    found.push({
      namespace,
      identity,
      start,
      end: start + `/${namespace}:${identity}`.length,
    });
  }
  return found;
}

function maskLiteralRegions(text: string): string {
  const chars = text.split('');
  let fence: { character: '`' | '~'; length: number } | undefined;
  let inlineDelimiter = 0;
  let quote: '"' | "'" | '”' | undefined;
  let lineStart = 0;

  for (let index = 0; index < chars.length; index += 1) {
    if (index === lineStart && chars[index] !== '\n') {
      const lineEnd = text.indexOf('\n', lineStart);
      const end = lineEnd === -1 ? text.length : lineEnd;
      const line = text.slice(lineStart, end);
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
      const closesFence =
        fence &&
        marker?.[0] === fence.character &&
        marker.length >= fence.length &&
        line.slice(line.indexOf(marker) + marker.length).trim().length === 0;
      if ((!fence && marker) || closesFence) {
        if (!fence) {
          fence = { character: marker![0] as '`' | '~', length: marker!.length };
        } else {
          fence = undefined;
        }
        for (let offset = lineStart; offset < end; offset += 1) {
          chars[offset] = ' ';
        }
        index = end - 1;
        continue;
      }
      if (fence) {
        for (let offset = lineStart; offset < end; offset += 1) {
          chars[offset] = ' ';
        }
        index = end - 1;
        continue;
      }
    }

    const character = chars[index]!;
    if (character === '\n') {
      lineStart = index + 1;
      inlineDelimiter = 0;
      quote = undefined;
      continue;
    }
    if (character === '`') {
      let length = 1;
      while (chars[index + length] === '`') {
        length += 1;
      }
      if (inlineDelimiter === 0 || inlineDelimiter === length) {
        inlineDelimiter = inlineDelimiter === 0 ? length : 0;
      }
      for (let offset = index; offset < index + length; offset += 1) {
        chars[offset] = ' ';
      }
      index += length - 1;
      continue;
    }
    if (inlineDelimiter > 0) {
      chars[index] = ' ';
      continue;
    }
    if (quote) {
      chars[index] = ' ';
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === '“') {
      quote = character === '“' ? '”' : '"';
      chars[index] = ' ';
      continue;
    }
    if (character === "'") {
      const previous = chars[index - 1];
      const next = chars[index + 1];
      if (!(previous && next && /[a-z0-9]/iu.test(previous) && /[a-z0-9]/iu.test(next))) {
        quote = "'";
        chars[index] = ' ';
        continue;
      }
    }
    if (character === '\\' && chars[index + 1] === '/') {
      chars[index] = chars[index + 1] = ' ';
      index += 1;
    }
  }
  return chars.join('');
}

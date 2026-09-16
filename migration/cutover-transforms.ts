import { isDeepStrictEqual } from 'node:util';

export function parseConfigurationJson(source: string): unknown {
  let cleaned = '';
  let inString = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (inString) {
      cleaned += character;
      if (character === '\\') cleaned += source[++index] ?? '';
      else if (character === '"') inString = false;
    } else if (character === '"') {
      inString = true;
      cleaned += character;
    } else if (character === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      cleaned += '\n';
    } else if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) throw new Error('Unterminated JSON comment');
      cleaned += ' ';
      index = end + 1;
    } else cleaned += character;
  }
  let normalized = '';
  inString = false;
  for (let index = 0; index < cleaned.length; index += 1) {
    const character = cleaned[index]!;
    if (inString) {
      normalized += character;
      if (character === '\\') normalized += cleaned[++index] ?? '';
      else if (character === '"') inString = false;
    } else {
      if (character === '"') inString = true;
      if (character === ',' && /^\s*[}\]]/.test(cleaned.slice(index + 1))) continue;
      normalized += character;
    }
  }
  return JSON.parse(normalized.replace(/^\uFEFF/, ''));
}

export function upgradeStatusLine(existing: unknown, expected: Record<string, string>, script: string): Record<string, string> {
  const legacy = ['.claude', '.claude-work'].map(directory => ({ type: 'command', command: `node "$HOME/${directory}/scripts/${script}"` }));
  if (!isDeepStrictEqual(existing, expected) && !legacy.some(entry => isDeepStrictEqual(entry, existing))) {
    throw new Error('Status line ownership changed');
  }
  return expected;
}

export function optionalConfigurationArray(value: unknown, name: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Invalid ${name}: expected an array`);
  return value;
}

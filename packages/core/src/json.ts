import { createHash } from 'node:crypto';

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const dangerousKeys = new Set(['__proto__', 'prototype', 'constructor']);

export function parseStrictJson(input: string): JsonValue {
  let position = 0;
  const fail = (message: string): never => {
    throw new SyntaxError(`${message} at position ${position}`);
  };
  const whitespace = () => {
    while (/[\u0009\u000a\u000d\u0020]/u.test(input[position] ?? '')) {
      position++;
    }
  };
  const parseString = (): string => {
    if (input[position++] !== '"') {
      fail('Expected string');
    }
    let result = '';
    while (position < input.length) {
      const character = input[position++];
      if (character === '"') {
        return result;
      }
      if (character === undefined || character.charCodeAt(0) < 0x20) {
        fail('Invalid character in string');
      }
      if (character !== '\\') {
        result += character;
        continue;
      }
      const escape = input[position++];
      const simple: Record<string, string> = {
        '"': '"',
        '\\': '\\',
        '/': '/',
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t',
      };
      if (escape !== undefined && escape in simple) {
        result += simple[escape];
        continue;
      }
      if (escape !== 'u') {
        fail('Invalid escape');
      }
      const hex = input.slice(position, position + 4);
      if (!/^[0-9a-fA-F]{4}$/u.test(hex)) {
        fail('Invalid unicode escape');
      }
      result += String.fromCharCode(Number.parseInt(hex, 16));
      position += 4;
    }
    return fail('Unterminated string');
  };
  const value = (): JsonValue => {
    whitespace();
    const character = input[position];
    if (character === '"') {
      return parseString();
    }
    if (character === '[') {
      position++;
      whitespace();
      const array: JsonValue[] = [];
      if (input[position] === ']') {
        position++;
        return array;
      }
      while (true) {
        array.push(value());
        whitespace();
        if (input[position] === ']') {
          position++;
          return array;
        }
        if (input[position++] !== ',') {
          fail('Expected comma');
        }
      }
    }
    if (character === '{') {
      position++;
      whitespace();
      const object: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
      const keys = new Set<string>();
      if (input[position] === '}') {
        position++;
        return object;
      }
      while (true) {
        whitespace();
        if (input[position] !== '"') {
          fail('Expected object key');
        }
        const key = parseString();
        if (dangerousKeys.has(key)) {
          fail('Dangerous object key');
        }
        if (keys.has(key)) {
          fail('Duplicate object key');
        }
        keys.add(key);
        whitespace();
        if (input[position++] !== ':') {
          fail('Expected colon');
        }
        object[key] = value();
        whitespace();
        if (input[position] === '}') {
          position++;
          return object;
        }
        if (input[position++] !== ',') {
          fail('Expected comma');
        }
      }
    }
    for (const [token, result] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (input.startsWith(token, position)) {
        position += token.length;
        return result;
      }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(input.slice(position));
    if (match) {
      position += match[0].length;
      const number = Number(match[0]);
      if (!Number.isFinite(number)) {
        fail('Number is outside JSON range');
      }
      return number;
    }
    return fail('Expected JSON value');
  };
  const result = value();
  whitespace();
  if (position !== input.length) {
    fail('Unexpected trailing content');
  }
  return result;
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Canonical JSON requires finite numbers');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(',')}}`;
}

export function sha256Canonical(value: JsonValue): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

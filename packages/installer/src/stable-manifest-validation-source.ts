// The installed entry cannot import workspace modules; parity tests bind this standalone parser to immutable-core fixtures.
export const STANDALONE_RELEASE_MANIFEST_VALIDATION_SOURCE = String.raw`
const manifestValidation = (() => {
  const sha = /^[a-f0-9]{64}$/u;
  const dangerousKeys = new Set(['__proto__', 'prototype', 'constructor']);

  function parseStrictJson(input) {
    let position = 0;
    const failJson = (message) => {
      throw new SyntaxError(message + ' at position ' + position);
    };
    const whitespace = () => {
      while (/[\u0009\u000a\u000d\u0020]/u.test(input[position] ?? '')) position++;
    };
    const parseString = () => {
      if (input[position++] !== '"') failJson('Expected string');
      let result = '';
      while (position < input.length) {
        const character = input[position++];
        if (character === '"') return result;
        if (character === undefined || character.charCodeAt(0) < 0x20) failJson('Invalid character in string');
        if (character !== '\\') {
          result += character;
          continue;
        }
        const escape = input[position++];
        const simple = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (escape !== undefined && Object.prototype.hasOwnProperty.call(simple, escape)) {
          result += simple[escape];
          continue;
        }
        if (escape !== 'u') failJson('Invalid escape');
        const hex = input.slice(position, position + 4);
        if (!/^[0-9a-fA-F]{4}$/u.test(hex)) failJson('Invalid unicode escape');
        result += String.fromCharCode(Number.parseInt(hex, 16));
        position += 4;
      }
      return failJson('Unterminated string');
    };
    const parseValue = () => {
      whitespace();
      const character = input[position];
      if (character === '"') return parseString();
      if (character === '[') {
        position++;
        whitespace();
        const array = [];
        if (input[position] === ']') {
          position++;
          return array;
        }
        while (true) {
          array.push(parseValue());
          whitespace();
          if (input[position] === ']') {
            position++;
            return array;
          }
          if (input[position++] !== ',') failJson('Expected comma');
        }
      }
      if (character === '{') {
        position++;
        whitespace();
        const object = Object.create(null);
        const keys = new Set();
        if (input[position] === '}') {
          position++;
          return object;
        }
        while (true) {
          whitespace();
          if (input[position] !== '"') failJson('Expected object key');
          const key = parseString();
          if (dangerousKeys.has(key)) failJson('Dangerous object key');
          if (keys.has(key)) failJson('Duplicate object key');
          keys.add(key);
          whitespace();
          if (input[position++] !== ':') failJson('Expected colon');
          object[key] = parseValue();
          whitespace();
          if (input[position] === '}') {
            position++;
            return object;
          }
          if (input[position++] !== ',') failJson('Expected comma');
        }
      }
      for (const [token, result] of [['true', true], ['false', false], ['null', null]]) {
        if (input.startsWith(token, position)) {
          position += token.length;
          return result;
        }
      }
      const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(input.slice(position));
      if (match) {
        position += match[0].length;
        const number = Number(match[0]);
        if (!Number.isFinite(number)) failJson('Number is outside JSON range');
        return number;
      }
      return failJson('Expected JSON value');
    };
    const result = parseValue();
    whitespace();
    if (position !== input.length) failJson('Unexpected trailing content');
    return result;
  }

  function canonicalJson(value) {
    return JSON.stringify(value, (_key, item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
        : item,
    );
  }

  function exact(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid manifest object');
    if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) throw new Error('Invalid manifest fields');
    return value;
  }

  function safeRelative(value) {
    if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || value.startsWith('/')) return false;
    return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
  }

  function parseFile(value) {
    const file = exact(value, ['path', 'bytes', 'sha256']);
    if (!safeRelative(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || typeof file.sha256 !== 'string' || !sha.test(file.sha256)) throw new Error('Invalid release file');
    return file;
  }

  function parseReleaseManifest(value) {
    const manifest = exact(value, ['schemaVersion', 'kind', 'releaseKey', 'convergenceHash', 'files']);
    if (manifest.schemaVersion !== 1 || manifest.kind !== 'release-manifest' || typeof manifest.releaseKey !== 'string' || !sha.test(manifest.releaseKey) || typeof manifest.convergenceHash !== 'string' || !sha.test(manifest.convergenceHash) || !Array.isArray(manifest.files)) throw new Error('Invalid release manifest');
    const files = manifest.files.map(parseFile);
    if (new Set(files.map((file) => file.path)).size !== files.length || files.some((file, index) => index > 0 && files[index - 1].path >= file.path)) throw new Error('Release files must be unique and sorted');
    return { schemaVersion: 1, kind: 'release-manifest', releaseKey: manifest.releaseKey, convergenceHash: manifest.convergenceHash, files };
  }

  return Object.freeze({ parseStrictJson, canonicalJson, parseReleaseManifest });
})();
`;

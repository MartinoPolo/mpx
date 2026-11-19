#!/usr/bin/env node
// The id of a daily brief item: its kind and a hash of its source reference (thread id, permalink, note path and
// line text, pull request address with its state, bookmark id), so a rebuilt document keeps the ids the app's decisions name.
// Usage: brief-id.mjs <kind> <reference part>...
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const HASH_LENGTH = 12;

export function briefItemId(kind, ...referenceParts) {
  const hash = createHash('sha256').update([kind, ...referenceParts].join('\n')).digest('hex');
  return `${kind}-${hash.slice(0, HASH_LENGTH)}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [kind, ...referenceParts] = process.argv.slice(2);
  if (!kind || referenceParts.length === 0) {
    console.error('Usage: brief-id.mjs <kind> <reference part>...');
    process.exit(1);
  }
  console.log(briefItemId(kind, ...referenceParts));
}

#!/usr/bin/env node
// Reads the AI news sources of news-sources.json without a model and writes <day>/sources/news.json: the candidates
// published in the window of <day>/start.json, newest first and capped per source (the Hacker News front page cut to
// AI titles, by score), and every source as read, dead (with the status or error) or not read (with the reason). A
// source that refuses is recorded as dead and never retried another way. Exit code 2 when a source is dead.
// Usage: news.mjs <day-directory> [--sources <news-sources.json>]
import { readFile, rename, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { NEWS_FILE } from './document-narration.mjs';

const USER_AGENT = 'mpx-morning-brief (daily AI news digest)';
const MAXIMUM_REDIRECTS = 3;
const HACKER_NEWS_ITEM ='https://news.ycombinator.com/item?id=';
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

const { positionals, values } = parseArgs({ allowPositionals: true, options: { sources: { type: 'string' } } });
const [dayDirectory] = positionals;
if (!dayDirectory || !isAbsolute(dayDirectory)) {
  console.error('Usage: news.mjs <absolute day directory> [--sources <news-sources.json>]');
  process.exit(1);
}
const sourcesPath = values.sources ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'news-sources.json');
const settings = JSON.parse(await readFile(sourcesPath, 'utf8'));
let start;
try {
  start = JSON.parse((await readFile(join(dayDirectory, 'start.json'), 'utf8')).replace(/^﻿/, ''));
} catch {
  console.error(`${dayDirectory} has no start.json; run start.mjs first.`);
  process.exit(1);
}
const windowStart = Date.parse(start.since);
const windowEnd = Date.parse(start.until);
const timeoutMilliseconds = settings.timeoutSeconds * 1000;
const keywordPattern = new RegExp(`\\b(?:${settings.aiKeywords.map((keyword) => keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name) => {
    if (name[0] === '#') return String.fromCodePoint(name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1)));
    return ENTITIES[name.toLowerCase()] ?? entity;
  });
}

// An element's text without markup: CDATA is taken as written, escaped markup is unescaped before its tags go.
function plainText(raw) {
  const markup = raw.includes('<![CDATA[') ? raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1') : decodeEntities(raw);
  return decodeEntities(markup.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function firstElement(block, names) {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
    if (match) return plainText(match[1]);
  }
  return '';
}

// Atom names the page in an alternate link's href, RSS in the link element's text.
function entryLink(block) {
  const atomLinks = [...block.matchAll(/<link\b([^>]*?)\/?>/g)].map(([, attributes]) => attributes);
  const alternate = atomLinks.find((attributes) => /\bhref=/.test(attributes) && !/\brel="(?!alternate")/.test(attributes));
  const href = alternate?.match(/\bhref="([^"]*)"/)?.[1];
  return href ? decodeEntities(href) : firstElement(block, ['link']);
}

function feedEntries(feedText, source) {
  const blocks = feedText.match(/<(item|entry)\b[^>]*>[\s\S]*?<\/\1>/g) ?? [];
  return blocks.map((block) => {
    const published = Date.parse(firstElement(block, ['pubDate', 'published', 'updated', 'dc:date']));
    return {
      title: firstElement(block, ['title']),
      link: entryLink(block),
      publishedAt: Number.isNaN(published) ? null : new Date(published).toISOString(),
      score: null,
      commentCount: null,
      excerpt: firstElement(block, ['description', 'summary', 'content', 'content:encoded']).slice(0, settings.excerptCharacters),
    };
  }).filter((entry) => !source.excludeTitles || !new RegExp(source.excludeTitles, 'i').test(entry.title));
}

function hackerNewsEntries(answerText) {
  return (JSON.parse(answerText).hits ?? []).map((hit) => ({
    title: String(hit.title ?? '').trim(),
    link: hit.url || `${HACKER_NEWS_ITEM}${hit.objectID}`,
    publishedAt: hit.created_at ? new Date(hit.created_at).toISOString() : null,
    score: Number.isInteger(hit.points) ? hit.points : null,
    commentCount: Number.isInteger(hit.num_comments) ? hit.num_comments : null,
    excerpt: '',
  }));
}

const READERS = { feed: feedEntries, 'hacker-news': hackerNewsEntries };

// The answer's text, following redirects until the deadline. Not fetch: its fixed ten-second connect limit fails
// connections this machine sometimes takes a little longer to open.
function readUrl(url, deadline, redirectsLeft = MAXIMUM_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, { headers: { 'user-agent': USER_AGENT } }, (answer) => {
      const { statusCode, headers } = answer;
      if (statusCode >= 300 && statusCode < 400 && headers.location && redirectsLeft > 0) {
        answer.resume();
        clearTimeout(timer);
        resolve(readUrl(new URL(headers.location, url).href, deadline, redirectsLeft - 1));
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        answer.resume();
        clearTimeout(timer);
        reject(new Error(`HTTP ${statusCode}`));
        return;
      }
      answer.setEncoding('utf8');
      let text = '';
      answer.on('data', (chunk) => { text += chunk; });
      answer.on('end', () => { clearTimeout(timer); resolve(text); });
      answer.on('error', (error) => { clearTimeout(timer); reject(error); });
    });
    const timer = setTimeout(() => request.destroy(new Error(`no answer within ${settings.timeoutSeconds} s`)), Math.max(deadline - Date.now(), 1));
    request.on('error', (error) => { clearTimeout(timer); reject(error.code ? new Error(error.code) : error); });
  });
}

function isInWindow(entry) {
  const published = Date.parse(entry.publishedAt);
  return published >= windowStart && published <= windowEnd;
}

// A release feed titles an entry by its version alone; the source's name makes it a headline.
function headline(entry, source) {
  if (source.kind !== 'release' || entry.title.toLowerCase().includes(source.name.toLowerCase())) return entry.title;
  return `${source.name} ${entry.title.replace(/^release\s+/i, '')}`;
}

async function readSource(source) {
  const listing = { name: source.name, app: source.app, kind: source.kind };
  if (source.waitingFor) return { ...listing, status: 'not-read', reason: source.waitingFor, entries: [] };
  const reader = READERS[source.format];
  if (!reader) return { ...listing, status: 'not-read', reason: `No reader for the ${source.format} format.`, entries: [] };
  let answerText;
  try {
    answerText = await readUrl(source.url, Date.now() + timeoutMilliseconds);
  } catch (error) {
    return { ...listing, status: 'dead', reason: `${error.message} from ${source.url}`, entries: [] };
  }
  let entries;
  try {
    entries = reader(answerText, source);
  } catch (error) {
    return { ...listing, status: 'dead', reason: `unreadable answer from ${source.url}: ${error.message}`, entries: [] };
  }
  if (entries.length === 0) return { ...listing, status: 'dead', reason: `${source.url} lists no entries`, entries: [] };
  const inWindow = entries.filter((entry) => entry.title && URL.canParse(entry.link) && isInWindow(entry))
    .filter((entry) => !source.aiTitlesOnly || keywordPattern.test(entry.title))
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || Date.parse(right.publishedAt) - Date.parse(left.publishedAt))
    .slice(0, source.limit ?? settings.candidatesPerSource)
    .map((entry) => ({ ...entry, title: headline(entry, source) }));
  return { ...listing, status: 'read', reason: null, entries: inWindow };
}

const results = await Promise.all(settings.sources.map(readSource));
const seenLinks = new Set();
const candidates = [];
for (const { name, app, kind, entries } of results) {
  for (const entry of entries) {
    if (seenLinks.has(entry.link)) continue;
    seenLinks.add(entry.link);
    candidates.push({ source: name, app, kind, ...entry });
  }
}
const news = {
  window: { since: start.since, until: start.until },
  sources: results.map(({ name, status, reason, entries }) => ({ name, status, reason, candidateCount: entries.length })),
  candidates,
};
const newsPath = join(dayDirectory, NEWS_FILE);
await writeFile(`${newsPath}.partial`, `${JSON.stringify(news, null, 2)}\n`);
await rename(`${newsPath}.partial`, newsPath);
for (const { name, status, reason, candidateCount } of news.sources) {
  console.log(`${name}: ${status} (${status === 'read' ? `${candidateCount} candidates` : reason})`);
}
console.log(`${candidates.length} candidates, ${JSON.stringify(candidates).length} characters, in ${newsPath}`);
process.exit(news.sources.some((source) => source.status === 'dead') ? 2 : 0);

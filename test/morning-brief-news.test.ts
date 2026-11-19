import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const scriptDirectory = resolve('content/skills/morning-brief/scripts');
const DAY = '2026-11-18';
const APP_DIRECTORY = process.env.MPX_PROJECTS ? join(process.env.MPX_PROJECTS, 'alfred-control-center') : '';
const appSkip = !existsSync(join(APP_DIRECTORY, 'package.json')) && 'the alfred-control-center repository is not checked out';

const RELEASE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Release notes from tool</title>
  <entry>
    <updated>2026-11-17T20:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/example/tool/releases/tag/v1.3.0-alpha.1"/>
    <title>v1.3.0-alpha.1</title>
    <content type="html">&lt;p&gt;Experimental&lt;/p&gt;</content>
  </entry>
  <entry>
    <updated>2026-11-17T18:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/example/tool/releases/tag/v1.2.0"/>
    <title>v1.2.0</title>
    <content type="html">&lt;ul&gt;&lt;li&gt;Hooks run in parallel &amp;amp; start faster&lt;/li&gt;&lt;/ul&gt;</content>
  </entry>
  <entry>
    <updated>2026-11-10T18:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/example/tool/releases/tag/v1.1.0"/>
    <title>v1.1.0</title>
    <content type="html">Older</content>
  </entry>
</feed>`;

const NEWS_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Vendor News</title>
  <item>
    <title><![CDATA[Introducing Model Nine]]></title>
    <description><![CDATA[<p>A faster model for coding agents.</p>]]></description>
    <link>https://vendor.example/news/model-nine</link>
    <pubDate>Tue, 17 Nov 2026 16:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Last week's story</title>
    <link>https://vendor.example/news/old</link>
    <pubDate>Mon, 09 Nov 2026 16:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

const FRONT_PAGE = {
  hits: [
    { objectID: '1', title: 'Show HN: An open agent sandbox', url: 'https://sandbox.example/', points: 412, num_comments: 120, created_at: '2026-11-17T12:00:00Z' },
    { objectID: '2', title: 'A history of the bicycle', url: 'https://bicycle.example/', points: 900, num_comments: 300, created_at: '2026-11-17T13:00:00Z' },
    { objectID: '3', title: 'Ask HN: How do you review LLM output?', points: 88, num_comments: 64, created_at: '2026-11-17T14:00:00Z' },
  ],
};

const LEAD_LINK = 'https://vendor.example/news/model-nine';
const RELEASE_LINK = 'https://github.com/example/tool/releases/tag/v1.2.0';
const SANDBOX_LINK = 'https://sandbox.example/';

// Stands in for the headless session: it records its arguments and answers as FAKE_MODEL_SCENARIO says, attempt by attempt.
const FAKE_MODEL = String.raw`
import { appendFileSync, readFileSync } from 'node:fs';
const prompt = readFileSync(0, 'utf8');
const log = process.env.FAKE_MODEL_LOG;
const attempt = readFileSync(log, 'utf8').split('\n').filter(Boolean).length + 1;
appendFileSync(log, JSON.stringify({ args: process.argv.slice(2), prompt }) + '\n');
const valid = { lead: { link: '${LEAD_LINK}', summary: 'A faster model for coding agents.' }, releases: [{ link: '${RELEASE_LINK}', summary: 'Hooks run in parallel.' }], narration: { text: 'Model Nine leads.', links: ['${LEAD_LINK}'] } };
const answers = {
  valid: [valid],
  unknown: [{ ...valid, lead: { link: 'https://invented.example/', summary: 'Invented.' } }, { ...valid, lead: { link: 'https://invented.example/', summary: 'Invented.' } }],
  'malformed-then-valid': ['I could not decide.', valid],
}[process.env.FAKE_MODEL_SCENARIO];
const answer = answers[attempt - 1];
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: typeof answer === 'string' ? answer : JSON.stringify(answer), total_cost_usd: 0.002, usage: { input_tokens: 1200, cache_read_input_tokens: 0 } }));
`;

type Fixture = { home: string; dayDirectory: string; sourcesFile: string; contentRoot: string; modelLog: string };
type ScriptRun = { exitCode: number; stdout: string };

function serveFeeds(): Promise<Server> {
  const server = createServer((request, answer) => {
    const routes: Record<string, [string, string]> = {
      '/release.atom': ['application/atom+xml', RELEASE_FEED],
      '/news.rss': ['application/rss+xml', NEWS_FEED],
      '/front-page.json': ['application/json', JSON.stringify(FRONT_PAGE)],
    };
    if (request.url === '/moved.rss') {
      answer.writeHead(301, { location: '/news.rss' }).end();
    } else if (request.url === '/slow') {
      // Never answers: the source's timeout ends it.
    } else if (routes[request.url ?? '']) {
      const [contentType, body] = routes[request.url ?? '']!;
      answer.writeHead(200, { 'content-type': contentType }).end(body);
    } else {
      answer.writeHead(404).end('Not found');
    }
  });
  return new Promise((resolveServer) => server.listen(0, '127.0.0.1', () => resolveServer(server)));
}

async function withFixture<Result>(use: (fixture: Fixture) => Promise<Result>): Promise<Result> {
  const server = await serveFeeds();
  const home = await mkdtemp(join(tmpdir(), 'mpx-brief-news-'));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fixture: Fixture = {
    home,
    dayDirectory: join(home, 'work', 'morning-brief', DAY),
    sourcesFile: join(home, 'news-sources.json'),
    contentRoot: join(home, 'mpx'),
    modelLog: join(home, 'model.jsonl'),
  };
  try {
    await mkdir(join(fixture.dayDirectory, 'sources'), { recursive: true });
    await writeFile(join(fixture.dayDirectory, 'start.json'), JSON.stringify({
      date: DAY, since: '2026-11-17T06:00:00Z', until: '2026-11-18T06:00:00Z', calendarDays: ['2026-11-17', DAY, '2026-11-19'],
    }));
    await writeFile(join(home, 'work', 'morning-brief', 'taste.md'), '# Taste\n\n## News\n\n- Model releases over business stories.\n');
    await writeFile(fixture.sourcesFile, JSON.stringify({
      timeoutSeconds: 1,
      candidatesPerSource: 5,
      excerptCharacters: 120,
      aiKeywords: ['AI', 'LLM', 'agent', 'model'],
      sources: [
        { name: 'Tool', app: 'claude', kind: 'release', format: 'feed', url: `${base}/release.atom`, excludeTitles: 'alpha' },
        { name: 'Vendor', app: 'openai', kind: 'news', format: 'feed', url: `${base}/moved.rss` },
        { name: 'Hacker News', app: 'ycombinator', kind: 'discussion', format: 'hacker-news', url: `${base}/front-page.json`, aiTitlesOnly: true },
        { name: 'Gone', app: 'openai', kind: 'news', format: 'feed', url: `${base}/gone.rss` },
        { name: 'Slow', app: 'openai', kind: 'news', format: 'feed', url: `${base}/slow` },
        { name: 'r/ClaudeAI', app: 'reddit', kind: 'reddit', format: 'reddit', subreddit: 'ClaudeAI', waitingFor: 'Waiting for API access.' },
      ],
    }));
    await mkdir(join(fixture.contentRoot, 'bin'), { recursive: true });
    await writeFile(join(home, 'fake-claude.mjs'), FAKE_MODEL);
    await writeFile(join(fixture.contentRoot, 'bin', 'cc'), `#!/usr/bin/env bash\nexec node "${join(home, 'fake-claude.mjs').replaceAll('\\', '/')}" "$@"\n`);
    await writeFile(fixture.modelLog, '');
    return await use(fixture);
  } finally {
    server.closeAllConnections();
    server.close();
    await rm(home, { recursive: true, force: true });
  }
}

function runScript(script: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<ScriptRun> {
  return new Promise((resolveRun) => {
    execFile(process.execPath, [join(scriptDirectory, script), ...args], { env: { ...process.env, ...env }, timeout: 150_000 }, (error, stdout, stderr) => {
      resolveRun({ exitCode: error ? Number(error.code) : 0, stdout: `${stdout}${stderr}` });
    });
  });
}

const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'));

function gatherNews(fixture: Fixture): Promise<ScriptRun> {
  return runScript('news.mjs', [fixture.dayDirectory, '--sources', fixture.sourcesFile]);
}

function digestNews(fixture: Fixture, scenario: string): Promise<ScriptRun> {
  return runScript('news-digest.mjs', [fixture.dayDirectory], {
    MPX_ACTIVE_CONTENT_ROOT: fixture.contentRoot, FAKE_MODEL_SCENARIO: scenario, FAKE_MODEL_LOG: fixture.modelLog,
  });
}

async function writeDocument(fixture: Fixture, projectsRoot = join(fixture.home, 'projects')) {
  const run = await runScript('daily-brief.mjs', [fixture.dayDirectory], {
    MPX_OBSIDIAN_VAULT: join(fixture.home, 'vault'), ALFRED_CONTROL_CENTER_DATA: join(fixture.home, 'data'), MPX_PROJECTS: projectsRoot,
  });
  return { ...run, document: await readJson(join(fixture.dayDirectory, 'daily-brief.json')) };
}

async function idOf(link: string): Promise<string> {
  return (await runScript('brief-id.mjs', ['news', link])).stdout.trim();
}

const modelRuns = async (fixture: Fixture) => (await readFile(fixture.modelLog, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));

test('the feeds give candidates from the window, and a dead source leaves the rest', async () => {
  await withFixture(async (fixture) => {
    const { exitCode, stdout } = await gatherNews(fixture);
    assert.equal(exitCode, 2, 'a dead source is reported by the exit code');
    const news = await readJson(join(fixture.dayDirectory, 'sources', 'news.json'));
    assert.deepEqual(news.sources.map(({ name, status }: { name: string; status: string }) => [name, status]), [
      ['Tool', 'read'], ['Vendor', 'read'], ['Hacker News', 'read'], ['Gone', 'dead'], ['Slow', 'dead'], ['r/ClaudeAI', 'not-read'],
    ]);
    assert.match(news.sources[3].reason, /^HTTP 404 from /);
    assert.match(news.sources[4].reason, /^no answer within 1 s from /);
    assert.equal(news.sources[5].reason, 'Waiting for API access.');
    assert.deepEqual(news.candidates.map(({ source, title, link }: { source: string; title: string; link: string }) => [source, title, link]), [
      ['Tool', 'Tool v1.2.0', RELEASE_LINK],
      ['Vendor', 'Introducing Model Nine', LEAD_LINK],
      ['Hacker News', 'Show HN: An open agent sandbox', SANDBOX_LINK],
      ['Hacker News', 'Ask HN: How do you review LLM output?', 'https://news.ycombinator.com/item?id=3'],
    ]);
    const [release, vendor, sandbox] = news.candidates;
    assert.equal(release.excerpt, 'Hooks run in parallel & start faster');
    assert.equal(vendor.excerpt, 'A faster model for coding agents.');
    assert.deepEqual([sandbox.score, sandbox.commentCount, sandbox.publishedAt], [412, 120, '2026-11-17T12:00:00.000Z']);
    assert.match(stdout, /Gone: dead \(HTTP 404/);
  });
});

test('the digest picks candidates in one run without tools, and the document writes the news chapter', { skip: appSkip }, async () => {
  await withFixture(async (fixture) => {
    await gatherNews(fixture);
    const digest = await digestNews(fixture, 'valid');
    assert.equal(digest.exitCode, 0, digest.stdout);
    const [run, ...moreRuns] = await modelRuns(fixture);
    assert.deepEqual(moreRuns, [], 'one model call per build');
    assert.deepEqual(run.args.slice(run.args.indexOf('--tools'), run.args.indexOf('--tools') + 3), ['--tools', '', '--strict-mcp-config']);
    assert.ok(!run.args.includes('--connectors') && !run.args.includes('--allowedTools'));
    assert.equal(run.args[run.args.indexOf('--model') + 1], 'haiku');
    assert.match(run.prompt, /Model releases over business stories/, 'the taste reaches the digest');
    assert.match(run.prompt, new RegExp(LEAD_LINK));

    const { exitCode, stdout, document } = await writeDocument(fixture, process.env.MPX_PROJECTS);
    const [leadId, releaseId] = [await idOf(LEAD_LINK), await idOf(RELEASE_LINK)];
    assert.deepEqual(Object.keys(document.chapters).slice(-3), ['plan', 'news', 'health']);
    assert.deepEqual(document.chapters.news.items, [
      { id: leadId, kind: 'lead', title: 'Introducing Model Nine', summary: 'A faster model for coding agents.', source: 'Vendor', link: LEAD_LINK, publishedAt: '2026-11-17T16:00:00.000Z', score: null, commentCount: null },
      { id: releaseId, kind: 'release', title: 'Tool v1.2.0', summary: 'Hooks run in parallel.', source: 'Tool', link: RELEASE_LINK, publishedAt: '2026-11-17T18:00:00.000Z', score: null, commentCount: null },
    ]);
    assert.deepEqual(document.chapters.news.narration, [{ text: 'Model Nine leads.', targets: [leadId] }]);
    assert.deepEqual(document.sources.filter((source: { name: string }) => source.name.startsWith('AI news')).map((source: { name: string; status: string }) => [source.name, source.status]), [
      ['AI news: Tool', 'read'], ['AI news: Vendor', 'read'], ['AI news: Hacker News', 'read'], ['AI news: Gone', 'not-read'], ['AI news: Slow', 'not-read'], ['AI news: r/ClaudeAI', 'not-read'],
    ]);
    assert.match(stdout, /News source Gone is dead: HTTP 404/);
    assert.doesNotMatch(stdout, /News source r\/ClaudeAI/, 'a source waiting for access is no problem');
    assert.match(stdout, /ok {7}news/);
    assert.equal(exitCode, 0, stdout);
  });
});

test('a digest naming an unknown link is refused, and the failed digest still gives a valid chapter', { skip: appSkip }, async () => {
  await withFixture(async (fixture) => {
    await gatherNews(fixture);
    const digest = await digestNews(fixture, 'unknown');
    assert.equal(digest.exitCode, 2);
    const runs = await modelRuns(fixture);
    assert.equal(runs.length, 2, 'a refused answer is asked for once more');
    assert.match(runs[1].prompt, /refused because "https:\/\/invented\.example\/" is not the link of a candidate/);
    const record = await readJson(join(fixture.dayDirectory, 'sources', 'news-digest.json'));
    assert.equal(record.status, 'failed');

    const { exitCode, stdout, document } = await writeDocument(fixture, process.env.MPX_PROJECTS);
    assert.deepEqual(document.chapters.news.items.map((item: { kind: string; link: string; summary: string | null }) => [item.kind, item.link, item.summary]), [
      ['lead', SANDBOX_LINK, null],
      ['release', RELEASE_LINK, null],
    ]);
    assert.deepEqual(document.chapters.news.narration, []);
    assert.match(stdout, /The news digest failed \(the answer was refused twice/);
    assert.match(stdout, /ok {7}news/);
    assert.equal(exitCode, 0, stdout);
  });
});

test('a malformed answer is retried once', async () => {
  await withFixture(async (fixture) => {
    await gatherNews(fixture);
    const digest = await digestNews(fixture, 'malformed-then-valid');
    assert.equal(digest.exitCode, 0, digest.stdout);
    const record = await readJson(join(fixture.dayDirectory, 'sources', 'news-digest.json'));
    assert.deepEqual([record.status, record.attempts, record.lead.link], ['ok', 2, LEAD_LINK]);
  });
});

test('without news.json the document has no news chapter', async () => {
  await withFixture(async (fixture) => {
    const { document } = await writeDocument(fixture);
    assert.equal(document.chapters.news, undefined);
    assert.ok(!document.sources.some((source: { name: string }) => source.name.startsWith('AI news')));
  });
});

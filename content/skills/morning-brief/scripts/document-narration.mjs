// The daily brief document's narration as daily-brief.mjs writes it.
import { join } from 'node:path';
import { briefItemId } from './brief-id.mjs';

export const JUDGEMENT_FILE = 'daily-brief.judgement.json';
export const NEWS_FILE = join('sources', 'news.json');
export const NEWS_DIGEST_FILE = join('sources', 'news-digest.json');
export const TRIAGE_FILE = join('sources', 'triage.json');
// The triage area's suggestion for each capture id, as the judgement's `notes` takes it.
export const TRIAGE_JUDGEMENT_FILE = join('sources', 'triage-judgement.json');
// The document's narration is an overview: a chapter keeps its first sentences, the rest is cut.
export const NARRATION_SENTENCE_LIMIT = 2;

export function judgedSentences(judgement, chapterName) {
  return Array.isArray(judgement.narration?.[chapterName]) ? judgement.narration[chapterName] : [];
}

// A chapter's sentences as the judgement writes them; the news chapter speaks the digest's sentence, targeting the
// news items it names, unless the judgement narrates news itself.
export function documentSentences(judgement, newsDigest, chapterName) {
  const judged = judgedSentences(judgement, chapterName);
  const digestNarration = newsDigest?.status === 'ok' ? newsDigest.narration : null;
  if (chapterName !== 'news' || judged.length > 0 || typeof digestNarration?.text !== 'string') return judged;
  const links = Array.isArray(digestNarration.links) ? digestNarration.links : [];
  return [{ text: digestNarration.text, targets: links.map((link) => briefItemId('news', link)) }];
}

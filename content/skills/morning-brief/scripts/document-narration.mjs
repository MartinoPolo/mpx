// The daily brief document's narration as narrate.mjs voices it and daily-brief.mjs writes it.
import { join } from 'node:path';
import { briefItemId } from './brief-id.mjs';

export const JUDGEMENT_FILE = 'daily-brief.judgement.json';
// narrate.mjs --document keeps here each sentence's clip by its exact text, so a rerun of daily-brief.mjs or a rewritten
// judgement keeps the clips of unchanged sentences.
export const DOCUMENT_CLIPS_FILE = 'daily-brief.clips.json';
export const NEWS_FILE = join('sources', 'news.json');
export const NEWS_DIGEST_FILE = join('sources', 'news-digest.json');
// The document's narration is an overview: a chapter keeps its first sentences, the rest is cut and never voiced.
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

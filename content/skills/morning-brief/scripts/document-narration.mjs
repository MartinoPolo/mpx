// The daily brief document's narration as narrate.mjs voices it and daily-brief.mjs writes it.
export const JUDGEMENT_FILE = 'daily-brief.judgement.json';
// narrate.mjs --document keeps here each sentence's clip by its exact text, so a rerun of daily-brief.mjs or a rewritten
// judgement keeps the clips of unchanged sentences.
export const DOCUMENT_CLIPS_FILE = 'daily-brief.clips.json';
// The document's narration is an overview: a chapter keeps its first sentences, the rest is cut and never voiced.
export const NARRATION_SENTENCE_LIMIT = 2;

export function judgedSentences(judgement, chapterName) {
  return Array.isArray(judgement.narration?.[chapterName]) ? judgement.narration[chapterName] : [];
}

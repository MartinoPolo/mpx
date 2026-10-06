import { createHash } from 'node:crypto';

export const ttsModel = process.env.TTS_MODEL ?? 'gemini-3.8-flash-lite-tts';

/* Audio is named by everything that shapes its sound, so an edited sentence or voice gets new audio and the rest is reused. */
export const hashOf = (script, text) => createHash('sha1').update([ttsModel, script.voice, script.style, text].join('|')).digest('hex').slice(0, 12);
export const clipOf = (script, say) => `audio/clips/${hashOf(script, say)}.wav`;

/* Free-tier TTS allows few requests per day, so one request synthesises several sentences. */
export const sentencesPerTake = 8;

import { writeFile } from 'node:fs/promises';

const endpoint = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const maximumAttempts = 6;

const postOnce = async (apiKey, body) => {
	const response = await fetch(endpoint, {
		method: 'POST',
		headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(300_000),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 1500)}`);
	return JSON.parse(text);
};

/* Rate limits and server errors are common on the free tier, so they back off and retry. */
const post = async (apiKey, body) => {
	for (let attempt = 1; ; attempt++) {
		try {
			return await postOnce(apiKey, body);
		} catch (error) {
			const retryable = /HTTP (429|500|502|503|504)|timeout|fetch failed/i.test(error.message);
			if (!retryable || attempt >= maximumAttempts) throw error;
			const delay = 5000 * attempt;
			console.error(`retry ${attempt} in ${delay}ms: ${error.message.slice(0, 120)}`);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
};

const findAudio = (node) => {
	if (!node || typeof node !== 'object') return null;
	if (typeof node.data === 'string' && node.data.length > 1000) return node;
	for (const value of Object.values(node)) {
		const found = findAudio(value);
		if (found) return found;
	}
	return null;
};

/* The key is read only when a sentence is synthesised, so a run with every clip cached needs no key. */
export const speak = async ({ text, style, voice, model, outputPath }) => {
	const apiKey = process.env.GEMINI_API_KEY;
	if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
	const content = { type: 'text', text, ...(style && { annotations: [{ type: 'speech_metadata', style }] }) };
	const json = await post(apiKey, {
		model,
		input: [{ type: 'user_input', content: [content] }],
		response_format: { type: 'audio', mime_type: 'audio/wav', sample_rate: 48000 },
		generation_config: { speech_config: [{ voice }] },
	});
	const audio = findAudio(json);
	if (!audio) throw new Error(`No audio in response: ${JSON.stringify(json).slice(0, 800)}`);
	await writeFile(outputPath, Buffer.from(audio.data, 'base64'));
};

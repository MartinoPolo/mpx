// The morning brief's narration against a fake VoiceStudio, shared by the narrate and document tests.
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const narrateScript = resolve('content/skills/morning-brief/scripts/narrate.mjs');
export const CLIP_SECONDS = 0.5;
const BYTES_PER_SECOND = 16_000;

export type FakeVoiceStudio = { url: string; spokenTexts: string[]; close: () => Promise<void> };
export type NarrateRun = { exitCode: number; stdout: string; stderr: string };

export async function narrate(dayDirectory: string, backendUrl: string): Promise<NarrateRun> {
  // Without a checkout to start, a backend that is not running fails at once and never reaches a GPU.
  const { VOICESTUDIO_DIR: _checkout, MPX_CLONED: _clones, ...environment } = process.env;
  try {
    const { stdout, stderr } = await exec(process.execPath, [narrateScript, dayDirectory], {
      env: { ...environment, VOICESTUDIO_URL: backendUrl },
      timeout: 60_000,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

// A mono 16-bit PCM WAV of the given length, silent.
function silentWav(seconds: number): Buffer {
  const dataSize = Math.round(seconds * BYTES_PER_SECOND);
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(BYTES_PER_SECOND / 2, 24);
  wav.writeUInt32LE(BYTES_PER_SECOND, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataSize, 40);
  return wav;
}

function listening(server: Server): Promise<string> {
  return new Promise((resolveUrl) => server.listen(0, '127.0.0.1', () => resolveUrl(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

const closing = (server: Server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()));

// Answers health checks and renders every requested sentence as silence, recording what it was asked to speak.
export async function fakeVoiceStudio(): Promise<FakeVoiceStudio> {
  const spokenTexts: string[] = [];
  const server = createServer((request, response) => {
    if (request.url === '/health') return void response.end('{"status":"ok"}');
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      spokenTexts.push(JSON.parse(body).input);
      response.writeHead(200, { 'content-type': 'audio/wav' }).end(silentWav(CLIP_SECONDS));
    });
  });
  const url = await listening(server);
  return { url, spokenTexts, close: () => closing(server) };
}

// An address nothing listens on.
export async function deadBackendUrl(): Promise<string> {
  const server = createServer();
  const url = await listening(server);
  await closing(server);
  return url;
}

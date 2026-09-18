---
name: podcast
description:
  "Turns a topic plus the listener's own repositories and notes into a two-host educational podcast
  MP3..."
metadata:
  author: MartinoPolo
  version: '0.3'
  category: utility
  mpx:
    schemaVersion: 1
    skillPacks: [personal]
    defaultExposure: explicit-only
---

# Topic to Personalized Podcast

Produce a walk-listenable MP3 that teaches a topic **through the listener's own code**. You research
the topic, sweep his repositories and notes, and write a fact-dense source brief; NotebookLM writes
the dialogue and renders the audio from that brief. the invocation input

Two artifacts drive everything: a `<slug>-resource.md` brief (the only facts the hosts will ever
know) and a `<slug>-prompt.txt` customize instruction (how they discuss it). Format rules for both:
[`reference/BRIEF_FORMAT.md`](reference/BRIEF_FORMAT.md).

`<skill-dir>` is the loaded skill directory.

## Step 1: Parse the request

| Input      | Source                                                  | Default      |
| ---------- | ------------------------------------------------------- | ------------ |
| Topic      | everything in `the invocation input` that is not a flag | required     |
| Length     | `length short`, `length default`, `length long`         | `default`    |
| Work repos | `--include-work`                                        | excluded     |
| Backend    | `--backend`                                             | `notebooklm` |

Derive `<slug>` as kebab-case from the topic (`Shadow DOM` → `shadow-dom`); it names both artifacts,
the final MP3 and the folder it lands in.

Resolve only `MPX_PROJECTS`, `MPX_CLONED`, `MPX_WORK`, `MPX_OBSIDIAN_VAULT`, and
`MPX_AI_GENERATED` from the environment. A root that is unset is unavailable —
report it and continue without it. When `MPX_PROJECTS`, `MPX_CLONED` and `MPX_WORK` are all missing,
the terminal predates the variables being set; say so, and note that fixing it takes closing the
whole Windows Terminal window.

## Step 2: Preflight the backend and scratch space

Create an explicit, unique session scratch directory with the platform's temporary-directory
facility (for example `mktemp -d` in a compatible shell), retain its returned absolute path as
`<scratch-dir>`, and put every intermediate artifact there. Do not write a made-up environment
variable such as `$SCRATCHPAD` into commands.

Only the NotebookLM backend needs NotebookLM authentication:

```bash
notebooklm auth check --test --json
```

For `--backend notebooklm`, proceed when `status` is `ok` **and** `checks.token_fetch` is `true`.
Anything else means the cookies went stale: run `notebooklm auth refresh`, and if that still fails
ask the user to run `notebooklm login` once, then re-check. For `--backend gemini-tts`, skip all
NotebookLM auth commands; follow `reference/GEMINI_TTS.md` for its API-key preflight instead.

When the NotebookLM backend is selected and `notebooklm` is absent from PATH, the shell predates the
install: use `$LOCALAPPDATA\Python\pythoncore-3.14-64\Scripts\notebooklm.exe` for this run.

## Step 3: Research and personalization — one message, parallel

Send every spawn below in a **single message** so they run concurrently, and orchestrate them from
this thread.

**Topic research.** The brief is built from gathered sources, so gather them first:

- Library or framework topic → spawn `context7-docs-fetcher` with the library name and the specific
  APIs to document.
- General topic → resolve the canonical `standard` class through the active runtime profile, then
  spawn `general-purpose` using the resulting concrete value in the runtime's real `model` field.
  Have it web-search and fetch authoritative primary sources (spec, MDN, official docs, the
  canonical blog post), returning each URL and its current technical substance.

**Personalization sweep.** Fan out one `Explore` per root. If a narrow topic returns nothing,
retry once with its concrete API and keyword spellings.

| Root                              | Looking for                                     |
| --------------------------------- | ----------------------------------------------- |
| `MPX_PROJECTS`                    | where the topic already appears in his own code |
| `MPX_OBSIDIAN_VAULT/Programming/` | his own notes on the topic                      |
| `MPX_CLONED`                      | how the topic is done well in OSS he studies    |
| `MPX_WORK`                        | **only** when `--include-work` was passed       |

`Explore` skips repository instructions and is one-shot, so each delegation prompt carries
everything it needs: the root to search, the already resolved literal root and to report an unset variable rather than guessing a path, the topic with its
concrete API/keyword spellings, and this return shape per hit:

> repository · `file:line` · how the topic is used there · idiomatic, outdated, or a latent bug ·
> one line on what changing it would buy him

**Listener profile.** Read these two directly — known paths are not exploration:

- `$MPX_OBSIDIAN_VAULT\Programming\Webdev Fundamentals Learning System.md`
- `$MPX_OBSIDIAN_VAULT\Programming\Webdev Fundamentals Assessment.md`

They give his real level, priority map and known gaps. Derive the listener-context line of the
customize prompt from them, and skip the basics they show he already owns.

## Step 4: Write the two artifacts

Read [`reference/BRIEF_FORMAT.md`](reference/BRIEF_FORMAT.md) and write both files into
`<scratch-dir>`:

- `<slug>-resource.md` — 200-250 lines, `## Part 1..N`, direct technical language, syntax spelled
  out for text-to-speech, every claim traceable to a gathered source.
- `<slug>-prompt.txt` — the customize instruction, ≤308 words and ≤2263 characters. Count both
  before saving and trim until they fit.

The sweep's evidence becomes the final `## Part N: In Your Own Code`, each claim tied to a real
`file:line`, plus a matching numbered topic in the prompt so the hosts actually reach it. When a
sweep returns nothing, drop that part and that topic — NotebookLM narrates whatever the brief says
as fact, so the brief holds only what the sweep returned.

**Privacy.** The brief is uploaded to Google through an unofficial API on a personal account. Keep
secrets, `.env` contents and credentials out of it; keep personal-project snippets to about 15
lines; describe work-repo patterns in prose instead of pasting proprietary code.

## Step 5: Generate the audio

Follow [`reference/NOTEBOOKLM_FLOW.md`](reference/NOTEBOOKLM_FLOW.md): create notebook → add the
brief as a source → wait →
`generate audio --prompt-file <prompt> --format deep-dive --length <length> --json` → resolve the
canonical `mechanical` class through the active runtime profile and pass its concrete value through
the background `general-purpose` waiter's real `model` field → `download audio`. Full CLI surface: `{{MPX_SKILL_COMMAND}}notebooklm`. If that required command is unavailable, ask the user to include the
`development` pack and stop; never load an excluded `SKILL.md` directly, silently skip this step, or
broaden the selected packs automatically.

Length maps straight through, and the same choice sets the prompt's closing duration line:

| Argument  | `--length` | Prompt line                    | Measured                    |
| --------- | ---------- | ------------------------------ | --------------------------- |
| `short`   | `short`    | `Target duration: 10 minutes.` | —                           |
| `default` | `default`  | `Target duration: 15 minutes.` | —                           |
| `long`    | `long`     | `Target duration: 25 minutes.` | 33.5 min from a 15-min line |

Lengths are hints rather than contracts, and overshoot is acceptable.

On quota exhaustion (3 audio overviews per day) or repeated generation failure, offer the Gemini TTS
backend — you write every spoken line, then `python <skill-dir>/scripts/gemini-tts-podcast.py`
renders it — or waiting for tomorrow's quota. `--backend gemini-tts` selects it directly. See
[`reference/GEMINI_TTS.md`](reference/GEMINI_TTS.md).

## Step 6: Post-process and deliver

Every podcast gets its own folder, `$MPX_AI_GENERATED\_PODCASTS\<slug>\`. Re-encode to a
phone-friendly bitrate straight into it:

```bash
mkdir -p "$MPX_AI_GENERATED/_PODCASTS/<slug>"
ffmpeg -i <downloaded>.mp3 -codec:a libmp3lame -b:a 64k -ac 1 "$MPX_AI_GENERATED/_PODCASTS/<slug>/<slug>.mp3"
```

64 kbps mono took a 33-minute episode from 62 MB to about 15 MB. Keep the original only when the
re-encode lands within 20% of it; otherwise the re-encode is the deliverable.

Write two companion files into that same folder, so the audio ships with what produced it:

- `script.txt` — the spoken script. Under Gemini TTS that is the dialogue you wrote; under
  NotebookLM, which writes its own dialogue, it is `<slug>-prompt.txt` (the customize instruction
  the hosts followed) so the folder still records what was asked for.
- `sources.md` — the source list used for the episode, for either backend: the research URLs
  gathered, the repository and note `file:line` hits the sweep returned, and the roots skipped as
  unset. The Gemini TTS fallback must create and promote this file too.

Intermediate work — the raw download, chunk WAVs, temp files — stays in `<scratch-dir>`. Only
`<slug>.mp3`, `script.txt` and `sources.md` are promoted to the final folder.

## Step 7: Report

- MP3 path as a clickable `file:///` link, plus duration and size, and the per-slug folder holding
  it alongside `script.txt` and `sources.md`
- Which backend ran, and the resolved `--length`
- Sources the research phase gathered (count and the primary ones)
- Personalization: repositories swept, hits found, `file:line` references that made the brief — or a
  plain statement that the topic appears nowhere in his code yet
- Roots skipped because their variable was unset

## Notes

- `notebooklm-py` is an unofficial client and using it goes against Google's Terms of Service. It
  runs under a secondary Google account, which is what keeps the exposure contained.
- NotebookLM was renamed "Gemini Notebook" in July 2026. There is no consumer API; the free tier
  allows 3 audio overviews per day.
- Stored cookies expired within a day of the first login, and `auth refresh` did not recover them —
  it failed with the same "Authentication expired" error. Budget for an interactive
  `notebooklm login` at the start of a run rather than treating it as an edge case.
- English output only for now.

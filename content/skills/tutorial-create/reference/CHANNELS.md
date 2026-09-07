# YouTube Channel Guide

Use these selection guidelines:

- Pick 1-2 intro videos per tutorial.
- Prefer ~10 minutes, but 5-20 minutes is fine.
- Prefer channels below whose profile matches the topic.
- When none match, any high-quality channel is a valid fallback.
- Use link cards only — never iframes.

## Channel profiles

#### Channel: Matt Pocock

- **Handle:** @mattpocockuk
- **Profile:** TypeScript deep dives — first pick for any TS topic

#### Channel: Web Dev Simplified

- **Handle:** @WebDevSimplified
- **Profile:** React, JavaScript, CSS — general web dev tutorials

#### Channel: Ben Davis

- **Handle:** @bmdavis419
- **Profile:** Svelte / SvelteKit

#### Channel: Code with Stanislav

- **Handle:** —
- **Profile:** Svelte + AI topics

#### Channel: Traversy Media

- **Handle:** @TraversyMedia
- **Profile:** Broad crash courses on almost anything

#### Channel: No Boilerplate

- **Handle:** @NoBoilerplate
- **Profile:** Conceptual essays, Rust — concepts over code-along

#### Channel: Optimistic Web

- **Handle:** —
- **Profile:** Niche web topics — unverified quality, verify before using

#### Channel: Syntax

- **Handle:** @syntaxfm
- **Profile:** Podcast/discussion format — NOT tutorials; use only when a discussion episode genuinely fits

## Search technique

1. WebSearch per matching channel:

   ```
   site:youtube.com "<topic>" <channel name>
   ```

2. Duration filter — append the 4-20 min bucket param to a YouTube search URL when browsing results:

   ```
   https://www.youtube.com/results?search_query=<topic>+<channel>&sp=EgIYAw%3D%3D
   ```

3. Verify each candidate URL via the oEmbed endpoint (no consent wall, returns JSON with real title + author):

   ```
   https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=<id>&format=json
   ```

   A 200 response confirms the video exists and gives the exact title/channel for the card. Get duration from the search
   result snippet; if unavailable, state approximate duration from the source that listed it.

## Card fields

Each video entry in frontmatter needs:

- `title` (exact from oEmbed)
- `channel`
- `duration` (m:ss)
- `url` (canonical watch URL)

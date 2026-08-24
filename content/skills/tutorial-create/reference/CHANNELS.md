# YouTube Channel Guide

Pick 1-2 intro videos per tutorial. ~10 minutes preferred, flexible (5-20 min fine). Prefer channels below whose profile matches the topic; when none match, any high-quality channel is a valid fallback. Link cards only — never iframes.

## Channel profiles

| Channel | Handle | Profile |
| --- | --- | --- |
| Matt Pocock | @mattpocockuk | TypeScript deep dives — first pick for any TS topic |
| Web Dev Simplified | @WebDevSimplified | React, JavaScript, CSS — general web dev tutorials |
| Ben Davis | @bmdavis419 | Svelte / SvelteKit |
| Code with Stanislav | — | Svelte + AI topics |
| Traversy Media | @TraversyMedia | Broad crash courses on almost anything |
| No Boilerplate | @NoBoilerplate | Conceptual essays, Rust — concepts over code-along |
| Optimistic Web | — | Niche web topics — unverified quality, verify before using |
| Syntax | @syntaxfm | Podcast/discussion format — NOT tutorials; use only when a discussion episode genuinely fits |

## Search technique

1. WebSearch per matching channe<configured-path>site:youtube.com "<topic>" <channel name>
   ```

2. Duration filter — append the 4-20 min bucket param to a YouTube search URL when browsing result<configured-path>http<configured-path>www.youtube.com/results?search_query=<topic>+<channel>&sp=EgIYAw%3D%3D
   ```

3. Verify each candidate URL via the oEmbed endpoint (no consent wall, returns JSON with real title + author):

   ```
   http<configured-path>www.youtube.com/oembed?url=http<configured-path>www.youtube.com/watch?v=<id>&format=json
   ```

   A 200 response confirms the video exists and gives the exact title/channel for the card. Get duration from the search result snippet; if unavailable, state approximate duration from the source that listed it.

## Card fields

Each video entry in frontmatter need<configured-path>title` (exact from oEmbed), `channel`, `duration` (m:ss), `url` (canonical watch URL).

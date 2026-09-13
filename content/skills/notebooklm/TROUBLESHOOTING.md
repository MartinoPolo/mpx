# NotebookLM troubleshooting

Use this reference after a failed or long-running operation. Resolve each failure or report it
explicitly.

## Error Handling

**On failure, offer the user a choice:**

1. Retry the operation
2. Skip and continue with something else
3. Investigate the error

**Error decision tree:**

#### Error: Auth/cookie error

- **Cause:** Session expired
- **Action:** Run `notebooklm auth check` then `notebooklm login`

#### Error: "No notebook context"

- **Cause:** Context not set
- **Action:** Use `-n <id>` or `--notebook <id>` flag (parallel), or `notebooklm use <id>`
  (single-agent)

#### Error: "No result found for RPC ID"

- **Cause:** Rate limiting
- **Action:** Wait 5-10 min, retry

#### Error: `GENERATION_FAILED`

- **Cause:** Google rate limit
- **Action:** Wait and retry later

#### Error: Download fails

- **Cause:** Generation incomplete
- **Action:** Check `artifact list` for status

#### Error: Invalid notebook/source ID

- **Cause:** Wrong ID
- **Action:** Run `notebooklm list` to verify

#### Error: RPC protocol error

- **Cause:** Google changed APIs
- **Action:** May need CLI update

## Exit Codes

Exit codes must be interpreted with stderr and the corresponding status command; observed CLI
versions have not used one timeout code consistently.

| Code | Meaning                                     | Action                                                         |
| ---- | ------------------------------------------- | -------------------------------------------------------------- |
| 0    | Success                                     | Continue                                                       |
| 1+   | Timeout or real error, depending on command | Preserve stderr, then inspect the exact source/artifact status |

For a nonzero wait, use `source list`, `artifact list`, or `research status` with the retained full
IDs. Retry only when the object still reports a processing state. A missing/failed object, rate
limit, authentication failure, or other stderr remains a real CLI error; do not convert every
nonzero result into a timeout.

## Long Prompts

When a prompt or query exceeds shell command-line length limits, use `--prompt-file` to read it from
a file:

```bash
notebooklm ask --prompt-file ./long_question.txt
notebooklm generate report --prompt-file ./custom_report_prompt.txt
notebooklm source add-research --prompt-file ./research_query.txt --mode deep
```

`--prompt-file` is mutually exclusive with the positional text argument. The file is read as UTF-8
with trailing whitespace stripped. Supported on: `ask`, all `generate` subcommands (except
`mind-map`), and `source add-research`.

> **Note:** `--prompt-file` reads a _prompt/query text file_, not a source document. To upload a
> file as a notebook source, use `source add ./file.pdf`.

## Known Limitations

**Rate limiting:** Audio, video, quiz, flashcards, infographic, and slide deck generation may fail
due to Google's rate limits. This is an API limitation, not a bug.

**Reliable operations:** These always work:

- Notebooks (list, create, delete, rename)
- Sources (add, list, delete)
- Chat/queries
- Mind-map, study-guide, report, data-table generation

**Unreliable operations:** These may fail with rate limiting:

- Audio (podcast) generation
- Video generation
- Quiz and flashcard generation
- Infographic and slide deck generation

**Workaround:** If generation fails:

1. Check status: `notebooklm artifact list`
2. Retry after 5-10 minutes
3. Use the NotebookLM web UI as fallback

**Processing times vary significantly.** Use the subagent pattern for long operations:

| Operation          | Typical time   | Suggested timeout |
| ------------------ | -------------- | ----------------- |
| Source processing  | 30s - 10 min   | 600s              |
| Research (fast)    | 30s - 2 min    | 180s              |
| Research (deep)    | 15 - 30+ min   | 1800s             |
| Notes              | instant        | n/a               |
| Mind-map           | instant (sync) | n/a               |
| Quiz, flashcards   | 5 - 15 min     | 900s              |
| Report, data-table | 5 - 15 min     | 900s              |
| Audio generation   | 10 - 20 min    | 1200s             |
| Video generation   | 15 - 45 min    | 2700s             |

**Polling intervals:** When checking status manually, poll every 15-30 seconds to avoid excessive
API calls.

## Troubleshooting

```bash
notebooklm --help              # Main commands
notebooklm auth check          # Diagnose auth issues
notebooklm auth check --test   # Full auth validation with network test
notebooklm source --help       # Source management
notebooklm research --help     # Research status/wait
notebooklm generate --help     # Content generation
notebooklm artifact --help     # Artifact management
notebooklm download --help     # Download content
notebooklm language --help     # Language settings
```

**Diagnose auth:** `notebooklm auth check` - shows cookie domains, storage path, validation status
**Re-authenticate:** `notebooklm login` **Check version:** `notebooklm --version` **Refresh a
CLI-managed install:** `notebooklm skill install`

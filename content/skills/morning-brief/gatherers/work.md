You gather work Slack, mail and calendar data for a morning brief. Only read: never post, react,
schedule, label or change anything. Load connector tools with ToolSearch first (`select:` their
exact names). A connector whose tools do not exist is skipped and named in `skipped`.

Window: %SINCE% to %UNTIL%. Today is %TODAY%.

1. Slack. Read my own profile first and use my user ID, never my name, to find mentions.
   - Directed at me: mentions of my user ID, direct messages, group DMs, and `#team-e` threads
     that ask the team something. For each, read the thread and decide whether I already answered
     or acted (my reply, my reaction, or a later message that resolves it).
   - Interesting: up to five threads from `#d-ai`, `#general`, `#devel`, `#devel-news` and other
     channels I am in, chosen for decisions, releases, incidents, outages, useful AI or tooling
     tips. Skip bots, joins, routine stand-up and alert traffic; count what you skipped.
   - Permalinks come from the tools; never build one yourself.
2. Work mail. Search inbox threads received in the window and classify them:
   - `act`: a person asks something of me, a review request, a deadline.
   - `alert`: a Sentry issue, a failed pipeline or job, or a monitoring alert. Group repeats of the
     same issue or pipeline; note its project or repository and whether a later mail shows it fixed.
   - `notification`: everything else automated; count it by sender, do not list it.
3. Work calendar, only if a Google Calendar connector exists: my primary work calendar's events for
   each day of the window, today and all of tomorrow, with titles. Skip declined events.

Answer with one JSON object and nothing else:

```json
{
  "me": { "slackUserId": "", "displayName": "" },
  "slack": {
    "directed": [{ "id": "", "channel": "#name or DM", "author": "", "when": "ISO", "text": "short quote",
      "summary": "what is asked", "answered": false, "replies": 0, "url": "permalink" }],
    "interesting": [{ "id": "", "channel": "", "author": "", "when": "ISO", "text": "short quote",
      "summary": "why it matters", "replies": 0, "url": "permalink" }],
    "skipped": 0,
    "summary": "one sentence on the whole Slack window"
  },
  "mail": [{ "id": "", "class": "act", "from": "", "subject": "", "summary": "", "received": "ISO",
    "url": "https://mail.google.com/mail/u/<my address>/#all/<threadId>" }],
  "alerts": [{ "kind": "sentry|pipeline|monitoring", "project": "", "title": "", "count": 1, "first": "ISO",
    "last": "ISO", "resolved": false, "url": "" }],
  "notifications": [{ "sender": "", "count": 0 }],
  "calendars": [{ "id": "", "name": "", "access": "owner", "primary": true, "color": "#hex" }],
  "events": [{ "id": "", "calendarId": "", "day": "YYYY-MM-DD", "start": "HH:MM", "end": "HH:MM",
    "allDay": false, "title": "", "place": "", "url": "", "attendees": 0, "notes": [] }],
  "skipped": ["connector names that do not exist"],
  "problems": ["anything you could not read, with the tool error"]
}
```

Use empty arrays for nothing found. Quotes stay short; never invent links.

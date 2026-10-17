# Design brief: morning brief player

The page the morning-brief skill builds: a narrated walk through the day that I mostly watch, then
act on a few points at the end. Data:
[brief.sample.json](../../../../../content/skills/morning-brief/templates/brief.sample.json)
(fictional, covers every chapter). Template:
[page.html](../../../../../content/skills/morning-brief/templates/page.html); polished variant C
preview: [refined.html](refined.html). Design language: [DESIGN_SYSTEM.md](../DESIGN_SYSTEM.md).

## Shell

- **Outline, left.** Fixed-height chapter rows with brand icon, name and a needs/count marker. The
  current chapter's beats sit in a fixed-height panel below the list, sized for the longest chapter,
  so no row moves when the chapter changes. A source problem (`sources[].status` not `ok`) is a
  small warning icon on the affected chapter, with the reason in the beat panel. No separate source
  list, no "all areas" grid.
- **Spacing.** Rows stay at least 12px apart so a highlight ring never touches a neighbour. Caption
  and transport have fixed heights. A long chapter scrolls inside the sheet with a fade at the lower
  edge, and each beat scrolls its targets into view together.
- **Stage, centre.** One chapter at a time in a reading column; header with brand icon, chapter
  title. Compact components, all visible at 1440×900 at least peripherally.
- **Caption.** The current `say` sentence, close to the stage, readable at a glance.
- **Transport.** One play/pause for the whole brief. Next to it, inner buttons go to the
  previous/next beat; outer buttons go to the previous/next chapter:
  `|◀◀ chapter` `◀ beat` `▶/❚❚` `beat ▶` `chapter ▶▶|`. One tall progress bar for the brief,
  segmented by chapter, with beat ticks; the playing chapter's segment is taller and ringed. Speed (1×, 1.25×, 1.5×, 2×) and voice mute as icon buttons. All
  icon-only with labels and tooltips. Keyboard: space, arrows, shift+arrows.
- **Choices.** Votes, approvals and handoffs are collected and saved as a file for the apply
  session; the save control lives with the action points at the end, not in the sidebar.
- **Highlight.** The beat's `targets` get an outline ring and lift; the rest stays readable. The
  highlight always matches what is being said and clears when narration moves on. Narration plays
  each beat's ElevenLabs clip (`audio`), falling back to the browser voice and a timer of about
  2.6 words per second at 1×.

## Chapters

Order: calendar, overnight, work, Slack, mail, triage, retro, instructions, news, action points.
Chapters report; asks wait for the action points. Readability comes first: sections share the
wider reading column, and lists become cards rather than full-width rows where they can.

- **Calendar:** Google Calendar look: one column per day (`days`), earlier days greyed as history,
  today focused, tomorrow in full. A day without events gets no column. Columns wide enough that
  titles in shared time slots stay readable; titles wrap when the block is tall enough. Events as
  solid blocks in their calendar colour with readable text (title, time); busy-only work blocks
  titled "Busy". All-day events in a strip above. A "now" line. Selected event opens an opaque
  detail popover beside its column, above neighbouring columns. The hour scale fits the sheet;
  short events keep a minimum height and lanes account for it, so blocks never overlap.
- **Overnight runs:** the away window (last prompt of the evening to first of the morning) as one
  muted line, then terse rows with outcome icon, title, result detail, start time, duration, link.
  Only work that ran while I was away (long implementations, renders); no routines.
- **Work in flight:** Kanban board, GitLab/GitHub look. Work and personal scope. Columns local,
  draft, in review, ready, merged; empty columns stay narrow. Each card: project, ref, short title,
  state as background fill (`data.states`), a state word only when it differs from the column,
  icon links for MR, pipeline (coloured by status), KF ticket (warn when its column is wrong), live
  session. A branch name moves behind a branch icon. No meta sentences. `autoHandled` is one quiet
  line with a toggle, not cards. Quiet projects as one muted line. Phone: one column, empty ones
  hidden.
- **Slack:** Slack look. Order: waiting on you, worth knowing, then a one-sentence summary of what
  I already handled; the handled messages sit in a collapsed, scrollable disclosure that is never
  narrated item by item. A problem someone else handles carries an owner chip (`handledBy`).
  Skipped count as one muted line.
- **Mail:** Gmail look, Gmail icon. Rows: sender, subject, snippet, date, account chip, action
  word. Notifications as one line of counts.
- **Obsidian triage:** Obsidian look and icon. Items grouped by source note, each group headed by
  the note with an open link. Each item: text, proposed project, heading, priority as small
  selects.
- **Retro:** each item is evidence from where it happened: a terminal view of the transcript lines
  (tool call, hook error in warning style, assistant reaction) for Claude Code or Pi, then the
  proposed fix as a small diff with its file. At the bottom of the chapter: one confirmation area to
  spawn fix sessions (per item: approve toggle, harness and account, prompt preview), then a single
  confirm button.
- **Instructions:** one row per change: scope, one-line summary, my opinion, verdict (final, watch,
  attention) as a fill, and state chips committed, pushed, built (built only for mpx). Link icon.
- **AI news:** mixed sources, not only Claude: source icon, title, one-line summary, date, thumbs
  up/down votes.
- **Action points:** to-do list: checkbox, text, a detail line with why and where it came from,
  source icon link, handoff (`you` or `agent`) as a toggle; save choices button at the bottom. Each
  point gets its own narrated beat.

## States

Playing, paused, chapter with `status: quiet` (one short hold), source warning on a chapter,
hover and focus on every control, selected calendar event, Slack disclosure open, retro session
approved.

## Review feedback (verbatim, 2026-10-16)

> The largest issue with this brief that I'm checking, like today's brief, are that it's too heavy
> on the data and buttons and everything. I think that we should improve the readability
> significantly. It should mainly serve as my morning brief that I just watch through and maybe act
> on some points at the end. but there shouldn't be more text than I'm able to read during the
> narration. So for example the first slide We probably do not have to show the all areas or maybe
> it could be something like a right sidebar. However, I guess that we go through all the areas and
> we already have them in the outline. So probably not necessary to display this. The information
> about work calendar being skipped because of the connector. that should be at most an icon as a
> warning icon in the calendar section of the outline i actually like the idea of the outline on
> the left especially if it automatically changes but we should probably improve the styling
> significantly
>
> I guess that we might use something like middle area of the page to be the main section where the
> eyes should be in and not the full width of the screen unless it's necessary. this way the
> components can be really compact and can still be readable with all parts visible at least
> peripherally i like the fact that there are links to stuff which might need attention or which
> can be opened but they should probably be represented by icon only buttons rather than texts.
>
> The highlighting of the stuff that's being narrated that's a must-have and it's handled well.
> Let's just improve the styling and make sure that the skill talks about how it is important to
> always narrate the thing that is highlighted and never leave highlight if we start talking about
> something else.
>
> If we want to display more than one day in the calendar, which we might in case that we're
> displaying something that happens tomorrow before 10 or the previous days, if the time range is
> larger, we should implement multiple calendar columns rather than giving a different format like
> we are doing for the tomorrow before 10. in the draft brief. Actually, maybe it would be useful to
> also see the tomorrow's whole day. Maybe it can be less focused in the narration, but it should
> probably be displayed in full. This way we can have always two columns and sometimes more if
> previous days are included. The styling should represent my calendars much better, probably with
> full background and not just the left border. By the way, the left border on cards or items is a
> prime example of AI slop and should be removed everywhere. Background for highlighting is always
> preferred. I like colors. They express a lot at first glance so we should rather use background
> than left border. Borders and outlines are good for highlighting. Background for information. We
> should make sure that the text is still readable. By the way the current calendar text is maybe
> too small we could bump it up a bit
>
> By the way, the general controls of the brief should also be clear. Icon-only buttons are
> preferred. That should probably be done for the speed controls. Next and previous buttons should
> rather be next to the play and or pause buttons. i guess there is no need to have separate play
> and pause buttons for an area and for the same brief let's just always use the brief and users
> can jump in between chapters by appropriate buttons we should have a button to go to next chapter
> and next larger chapter like section and chapter i don't know how you call them But there are
> some subsections in an area, so the buttons closest to play button should jump to next subsection
> of the area. And then there are outer buttons further from the play button, which jump to the
> next section of the outline. I hope you understand me if you don't then please ask me. The
> calendar columns should probably be narrower. Again when we do not use when we do not have to use
> the whole width we should prefer readability and maybe move the items to the middle with
> appropriate default width which might increase the readability.
>
> I'm reviewing the third area which is merge requests and work in general. Again, we should
> significantly improve the highlighting and styling. Backgrounds should be probably used to
> indicate the current state of the item and there should be as little text as possible. So for
> example I see there are some additional pipeline information at the bottom of your save
> components section. Information that there is something dirty. This should probably be handled
> automatically. And the pipeline information might just be something like a link in the merge
> request card rather than this lengthy text information. Again, as little text as possible. Icons
> can signal more than text and coloring can also help.
>
> In the slack chapter we should probably not focus on the answered ones and only try to pinpoint
> anything that is worth knowing or that wasn't answered. The section that was answered and I
> probably addressed everything that was necessary that should be maybe listed under some scrollbar
> or something. if I want to take a look but not being narrated I guess. basically if it was
> addressed I don't need to know about it I think or maybe like one sentence at maximum for example
> saying yesterday you addressed the failing feature test there was a review ask which is already
> handled and you already addressed the forms from Jordan.
>
> First should be the unaddressed stuff, then the worth knowing, and then anything that was
> addressed very briefly.
>
> The mail section is fine. Improve the styling and for example for email, we might put a Gmail icon
> somewhere close to it. And maybe restyle it a bit so it looks like Gmail actually. This again
> gives me an immediate idea what I'm looking at. Calendar should look like Google Calendar, Gmail
> should look like my Gmail. [...] This applies to all sections. Try to make them look like their
> native environment. Obsidian triage for example can have the Obsidian icon somewhere at the top
> and maybe we could Create separate sections to be clear where does the triage node come from. For
> example, if there are multiple nodes coming from ideas, then let's group them together. And if
> there are multiple ones coming from daily node, let's group them together as well.
>
> The retro section doesn't seem good. You should improve it significantly. Try to make it look as
> evidence from wherever it was. If it's from Claude code CLI, then maybe you should rather use
> something like a terminal-like view with warning style description of what's going on. with a
> fixed suggestion there is really a lot you can improve there and also we talked about how to spawn
> sessions that might fix these issues and i don't see these controls anywhere so please improve it
> if it's like a confirmation button it should be at the bottom rather than something like we have
> now at the top
>
> For the instructions, you should probably give me your opinion and state for each instruction
> change. For example, something changed in the mpx-output style. You could comment on this looking
> like a final change and doesn't need any attention. Same for the others. It should be brief, so if
> the change is large, you should summarize it and give me your opinion on it. Also, you could
> comment if it's correctly committed and built (in case of mpx system) or not.
>
> I know you are a Claude model, but I wouldn't like all the news being about Claude only. Feel
> free to mix it up.
>
> and the action point summary again, like restyle it properly.

Earlier direction (2026-10-15): "deslopify the AI design [...] take inspiration in my prejemesi
project [...] It should be pleasant, it could even be something like cartoonish or playful."

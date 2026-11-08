---
name: packing-list
description:
  'Builds a printable, shareable packing list page for a trip: gathers the trip facts, drafts the
  items from earlier lists in Obsidian, fills in product photos, asks about anything unclear and
  publishes it as a Claude artifact; also updates an existing trip list'
argument-hint: '[trip description | existing trip folder]'
triggers:
  packing list; what to pack; balení; seznam na cestu
metadata:
  author: MartinoPolo
  version: '0.1'
  category: utility
  mpx:
    schemaVersion: 1
    skillPacks: [personal]
    defaultExposure: explicit-only
---

# Packing list

Turn a trip into one page I can tick off on my phone and print on one A4 sheet: three columns of
outlined rows, a photo per item, one checkbox per physical piece, light and dark themes. Rows can be
dragged within and between sections, and a second layout sorts the same items into bags (suitcase,
backpack, worn on the way, plus bags I add), with inner bags such as a toiletry bag one level deep.
Badges show each item's and each piece's bag in the first layout, and every section and bag can be
renamed, given another icon, or added on the page. Use
`the invocation input` as the trip description, or as the folder of a trip to update.

`<skill-dir>` is the loaded skill directory. Trips live in `<MPX_AI_RETAINED>/_PACKING/<place>-<yyyy-mm>/`;
each is a copy of `<skill-dir>/template/` plus its own `packing-data.js`, `images/` and `dist/`.
Labels and notes on the page are in Czech, like my notes.

Never book, pay, check in or submit a form while gathering facts. Publishing the list and writing
the vault note are part of this skill; anything else that sends or changes data needs my approval.

## 1. Gather the trip facts

Collect these before drafting, each with its source: destination and dates (nights), travellers
(children's ages matter), transport legs and luggage allowance, accommodation and what it provides
(pool, gym, sauna, towels, kitchen), programme or planned activities, dress code, weather forecast,
power sockets, and anything to arrange before leaving.

Search on your own first, in this order, and stop a source once it gives nothing new:

1. The working home's own notes: a `know/travel.md` (my gear, habits and where bookings arrive) and
   any `state/` file about this trip.
2. Connected mail, calendar and Drive in the trip window: bookings, tickets, itineraries,
   invitations, programmes. Read attachments where a tool can open them. A mailbox the connectors
   cannot reach is read in Claude in Chrome when it is connected.
3. The web: the accommodation's facilities, the forecast (climate averages beyond ten days), the
   carrier's luggage rules.

Write the facts with their sources to `trip-facts.md` in the trip folder. For each fact still
missing that would change what to pack, ask in one numbered list whether I can point to where it is
or should just answer it, and wait.

## 2. Find the earlier lists

- Obsidian: `<MPX_OBSIDIAN_VAULT>/Seznamy dovolené, výlety/`, one note per trip type named
  `<days> - <place> - <transport> - <season>.md`; a repeat trip adds a `# <Place> <MM.YYYY>` section at
  the top. Read the one or two notes closest in length, transport and season, newest section first.
- Earlier pages: every `<MPX_AI_RETAINED>/_PACKING/*/packing-data.js`. Their item ids already have
  photos, so reuse an id whenever the item is the same thing.

## 3. Draft and settle the list

Start from the closest earlier list and adapt it to the facts: weather, activities, what the
accommodation provides, luggage limits, the travellers. Sections sort by kind, in this order so the three columns read
morning and electronics, clothes, then hygiene: `Ráno` (`highlight`), `Elektro`, `Oblečení`,
`Hygiena & zdraví`, other sections where they fit, `Možná` last and `optional`. Where things travel
(worn, backpack, suitcase) is the bag layout's job, so clothes worn on the way stay in `Oblečení`
with `bag: 'na-sebe'`. `Ráno` holds the departure-morning tasks and last-minute items; things to
arrange days before go in `trip-facts.md`, not on the page.

Then ask, in one numbered list, about every uncertain item: those skipped or marked `[-]` or `?` in
earlier lists, those that depend on a missing fact, and new items the facts suggest. Give each a
recommendation. Wait for the answers; an unanswered item goes to `Možná`.

## 4. Build the page

1. `node "<skill-dir>/scripts/packing-trip.mjs" sync <trip-dir>` copies the template in. It never
   touches `packing-data.js`, `images/` or `dist/`, so it also upgrades an older trip.
2. Write `packing-data.js` in the shape of
   [`reference/packing-data.example.js`](reference/packing-data.example.js). Ids are persistence keys:
   lowercase ASCII with hyphens, and stable once the page is published.
3. `node "<skill-dir>/scripts/packing-trip.mjs" photos <trip-dir>` copies photos of reused ids from
   earlier trips and lists the items still without one.
4. For each of those, find a product packshot on a plain white or transparent ground (sports and
   household shops, the maker's own site), download it to `MPX_TEMP`, then convert it:
   `python "<skill-dir>/scripts/packing_photo.py" <download> <trip-dir>/images/<id>.webp`.
   Look at the result; when it still shows a background or a person, try another picture. An item
   with no clean picture keeps its emoji. Put a section or item in a bag, or add an inner bag, only
   when it is certain (travel clothes are worn, the toiletry bag goes in the suitcase); I sort the
   rest on the page.
5. `node <trip-dir>/build-artifact.cjs` writes `dist/packing-list.html` with the photos embedded and
   lists any item still showing an emoji. Open `index.html` locally, or preview the artifact, once.

## 5. Publish and record

- Publish `dist/packing-list.html` as an artifact with `capabilities: {"db":{}}` (ticks and edits sync
  across devices) and `icon: "checklist"`; on later builds republish to the same URL. An artifact
  belongs to the account that published it, so republish from that account.
- Save the settled list to the vault in its note's format (a new section at the top of the matching
  note, or a new note), Tasks checkboxes, `Možná` items included.
- Record the URL, the trip folder and the account in `trip-facts.md`, and in the home's `state/` file
  for the trip when one exists.

## Updating a trip

Given a trip folder or published list: edit its `packing-data.js` (keep ids), run `photos`, rebuild
and republish to the same URL, then update the vault section. Ticks and page edits (order, bags,
renamed or added sections, bags and items) live in the artifact's database under `storageKey`, so a
republish to the same URL keeps them and a new URL starts empty; to carry ticks over, write the old
`checked` keys to the new artifact's `lists/<storageKey>` document.

The database is the only copy of the viewer's work. Before every republish or database write, save
`lists/<storageKey>` to `<trip-dir>/db-snapshot/` (the artifact database tool's read with an output
folder); write back only changed fields, pinned to the version read, never the whole document.
Items added on the page (`edits.added`, ids `vlastni-…`) get a photo at `images/<their id>.webp`;
leave them in the database rather than moving them into `packing-data.js`. Run `sync` first when the
template has changed since the trip was built.

## Changing the page

The page is a Svelte app in `app/`, compiled into `template/packing-app.js`, so a trip build needs no
toolchain. After changing `app/`, run `node "<skill-dir>/scripts/build-app.mjs"` from the mpx checkout
(it uses the mpx dev dependencies), then `sync` and rebuild the trips. Keep CSS multi-column layout
off the screen: re-laying it out after every tick made the page lag.

## Final report

```markdown
List: [artifact URL] (account) · Folder: [trip-dir] · Vault: [note]
Facts: [found, with sources] · Missing: [facts still unknown]
Items: [count]; photos reused [n], new [n], emoji only [ids]
```

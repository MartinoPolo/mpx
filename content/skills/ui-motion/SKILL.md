---
name: ui-motion
description:
  'Motion values and patterns for UI: duration and easing tokens, enter and exit, press and hover
  feedback, reveals, staggers, layout moves, and reduced motion. Use whenever UI animations,
  transitions, or motion tokens are being created, edited, reviewed, or discussed.'
triggers:
  creating, editing, reviewing, or discussing UI animations, transitions, hover or press effects,
  overlays, list reveals, or motion tokens
metadata:
  author: MartinoPolo
  version: '0.1'
  category: design
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: normal
---

# UI Motion: values and patterns

The `ui-motion` rule states the principles; this skill gives the values. Values live as tokens in
the project's global stylesheet (`src/app.css` in the SvelteKit template). A JavaScript mirror for
Web Animations must import or match them. A project that deliberately deviates records the value in
its own tokens and decisions; follow the project.

## Tokens

| Token               | Value                             | Use                                           |
| ------------------- | --------------------------------- | --------------------------------------------- |
| `--duration-fast`   | 100 ms                            | press, hover color, toggles, tooltips         |
| `--duration-normal` | 200 ms                            | dropdowns, popovers, selects, small reveals   |
| `--duration-slow`   | 300 ms                            | dialogs, larger surfaces                      |
| `--duration-drawer` | 400 ms                            | sheets and drawers sliding a full edge        |
| `--exit-ratio`      | 0.8                               | exit duration = entry duration x ratio        |
| `--ease-out`        | cubic-bezier(0.23, 1, 0.32, 1)    | entering, responding, press                   |
| `--ease-in-out`     | cubic-bezier(0.77, 0, 0.175, 1)   | an element moving between two on-screen spots |
| `--ease-drawer`     | cubic-bezier(0.32, 0.72, 0, 1)    | sheets and drawers                            |
| `--ease-spring`     | cubic-bezier(0.34, 1.56, 0.64, 1) | decorative, playful lift only; never overlays |
| `--press-scale`     | 0.97                              | every pressable surface                       |
| `--enter-scale`     | 0.95                              | overlay and pop-in start                      |
| `--reveal-step`     | 30 ms                             | stagger step (20-50 ms range)                 |

Built-in CSS `ease` and `ease-in` are not tokens; replace them.

## Patterns

- Overlays (dropdown, popover, select, tooltip): opacity 0 -> 1 and scale `--enter-scale` -> 1 at
  `--duration-normal`, `--ease-out`, transform-origin at the trigger; exit fades and shrinks at
  `--exit-ratio`. Dialogs use the same from center at `--duration-slow`. Scrims fade only, no blur.
- Tooltips: delay the first one; once one is open, adjacent tooltips open instantly without animation.
- Press: `scale: var(--press-scale)` while active, `--duration-fast`, `--ease-out`; release returns
  at the same speed. Segmented controls and tabs use their selection slide as the feedback instead.
- Hover lift: translate a few px on the visible surface only, under `(hover: hover)`; the hit target
  stays put.
- Reveal: translate 8-16 px plus opacity, 250-300 ms, `--ease-out`, `--reveal-step` stagger, last
  item settled within about 400 ms. Marketing or one-off pages may run slower; repeatedly visited
  app surfaces must not.
- Layout change (reorder, filter, resize): FLIP with transform; travel duration grows with distance
  under a speed cap and a floor, e.g. max(floor, distance / speed). Elements without a visible
  start or end fade in place instead of travelling.
- Size change of a container: snap the size, animate the content; never transition width, height or
  max-width.
- Number and text changes: crossfade or roll; never animate on every keystroke.

## When not to animate

- Actions from the keyboard, actions repeated many times per session, and typing.
- Data the user has already seen on this surface (re-renders, refetches, back navigation).
- Continuous decorative loops on work surfaces; loops are for loading states only.

## Reduced motion

Gate movement with `@media (prefers-reduced-motion: no-preference)` so the reduced case is the
default. Under `reduce`: no translate, scale, rotate, parallax or stagger; keep opacity and color
transitions at `--duration-fast`. Background drift and decorative motion stop entirely.

## Performance

- Animate `transform`, `opacity`, and individual `translate`/`scale`/`rotate` properties only.
- `filter` and `backdrop-filter` only on small, short-lived elements.
- `will-change` only on elements about to animate, removed afterwards.
- Do not animate a custom property on an ancestor of many children; it restyles the whole subtree.

## Verification

Review motion at a slowed playback rate (browser DevTools animations panel) and on a low-end device
profile. Components with meaningful motion get a Storybook "Motion" story; play functions and unit
tests never assert on animation timing.

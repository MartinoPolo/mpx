---
scope: global
selector: ui-motion
description: 'Principles for UI animation, transitions, and press and hover feedback'
paths:
  - '**/*.svelte'
  - '**/*.tsx'
  - '**/*.jsx'
  - '**/*.vue'
  - '**/*.html'
  - '**/*.css'
  - '**/*.scss'
  - '**/*_variants.ts'
applyTo: '**/*.svelte, **/*.tsx, **/*.jsx, **/*.vue, **/*.html, **/*.css, **/*.scss, **/*_variants.ts'
---

# UI Motion

Values and patterns live in the `mpx-ui-motion` skill; load it before creating or changing motion.

- Animate only to explain: a state change, where something came from, or that an input landed. Skip motion on keyboard-driven and high-frequency actions.
- Use the project's duration, easing and scale tokens; never raw milliseconds, cubic-beziers or scale factors in components.
- Keep interface motion under 300 ms, feedback faster still. Only full-edge sheets and distance-based travel run longer.
- Ease out for anything entering or responding; ease in-out for movement on screen; linear only for progress and spinners; never ease-in on entry.
- Exits run shorter than entries (the project's exit ratio) and only fade or shrink.
- Animate transform and opacity only. Never width, height, max-width, top, left, margin or padding; move layout with FLIP.
- No blur or backdrop-filter on large or animating surfaces.
- Enter from opacity 0 and the project's enter-scale token, never scale 0; popovers grow from their trigger, dialogs from center.
- Pressable surfaces scale down slightly on press via the project's press-scale token, unless another motion already acknowledges the press.
- Prefer transitions over keyframes for toggled states so an interruption reverses from the current value.
- Stagger lists by the project's reveal-step token and keep the whole sequence short; reveal on first view, not on every revisit.
- Hover motion only under `(hover: hover)`; the hit area never moves with the visible surface.
- Under `prefers-reduced-motion`, remove movement and scaling; keep opacity and color changes.

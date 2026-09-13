# Focus mode that looks like focus, and a passive check-in

Decided with Colt on 2026-09-12 after the first focus deck shipped. Two
independent pieces of work.

## 1. Focus mode matches the mockup, and is the default

The focus deck merged on 2026-09-12 reused the accordion's set editor inside a
card, so switching it on changed almost nothing on screen. The target is the
deck prototypes from the design round:

- `docs/design-log/2026-09-07-world-class/screenshots/e-deck-v3.png`
- `docs/design-log/2026-09-07-world-class/screenshots/t1-barbell.png`
- the non-barbell states `t2-dumbbell.png` … `t6-activation.png`

One exercise fills the phone. From top to bottom: exercise name and
`set 2 of 3`; the sets already logged for it (`1 · 112.5 × 5`); the load as the
largest thing on screen with its unit; the drawn bar (`PlateBar`, already in the
app) and the per-side breakdown; `last time`; reps as a large editable number
with the target; the rest clock with its progress bar; and a bottom row of
`−step`, a large LOG SET, `+step`. A quiet `next · <exercise>` line and a
`view workout` control are the only chrome. No app header, tab bar, cards, or
status grids while focused.

Decisions:

- Focus mode is the DEFAULT presentation for eligible sessions. The FOCUS MODE
  PREVIEW switch is removed (plan Task 8). The workout overview stays one tap
  away and keeps everything the accordion does.
- Same session state, same write paths. This is a presentation change: it must
  not add a second copy of drafts, change how sets, corrections, voids, rest or
  the outbox work, or touch any hard rule in CLAUDE.md.
- Non-barbell movements follow the morph prototypes: dumbbells show the
  per-hand number the way the app already records `load_entry`, bodyweight and
  cable hide the bar, carries show time, activations are a single tick.
- The existing cream theme and fonts. No cast-iron reskin, no textures.

## 2. Check-in: any time, as little as one word

The morning panel asked three scale questions and a scheduled prompt nagged for
it. Colt wants the opposite: open it whenever, say how you feel in your own
words, and leave. Some days zero check-ins, some days ten.

Decisions:

- One sheet: a text box ("How are you feeling?", dictation works), tap chips
  (Sore, Hurt, Tired, Stressed, Great) that add their word to the text, and an
  optional 1–5 energy tap. Saves with any one of the three filled. No required
  field beyond that.
- Stored as a `checkins` row, `kind = 'spontaneous'`, `note` + `energy`, through
  the outbox like every other write. Unlimited per day. The table already
  exists (20260907040000); no new capture table.
- No daily prompt. The in-app morning nag and the scheduled readiness prompt
  stop. The three readiness scales stay available inside the sheet, collapsed,
  for days someone wants them; `daily_readiness` history is untouched.
- Processing happens on the backend, not in the form:
  - an MCP read tool `get_checkins` so Claude Desktop, Claude Code and ChatGPT
    can pull recent check-ins with their timestamps;
  - the Haiku memory pass also reads new check-ins, so "my achilles hurts"
    becomes a `coach_memory` fact the lifter can see and delete. It never blocks
    or fails the check-in itself.
- Not chosen: attaching recent check-ins to every in-app coach turn.

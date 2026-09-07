# Critique — round 1

Method per Technique 3 of the article: a SEPARATE agent, on a bigger model
(Opus), given **only the three screenshots** and the context of use. It never
saw the code, the CSS, the seed strings, or any of the reasoning below — so it
could not be argued into agreeing with the person who built the thing.

Stopping bar set in advance: **9/10**.

Images judged:

- `screenshots/a-baseline.png` — the shipped app
- `screenshots/b-rail.png` — structural redesign 1
- `screenshots/c-deck.png` — structural redesign 2

## Scores

|                       | baseline | rail  | deck    |
| --------------------- | -------- | ----- | ------- |
| Glanceability         | 2        | 7     | 8       |
| Hierarchy             | 2        | 7     | 9       |
| Distinctiveness       | 4        | 6     | 7       |
| One-handed ergonomics | 4        | 9     | 7       |
| Information density   | 3        | 8     | 6       |
| Craft                 | 4        | 6     | 6       |
| **Overall**           | **3**    | **7** | **7.5** |

**Nothing cleared 9.** The critic's summary of why: deck's advantage "is bought
with emptiness rather than earned by composition, and it drops a stated
secondary requirement (rest) entirely. Rail is competent and unremarkable."

## The findings worth keeping

On the shipped app, judged as a mid-workout screen (which is the job it
actually has to do at the moment it matters most):

- The consequential number, 112.5, appears **once, at ~11px, muted, as the
  third clause of a run-on string**: `1×8-15 @ 60 kg · 1×6-8 @ 85 kg · 3×3-5 @
112.5 kg`. You must parse three prescriptions and know which one you are on.
- **There is no current-set indicator anywhere.**
- The two most reachable controls on the screen — the chat bubble and the bell,
  bottom right — are the two least consequential, and they clip the content
  behind them.
- `TODAY` is printed three times on one screen.
- The bottom note truncates mid-word, teasing a coaching cue you cannot read.
- The week strip runs **four visual states for what is probably three**: a red
  dot under 31, an orange underline and box under 6, and 31/1 in different
  colours and weights.

On the redesigns, the thing that survived contact:

> "the plate diagram in B and C is real product thinking, not decoration, which
> is the strongest evidence in these three that a person was involved."

And the thing that did not:

> Rail's shell is "near-black ground, dark card, orange accent, dot-and-connector
> progress rail. That is the modal fitness-app look."

## AI tells the critic named, unprompted

Worth recording in full, because these are the habits to design against — and
several are in the SHIPPED app, not just the prototypes:

- Floating circular icon buttons stacked at the bottom right, overlapping and
  clipping content. Called "the single most reliable generated-app furniture
  marker."
- A `SYNCED` status label occupying fixed header space for a state that is
  almost always fine.
- Truncated prose with a trailing ellipsis: "Generated layouts clip; designed
  ones size to content or collapse deliberately."
- `NOTE` labelled above a block that is visibly a note. Over-labelling.
- "How are you today?" over a bare rule with no input affordance — "a prompt
  with no input affordance is a placeholder someone forgot to design."
- A segmented progress bar directly beneath the text `SET 2 OF 3`. Two
  encodings of one fact.
- Symmetric centred composition with large equal dead bands top and bottom:
  "default vertical centring presented as restraint."
- Letterspaced uppercase micro-labels on every secondary string — "the current
  house style of generated UI and it no longer signals anything."

That last one is uncomfortable, because it is the shipped app's house style.

## The 12 changes to take deck to 9+

1. Delete the two dead bands (~350px of 844 carrying nothing).
2. Fix the decimal — `112 . 5` reads as two numbers. Set `.5` at ~55–60px,
   tighten tracking to ~−0.02em.
3. Add the rest countdown in the freed band; drop the `41:12` elapsed clock,
   which is not actionable mid-set.
4. Reps `3-5` from ~24px to ~48px; delete the words `TARGET` and `REPS`.
5. Delete `TOP SET` — set position is already stated twice.
6. Resolve the top bar's granularity (it shows session-wide segments while
   `SET 2 / 3` below refers to the exercise).
7. Replace swipe with tap, or add a tap fallback; take the bar to 96px.
   "Chalky fingers break sustained-contact gestures."
8. Add − / + load controls. There is currently no way to log anything other
   than exactly what was prescribed — "which is most sets."
9. Reserve green for the action only. It currently does three unrelated jobs.
10. Plate diagram to ~70px so the count is verifiable, or delete it. "At 44px
    it is a picture of plates, not a check against them."
11. `NEXT ·` at 11px is below resolution. 15px or cut.
12. Remove the seam between the chevron box and the swipe bar.

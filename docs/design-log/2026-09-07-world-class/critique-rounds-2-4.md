# Critique — rounds 2, 3 and 4

Same method throughout: a separate Opus agent, screenshots only, no code, 9/10
stopping bar. Each round was told what changes had been requested, and asked to
mark each ADDRESSED / PARTIALLY / NOT / MADE WORSE from what it could see.

---

## Round 2 — deck v2 → **7/10** (down from 7.5)

Eight of twelve items landed. The score fell anyway, because satisfying the
letter of a critique is not the same as improving the design.

**The regression that mattered.** Item 2 was "fix the decimal — `112 . 5` reads
as two numbers." I shrank the fraction to ~40% of the integer:

> "It now reads as one number, 112, with a footnote... At arm's length under
> fatigue the fractional part is the first thing that drops out of the glance,
> and on a barbell that is the difference between right and wrong. **You solved
> the ambiguity by making the ambiguous half invisible.**"

**Other regressions I introduced while "fixing" things:**

- Deleted the legible set counter (`SET 2 / 3`) and added a _silent_ three-dot
  list at a different granularity. "Two silent encodings instead of one silent
  and one legible."
- Removed one seam from the button row and created two.
- Turned one mid-screen void into two.

**Ergonomics, on the ± buttons:** "In v2 a wrong tap was physically impossible;
now it's a 5kg error one thumb-width away. Literal compliance, functional
regression."

---

## Round 3 — deck v3 → **7/10** ("a different 7, not a higher one")

The best thing in this round was picking one alignment axis: "Title, sub-label,
numeral, last-time, plate bar, reps, next, timer, and the LOG SET edge all land
on x≈25. Clean."

**New problems it introduced:**

1. **No unit anywhere on the screen.** Asked to demote the floating `KG`, I
   deleted every unit instead — on a screen where the difference between kg and
   lb is a 2.2× error.
2. **The plate diagram lost its key.** Asked to cut one of two redundant plate
   encodings, I cut the _text_ and kept the colour code. "You deleted the legend
   and kept the code, for the single most consequential fact on the screen."
3. ± became adjacent 48px targets.

**And the note that redirected everything:**

> "Convention, executed with taste — carrying one genuinely distinctive asset it
> currently wastes... **The move: make the plate diagram the weight display.**
> From four feet away you read the _silhouette_ of the load before you read
> digits, and silhouette is precisely what you're about to verify against the
> actual bar."

That is the best idea in the whole exercise, and it came from the critic.
(It then needed Colt's correction — see the README — because taken literally it
inverts the hierarchy the feature exists to provide.)

---

## Round 4 — bar v2 → **5.5/10**

This round the critic worked at pixel level: crops, ink-band scans, contrast
math. The score dropped hardest here because the measurement got stricter, and
because a domain error became visible.

### The domain bug

> "**The plate diagram is loaded backwards.** Every lifter loads heaviest first,
> against the sleeve shoulder. Correct order centre-to-outboard: red 25, blue 20,
> chrome 1.25, collar, sleeve end... This is a domain error your exact user
> catches in half a second, and it now sits 12px above a caption that states the
> correct order."

Fixed: the two stacks were swapped, so the left carried the right side's order.

### Measured findings

- **AA contrast.** `#6B6B60` on `#EFEADA` = **4.48:1**. AA small text needs 4.50.
  Under by 0.02, on four of nine text elements.
- **The paper texture was imperceptible.** "Standard deviation 0.54 luminance
  levels across a range of 4 (236-240 R). That is imperceptible on any display
  in any lighting." A generated asset that cannot be seen is bytes in the
  precache for nothing.
- **The knurl was worse than what it replaced.** "At 8px tall it renders as
  grey-and-white high-frequency noise, brighter than the bar it sits on, at the
  optical center of the layout. It reads as a compression artifact, not steel.
  The CSS gradient it replaced was cleaner." → cut.
- **The hero was out of the column.** "Ink starts at x=31; every other element
  starts at x=24-26." → `margin-left: -7px`.
- **The decimal, measured.** "Digit-to-digit gaps are 3px and 6px. The gaps
  flanking the period are 21px and 20px... so `112.5` occupies 59px of
  near-empty space in its middle."
- **A false group.** The "next exercise" line sat 18px above the rest timer and
  48px below reps, so "adjacency says it labels the timer." → cut.
- **Spacing was not actually two values.** "Measured ink gaps: 9, 177, 19, 11,
  44, 47, 48, 18, 12, 13... Box margins may well be 10 and 40 in CSS. **The eye
  measures ink**, and ink says six values, not two."

### My own regression, again

Applying the decimal fix I over-tightened to `-0.34em`, which did not tighten the
period — it deleted it. `112 5`. On the one number that must not be misread.
Backed off to `-0.1em`.

### The closing verdict

> "The path to 9 is not more polish on this composition. It is deciding that the
> barbell **is** the interface and not an illustration beneath the number, and
> being right about what goes on it."

> "A Hevy user would notice two things: the paper-and-ink look, and the barbell
> picture. The barbell is the only genuinely new idea in the deck — rendering the
> load as a physical thing you look at rather than a number you compute is a real
> product thought, and it is worth building on."

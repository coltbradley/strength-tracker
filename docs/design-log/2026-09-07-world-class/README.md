# Applying "How to turn your AI into a world-class designer" to this app

2026-09-07. Source: Anshu Chimala, guest post on Lenny's Newsletter.

Everything here is exploration on the `design/world-class` branch. **Nothing in
it ships to Valentine's app.** The prototypes are standalone HTML under
`pwa/public/proto/`; the theme overlays are under `pwa/public/themes/`.

## The thesis, and why it applies here

LLMs are next-token predictors, so they make "consistent, safe choices that fit
everyone's preferences" at every step. Great design "bends the rules and
delights users with memorable, unexpected choices" — the opposite of what a
model does by default. The article's seven techniques are all mechanisms for
escaping that default.

Two of the seven could not be applied literally, and the reason is a hard
constraint rather than taste: **the service worker caches nothing cross-origin**,
so a hotlinked image or a webfont `@import` silently breaks the offline promise
this app makes to someone in a basement gym. Technique 4 (image generation) was
therefore applied as _generate → download → self-host_. Technique 5 (video) was
skipped: there is no motion here that a video asset would serve, and the weight
budget is precache weight.

## What actually happened, in order

### Technique 1 — seed strings

Six strings from `/dev/urandom`, not from a model's idea of randomness:

```
Zwe7e5GANgAUEtx1jSaFLas9   mu97SfzzTSriEOI3GaNkabRL
WU3iyDn7u1vuLgxQju1LhHX9   6CH0BXvfoC37ZuvHSMnmFa3I
9NoUfcFq4nGAL6OtJ3zGr7LB   ftX3MRdWHjLbp0Y8dIXLu9eb
```

Each was read for its _pattern_, and the pattern became a brief: caps-then-digits
reads as a freight manifest; a doubled `zz` in lowercase reads hand-set; spiky
ascenders read as a waveform; `6CH0` reads chemical.

→ `themes/freight.css`, `riso.css`, `crt.css`, `swiss.css`, `blueprint.css`,
rendered over the _real_ app (screenshots `theme-1` … `theme-5`).

### The first correction: this was recolouring, not designing

Colt, mid-run: _"change how everything is designed, not just colors."_

He was right, and it is the exact failure the article predicts. Five palette
swaps are five safe choices. The structural insight only arrived when the
question changed from "how should this look" to **"what is this thing?"**

> The app is currently a DOCUMENT. Lifting is not a document. It is a sequence
> of timed physical events where one thing matters at a time, read one-handed,
> sweaty, at arm's length.

That produced two structural prototypes — `rail.html` (the session as a track
you descend, not a list you scroll) and `deck.html` (no list at all; one set
fills the screen) — and one genuinely useful idea, `plates.js`: decompose the
load into the plates you actually put on the bar. `112.5 kg` is a number you
then do arithmetic on, chalked up, between sets. `25 + 20 + 1.25 per side` is
the instruction.

### Technique 3 — the design critic

A separate agent on a bigger model (Opus), given **only screenshots**, never the
code or the reasoning. Stopping bar fixed in advance at 9/10.

This was by far the highest-value technique, and it worked because it could not
be argued with. Four rounds:

| round | subject                | score                                          |
| ----- | ---------------------- | ---------------------------------------------- |
| 1     | baseline / rail / deck | 3 / 7 / **7.5**                                |
| 2     | deck v2                | **7** — _went down_                            |
| 3     | deck v3                | **7** — "a different 7, not a higher one"      |
| 4     | bar v2                 | **5.5** — pixel-level pass, found a domain bug |

**Nothing ever cleared 9.** That is the honest result.

What the critic caught that I did not:

- **Round 2 regression.** I "fixed" the ambiguous decimal in `112.5` by shrinking
  the fraction — which made the safety-critical half-kilo the weakest glyph on
  the screen. "You solved the ambiguity by making the ambiguous half invisible."
- **Round 3 regression.** I moved the ± controls to opposite corners as asked and
  made ergonomics _worse_: "right-thumb reach cannot cover x<80 and x>310 in the
  same grip."
- **Round 4, the real one.** The plate diagram was **loaded backwards**. A bar is
  loaded heaviest-first against the sleeve shoulder; mine had the 25s outboard
  and the collar inboard. The caption directly beneath it stated the correct
  order, so the contradiction sat inside a single glance. "This is a domain error
  your exact user catches in half a second, and it converts your one distinctive
  asset into the thing an experienced lifter distrusts first."
- **AA contrast.** `#6b6b60` on the paper ground measures 4.48:1. AA needs 4.50.
  Under, by 0.02, on four of nine text elements — against this repo's own rule.

Full transcripts: `critique-round-1.md`, and the round 2–4 findings are recorded
in `critique-rounds-2-4.md`.

### Technique 4 — image generation

Two assets via fal.ai (FLUX dev), downloaded, compressed, self-hosted:

- `pwa/public/tex/paper.webp` (2.3 KB) — real cardstock grain, replacing a CSS
  gradient pretending to be one.
- `pwa/public/tex/knurl.webp` (9.4 KB) — macro of a knurled barbell shaft.

**The knurl was then cut.** The critic measured it: at 8px tall it rendered as
grey-and-white high-frequency noise, brighter than the bar it sat on, at the
optical centre of the layout. "It reads as a compression artifact, not steel.
The CSS gradient it replaced was cleaner." Generated imagery is not automatically
an upgrade — it has to survive the size it is actually used at. The file is kept
for the record; the shipping prototype uses a flat rule.

### Technique 6 — cut what does not add value

Removed across rounds: `TOP SET`, `TARGET`, `REPS`, `load this`, the elapsed
session clock, a three-dot set list, the 12-segment progress bar, the duplicate
plate-maths text, and the "next exercise" line. The article's line held up:
"AI loves to add more, but it rarely takes away."

### Technique 7 — remove AI tells

The critic named these unprompted, and several are in the **shipped** app, not
the prototypes:

- Floating circular icon buttons stacked bottom-right, overlapping content —
  "the single most reliable generated-app furniture marker."
- A `SYNCED` status label holding fixed header space for a state that is almost
  always fine.
- Prose truncated mid-word with an ellipsis: "Generated layouts clip; designed
  ones size to content or collapse deliberately."
- `TODAY` printed three times on one screen.
- `NOTE` labelled above a block that is visibly a note.
- "How are you today?" over a bare rule with no input affordance — "a prompt with
  no input affordance is a placeholder someone forgot to design."
- Letterspaced uppercase micro-labels on every secondary string — "the current
  house style of generated UI; it no longer signals anything."

That last one is this app's house style.

## The second correction, and the one that mattered most

The critic proposed making the plate diagram _be_ the weight display. I
implemented it literally, at which point 126px plates were out-shouting an 80px
numeral. Colt caught it:

> _"definitely have a number, reading plates is the issue the plate calculator
> is trying to solve."_

This is the sharpest point in the whole exercise and neither the model building
it nor the model criticising it made it. **The number is the fact. The plates
are the instruction for executing it.** A feature that exists to spare you from
reading plates must not make plates the thing you read. Hierarchy has to say so.

## Where it ended up

`proto/deck5.html` → `screenshots/h-bar-v3.png`. Number as hero, plate diagram
subordinate on the same axis and loaded correctly, one gap isolating the weight,
every control in one thumb's grip, unit restored, AA met.

It is a **7**, not a 9.

## What to do next, per the critic

> "The path to 9 is not more polish on this composition. It is deciding that the
> barbell **is** the interface and not an illustration beneath the number, and
> being right about what goes on it."

And its answer to "distinctive, or well-executed convention?":

> "Well-executed convention with one distinctive ornament and a distinctive skin.
> The information architecture is exactly Hevy and Strong... It is the same
> object in a nicer typeface on nicer paper. The barbell is the only genuinely
> new idea in the deck."

## Lessons worth keeping

1. **A critic that cannot see your code is worth more than one that can.** Every
   real finding came from the constraint, not from the model's cleverness.
2. **Score going DOWN is the loop working.** Rounds 2 and 3 each introduced
   regressions while satisfying the letter of the previous critique. Literal
   compliance is not improvement.
3. **Domain truth beats visual polish.** The barbell being loaded backwards
   would have discredited the entire feature, and no amount of typography would
   have saved it.
4. **Generated assets must earn their pixels at the size used.** A beautiful
   1024px knurl is noise at 8px.
5. **The human correction outperformed both models.** Twice — "not just colors",
   and "the number is the point". The technique that produced the most value was
   not on the article's list: someone who knows the actual job, interrupting.

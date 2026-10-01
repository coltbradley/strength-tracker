# Version D session redesign

## Status

Proposed 2026-10-01 from the Claude Design handoff (`Version D - Combined`,
review board of 2026-09-30) and the user's decisions in that conversation. This
is a design specification, not authorization to change runtime code beyond the
plan in `docs/superpowers/plans/2026-10-01-version-d-implementation.md`. A
WIP skeleton of Phase 1 (`6035d8b`) is already on the branch; everything it
does not yet cover is specified here.

It supersedes, in part, three earlier specs. Where they disagree with this
document, this document wins, and each carries a pointer back here:

- `2026-09-12-session-focus-deck-design.md` (default screen carries only the
  hero; everything else behind `•••`; superset logs as one **Log round**).
- `2026-09-12-warm-precision-redesign.md` (healthy sync state disappears;
  check-in and calendar leave Train; Train never estimates a duration).
- `2026-09-23-training-scenes-design.md` (rest sits at the top; secondary
  controls live in the workout menu; arrows are the first-release reorder).

`AGENTS.md` and `docs/decisions.md` still bind. Section "Invariants" lists the
ones this redesign leans on hardest.

## Goals, in the user's words

From the 2026-09-30 design conversation:

- "I think we need a 'focus mode' like in A and C. B being just the ledger
  doesn't help me when I just want to know what's next. I need to parse too
  much data."
- "I like the design direction of C but I don't want it to be native dark mode
  ... I want to default to light mode."
- "I like in C how we have RPE, NOTE, SKIP, and Plates as little buttons."
- "I like the coach notes in C as well."
- "The plates in C could use some help: different size for different weights."
- "Per hand dumbbells should show 1 dumbbell or two dumbbells, and if you click
  it, it switches (1 to 2 to 1) with text explaining what it is."
- "We need to handle the bodyweight condition."
- "In the 'today's workout' or the overview section ... can we drag and drop to
  rearrange?"
- "It's also unclear if I change the weight during a rest, am I changing the
  weight for a previous section?"
- "Can we have icons for machine vs dumbbell vs plate? And we need to be able to
  change the bar weight for the plates calculation. The barbell is 45, the leg
  press sled is 200 something, the calf raise machine is 25, the chest press
  plate machine is 25."
- "For exercises like chest press or leg press where there's a sled with plates
  OR the machine version, we need to be able to switch between the two easily
  depending on what's open."
- "The record needs to be a bit easier to navigate ... the most recent ones
  should show up at the top. If we do an exercise a lot, it should be there at
  the top. We should be able to set an exercise as a goal and have it 'pinned'
  vs just searching through millions of exercises."
- "From B, I like this ledger style as one view ... right now it feels busy."
- Later: "the big and small plates are on the wrong side"; "Give them colors, it
  should just be one donut vs two on the ends"; "We need a different icon for
  the pin stack"; "can this become a link to start the next step? ... a
  possibility to skip the rest or end it early"; "is there a world where we
  still show the diagrams here? for the active exercise."
- On the 14-point review: "Apply and fix everything."

## Decisions (made by the user, stated as decisions)

1. **Delivered as phased PRs.** Phase 1 live workout; Phase 2 Train; Phase 3
   Record. Each merges and is phone-tested before the next starts. Branches are
   in the plan.
2. **Light mode only for now.** Every colour is a token on `:root` in
   `pwa/src/styles.css`'s token layer, so a dark theme is a later token swap and
   not part of this work. The prototype's Dark switch is not built.
3. **Per-exercise prefs sync through a new Supabase table**, separate PR,
   branch `feat/exercise-prefs-sync`, which writes its own `docs/decisions.md`
   entry. This spec only cross-references it. Until it merges, Version D uses
   the device-local `ExercisePref` exactly as shipped (`barKg`, `loadStyle`,
   per-side).
4. **Phase 1 covers the full live-workout list** in "Live workout" below.
5. **Phase 2 and 3 scope** as in "Train" and "Record" below.

## Proposal versus shipped

The prototype re-presents shipped behaviour and adds proposals. Both are in
scope here, but a reviewer must be able to tell which is which. "Shipped" means
`main` at `d5e7b64`.

| Element | Status |
| --- | --- |
| Focus deck, overview, rest strip, plate bar, per-side dumbbells, bodyweight reps-first, skip with reason, swap, fix last set, outbox sheet, sync states | Shipped; Version D re-lays it out |
| Header `☰ n/m`, Focus/List toggle, round `✓` sync chip | Proposal (re-presents shipped overview and sync chip) |
| Drawn load picture: plates sized and coloured by weight, dumbbells 1 to 2 with weight-coloured heads, pin stack, bodyweight card | Proposal. Plate bar is shipped; the rest is new drawing over shipped facts |
| Plate sheet with base-weight stepper and sled/stack switch | Proposal. Base weight and `LoadStyle` are shipped but chosen from presets and a device-local picker |
| Rest in the middle band with last-saved-set card and LOAD NEXT plates | Proposal |
| Dock: load and reps side by side, four keys, full-width Log | Proposal |
| `End rest now ›` | Proposal. The shipped clock can be dismissed; ending it early is new wording and a REST OVER state |
| Superset member by member, rest after A2 | Proposal; replaces the shipped **Log round** batch |
| Drag to reorder in "Today's workout" | Proposal. Shipped reorder is arrows in the plan editor only; the session screen cannot reorder at all |
| Bodyweight added-load row | Proposal, and it reverses a declined item (2026-08-27); see Bodyweight |
| Units this session (override) | Proposal. Shipped: a device-wide switch in the header |
| Train week strip with state words, Go | Go is shipped on Train. The week strip is shipped on Program only (Train is the sparse home of warm-precision); moving it to Train, top-aligned, with state words is proposal |
| Record: Pinned goals and Recent | Proposal. Goals exist (`goals`, `v_goal_progress`) but only the coach writes them |
| Dark theme, Ledger (full per-set receipts), coach "proposed change" card, calendar sheet, training maxes, exercise demos, OAuth consent | Not in this work |

## Global rules

- **Tap targets.** Every control is at least 44 x 44 CSS px, including the
  steppers, the keys, the header buttons and each week-strip cell (see the
  320 px exception under Train).
- **Text floor.** Nothing that carries meaning is smaller than 11px. 9 and 10px
  mono labels in the prototype are raised to 11px. Decorative glyphs may be
  smaller only if a text equivalent is present.
- **Contrast.** Text clears WCAG AA on the light canvas. The accent `#57417f`
  is for actions; the ochre current-set colour `#855600` is reserved for the
  current set, never a warning or a button. The prototype's secondary ink
  (`rgba(43,39,51,.68)`) is about 4.9:1 on `#f7f6fa`; keep it no lighter.
- **Colour is never the only cue.** Plate weight is also in the caption text,
  set state is also a glyph and word, sync state is a glyph and a word.
- **Layout checks.** Every screen is verified at 390 px, at 320 px, and at 320
  px with text scaled to 1.3x (the prototype's `frameWidth` and `textScale`
  switches). No horizontal page scroll. On the live workout screen at 320 x 640
  and 1.3x the Log button is visible without scrolling the page; the middle
  band scrolls internally when it must. The prototype's 320 and 1.3x figures
  were reconstructed, not measured on a phone; the plan requires a real-device
  check before each phase is called done.
- **Motion.** Per training-scenes: motion marks a state change, honours
  `prefers-reduced-motion`, never loops, and the rest clock never animates per
  tick. Nothing in the clock logs, skips or finishes anything.
- **Theme.** Colours come from the token layer only. No colour literal in a
  component or in an SVG `fill` except the plate and dumbbell weight palette,
  which are informational and live as named tokens (`--plate-45` etc.), not
  inline hex. Do not add a theme file.
- **Copy.** Strings below are exact. Add new ones in the same plain voice; no
  engineering copy (the prototype's "RECENT FIRST . MOST DONE BREAKS TIES" was
  rejected for that reason).

## Live workout (Phase 1)

The screen is three bands: **header** (fixed), **middle** (scrolls when it
must), **dock** (fixed to the bottom). The tab bar is hidden during a session as
today.

### Header

Left to right: `☰ 9/25` button, a two-way **Focus | List** control, the sync
chip.

- `☰ n/m` is completed working sets over planned working sets for the session
  (warmups excluded, to match the shipped progress count). It opens the
  "Today's workout" sheet (below). Accessible name: "Open workout, 9 of 25 sets
  done".
- **Focus | List** switches presentation only (shipped rule: draft, rest clock
  and selection survive). **List** is the existing overview presentation, with
  the focus and overview transition rules of the 2026-09-12 spec unchanged. The
  prototype's per-set ledger rows (`◐ on phone`, `! review`) are a later
  refinement of List, not Phase 1.
- Sync chip, 44px. When everything is saved it is a round `✓` with no label.
  Otherwise it widens to glyph plus word: `On phone . n`, `Sending . n`,
  `Held`, `Review` (`Review` on the error fill). Tapping opens the shipped
  outbox sheet. Accessible name states the whole state ("Sync status: all
  saved"). It never disappears: the user's review finding that nothing says a
  set was saved outweighed the quiet-when-healthy rule.
- The units note appears beside the chip, text only, only while a session unit
  override is active ("kg this session").
- Exercise name and `SET 4 OF 6` sit directly under the header, with the
  segmented set line (done = filled, current = ochre, future = outlined, plus
  text). Set position appears here once and nowhere else, except the dock label
  during rest (below). A warmup set appends ` . WARMUP`.

### Middle band, loaded exercise (not resting)

In order:

1. **Load picture** (below), a single tappable control.
2. **Coach cue** when the prescription has one: a speech-bubble icon, ink text,
   `Coach . {cue}`. Not ochre. Ochre means current set only.
3. **Last time** line when reliable history exists ("Last time . 180 lb x 5").
4. After all planned sets: `All planned sets logged.` and `+ Extra set`. The
   dock then offers Finish session (primary) per training-scenes.

### Load picture

One drawing per load style, always followed by a caption line and, when it opens
something, a quiet action line. The diagram is supplementary to text; the
caption states the same fact.

| Load | Drawing | Caption | Action line | Tap |
| --- | --- | --- | --- | --- |
| Barbell or plate-loaded machine (`LoadStyle` plates) | Bar with plates each side, **small plates outside, big plates against the bar** (the user corrected this). Height and width scale with plate weight; colour by weight class (palette below). One donut per plate, symmetrical about the bar | `45 + 25 per side` | `Bar 45 lb . change >` (`Sled 230 lb . change >` for a sled) | Opens plate sheet |
| Dumbbell, per hand | One or two dumbbells, **one coloured head on each end** (a single donut, not stacked). Head height grows with weight (24px + weight/3 lb, capped +28px). Two dumbbells show a `+` between them | Two: `50 + 50 = 100 lb total`. One: `50 lb . one dumbbell is the total` | `Tap for one dumbbell` or `Tap for two dumbbells` | Toggles one and two, converting the staged number so the entered weight is unchanged and the total changes |
| Pin-stack machine | A stack of ten rows, rows up to the pin shaded, a `<` marking the pin | `Pin at 40 lb` | `Pin-stack machine . the number on the pin is the load` (Leg Press: `. tap to switch to the plate sled`) | Leg Press only: opens plate sheet |
| Bodyweight | No drawing. Card: `Bodyweight` and `Reps only. Your bodyweight isn't added to the load.` | n/a | `+ Add load (belt or vest)` | Adds the added-load row |
| Band, cable, other | The small equipment card with a generic icon | Shipped copy | none | none |

Dumbbell head colours by weight (pounds; kilograms are converted first), the
same palette as plates: under 20 dark, 20 and over green, 35 yellow, 50 blue,
70 red. Plate classes follow the plate inventory (`pwa/src/lib/plates.ts`); the
palette is informational and never inherits the theme accent.

Dumbbell mode is the per-side convention. `load_kg` stays the total; the one/two
toggle changes `load_entry` between `'total'` and `'per_side'` exactly as the
shipped control does. It must not double or halve what was typed without
showing both numbers.

The prototype computes pin-stack row counts from the load alone, which invents a
position. Per the 2026-09-12 non-goal ("no cable-stack-pin visualization without
real metadata") the drawing here is **illustrative only**: it shades a number of
rows proportional to load within the stack's range if `ExercisePref` carries
one, and otherwise draws a fixed neutral stack with the caption number as the
only claim. Open question 1.

### Bodyweight

Reps are the hero (the review's first finding). Added load is a secondary row
under the reps stepper: `+ 25 lb added` with `-`, `+` and `x` (remove). No grey
"BW" tile. The `+ Add load (belt or vest)` link is small text, not a pill.
Copy when load is on: `Reps count most. The added load is logged with each
set.` Bodyweight with no added load is unchanged: a 0 kg set, reps only.

**Added load is new, and it reverses a declined item.** The 2026-08-27 decision
("per-side load") records "bodyweight + added load" as considered and declined,
and defines `load_kg` as the total system load, which for a weighted pull-up
would be bodyweight plus the belt, a number the app does not hold per set. The
prototype's copy says the opposite: "Your bodyweight isn't added to the load."
So a positive `load_kg` here would be the added mass only, and `v_e1rm`
(`load_kg > 0`) would then compute an e1RM from the belt alone. This conflict
needs an answer before the added-load write path ships (open question 8). Until
then the row is built and tested but gated off by a single constant, and
bodyweight remains reps-first without it.

### Rest (middle band)

Resting replaces the load picture's slot, not the screen. In order:

1. Rest card: `RESTING` with `-30` and `+30` (44px), the clock in tabular
   numerals, and a thin progress bar. `role="timer"`, announced politely at
   most on the minute and at zero.
2. **Last set card**, one tap target: `LAST SET . ALREADY SAVED`, the saved set
   (`185 lb x 5`), its receipt (`synced`, `on phone`, or `needs review`, with a
   glyph), and a `Fix` affordance that opens the shipped correction flow. This
   answers the user's question: editing the dock during rest changes the NEXT
   set; the last set is read-only here and changes only through Fix (a void plus
   a re-insert at the same `set_index`).
3. **LOAD NEXT** card: a compact load picture for the next set, with caption
   (`45 + 25 per side`), tap opens the plate sheet. This keeps the diagram
   visible during rest, which is when the bar is loaded (user: "is there a world
   where we still show the diagrams here?"). Stack and dumbbell exercises show
   their own compact picture instead.
4. When the clock is past target: the card becomes `REST OVER`, `Ready when you
   are.`, and `1:47 since the last set . target 1:30`. It is fixed text, not an
   animation.

**Ending rest early.** In the dock label row, a text link `End rest now >`
(44px high). Tapping it moves the card to REST OVER immediately. It changes
what the screen shows; it does not log, skip or advance anything, and the
`rest_seconds` stamped on the next logged set is still the real elapsed time
since the previous set. (User: "doesn't need to be an actual button but should
be a possibility to skip the rest or end it early".)

The dock label reads `NEXT SET . 4 OF 6` only while resting or after rest ends
and the next set is staged; otherwise there is no label (the header already
says it). For a superset it reads `NEXT SET . A1 . {name}`.

### Dock

Fixed to the bottom, in order:

1. Label row (above) with `End rest now >` when applicable.
2. **Load and reps side by side**, one row: `[-] 185 lb [+]` and `[-] 5 reps
   [+]`. The load value is a button that opens the number pad. Load caption
   under the number follows the load style: `lb total`, `lb each hand`,
   `lb . pin`, `lb added . belt or vest`. Bodyweight shows reps only in this
   row, large (the added-load row is in the middle band). Tick-only work shows
   neither; timed work is unchanged (still blocked, see out of scope).
3. **Four keys**, equal width: `RPE`, `Note`, `Skip`, and **`Swap`, or `Fix
   last` when the entry cannot be swapped**. There is no Plates key: tapping the
   diagram is how plates open (the review's finding 6). `Note` opens the set
   note for the last logged set when one exists, otherwise the shipped More
   sheet. `RPE` opens the shipped RPE-and-logged-sets sheet.
4. **Log**, full width. Labels: `Log set`, `Log A1` / `Log A2`, `Done`
   (tick-only), `Saving...` while the local commit is in flight, `Log extra
   set` after the plan is met. It keeps the 200ms duplicate-tap lock. Warmup
   and "Already warm" controls stay on the hero as shipped
   (`2026-09-16-live-session-adaptation`); where they sit in the new dock is
   open question 2.

### Superset round

A paired superset of two consecutive rep-tracked entries is one focus unit with
**member-by-member logging**, replacing **Log round**.

- Middle band: label `A1 THEN A2 . REST AFTER A2`, two member cards. Each shows
  its tag, name, `185 lb x 8`, and state: `NOW`, `done` check, or `NEXT`.
  The NOW card is ochre-edged. A hint line: `Start the round with A1. Rest comes
  after A2.` then, once A1 is logged, `A1 logged. Go straight to A2. Rest comes
  after the round.`
- Under the cards, the **load picture of the NOW member** with `A1 . 45 per
  side` / `A2 . Pin at 40 lb` and its action line. It follows NOW, so the
  diagram always matches the numbers in the dock.
- Dock: same load and reps row, editing the NOW member, and a `Log A1` /
  `Log A2` button. Round position appears once, in the header
  (`SUPERSET A . ROUND 2 OF 3`).
- Each `Log` is one ordinary set insert through the single-set path. The rest
  clock starts after A2 only. A1 logged and A2 not is a normal state, not a
  recovery state; there is no `Log A1 only` secondary action. This changes the
  2026-09-12 and 2026-09-23 decision that a round is one durable local batch;
  see the decision entry and open question 3.
- Groups of three or more members still fall back to the List, as today.

### Plate sheet

Opened by the diagram, the LOAD NEXT card, or (Leg Press) the stack card. Title
`Plates`. Contents:

- `185 lb total` and the diagram.
- `45 + 25 per side`. If the load cannot be made with the inventory:
  `{n} lb can't be made with these plates` (shipped text).
- **Which machine?** `Plate sled | Pin stack`, only for an exercise that can be
  either (Leg Press, chest press). The active choice is filled. Switching sets
  the load separately for the other machine and says so in a toast: `Pin-stack
  Leg Press. Different machine, so the load is set separately.` This is
  `ExercisePref.loadStyle`.
- **BASE WEIGHT . BAR** (or `SLED`) `45 lb` with `-`, `Type`, `+` (44px each).
  Hidden for a pin stack, where it does not apply. `Type` opens the in-app
  number pad, not `window.prompt` (the prototype's prompt was a stand-in the
  user was told about). No preset chips.
- Footer: `Remembered for {exercise}. Only changes how plates are worked out;
  the logged load is still the total.` Until `feat/exercise-prefs-sync` merges
  the footer says `on this phone`; after it, `on your account`.

Base weight stays presentation. It is never a column on `sets` or
`prescriptions`.

### "Today's workout" sheet

Opened by `☰ n/m`. Title `Today's workout`.

- `Units this session` with `lb | kg` and `Settings keeps your default`. This is
  a session-scoped override: it changes what is shown and staged for this
  session only and never writes the device setting. Stored values are kg
  regardless. It replaces the always-visible header switch.
- Hint: `Tap to jump. Drag ⠿ to change today's order. The plan stays the same.`
- One row per **unit** (a ramp or a superset pair is one row and moves as one):
  drag handle, section label, state glyph, name(s), scheme, set count `2/4`.
  Tap jumps focus to it. The handle is 44px wide.
- `Finish session`.

**Reorder never changes the locked plan.** It changes the order in which this
session presents its entries and nothing else: no write to `planned_workouts`,
`prescriptions` or any table. It lives in the session's persisted local mirror
(so a reload keeps it) and is lost with the session. Rows already done stay
where they are; only upcoming units can move. Drag is an enhancement: every row
also offers `Move up` / `Move down` actions reachable by keyboard and screen
reader, because training-scenes made arrows the accessible path and drag cannot
be the only one.

### States to cover (Phase 1)

Loaded plates, plates plus warmup, per-hand dumbbells (one and two), unit switch
while a value is staged, superset A1 NOW and A2 NOW, bodyweight, bodyweight plus
added load, timed (still List-only), completion-only, rest, rest over, rest
after A2, plate sheet, plate sheet with sled/stack, Today's workout sheet,
reorder in progress, correction open, all planned sets done, offline, held and
failed sync chip.

## Train (Phase 2)

Top-aligned. The previous screen pinned content to the bottom and left a gap
under the week strip (review finding 8).

Top to bottom:

1. Header: `SET` wordmark, `Coach` (with ` . offline` when applicable), settings
   gear, sync chip.
2. Date row `WEDNESDAY 30 SEP` and a quiet `Check in` text button.
3. **Week strip**: seven cells, each weekday and date, a glyph, and a state word
   at 11px. Words: `DONE`, `SKIP`, `TODAY`, `REST`, `NEXT`, `DRAFT`. The shipped
   `MISSED` state (a past planned day never done) must keep a word: `MISS`.
   Glyphs `✓ - ● ○ ◌`. Today's cell is outlined in the accent. Tapping a cell
   previews that day inline, as shipped.
4. Banners, when applicable: `Offline. Showing the plan saved on this phone.`
   and `Couldn't refresh. Showing the saved plan; logging works.`
5. **Day card**, by state:
   - Planned today: `TODAY . {program}`, workout name, `{shape}`, `FIRST UP`
     with the first movement and `then {second movement}`, and the coach note
     (`Coach . ...`, ink with icon).
   - In progress: `IN PROGRESS`, name, `9/25 sets`.
   - Done: `Lower A finished . all sets on the server` only when the outbox is
     empty; otherwise `Lower A finished . 3 sets still on this phone`. Then
     `REST DAY`, `Recover.`, and `NEXT . {date}`, name, shape.
   - Draft: name, `Draft. Nothing planned in it yet. Not a missed day.`
   - Loading, offline with no cache, no plan: shipped copy.
6. **Go** (planned today), `Resume`, `See the plan`, `Fill in this day`,
   `Start empty session`, or the no-plan pair. Go opens the read-only workout
   preview; only Start creates the session (shipped; unchanged).

Contradictions with shipped rules and the prototype, resolved here:

- The prototype shows `about 65 min`. The data model has no duration, and
  warm-precision rules out estimating one. **Omit it.** Show shape only.
- The prototype adds `Check in` to Train. Warm-precision moved check-in to
  Program. Version D's placement is adopted as a small text button because the
  user approved the direction; open question 4.
- The prototype's third tab is `Plan`. The shipped tab is `Program`. **Keep
  `Program`.** Open question 5.
- At 320 px, seven cells are at most 41px wide (288 / 7). Cells are 44px high and
  as wide as the strip allows; this is a documented exception to the 44px rule
  and needs a phone check.

## Record (Phase 3)

Replaces the picker-first screen with a navigable index.

1. `Record` title and a search field, `Search your exercises`.
2. Empty state: `Your record starts with your first finished session.`
3. **PINNED GOALS**, shown only when at least one exists. Each row: name, meta
   (`14 sessions . last WED 23 SEP`), a quiet `◆ Pinned` text toggle, then the
   current e1RM, `Goal 250 lb . 90%`, and a progress bar. The bar is the
   emphasis; the toggle is a state, not a primary button (review finding 10).
4. **RECENT**. Just that word. Sorted by most recently performed; ties on the
   same date are broken by most sessions done. This is deliberate: the user
   asked for recent first, and for exercises done a lot to stay high. Each row
   has a quiet `◇ Pin` toggle.
5. `Search the full library` opens the exercise picker for anything else.
6. A bodyweight row with `Log`, as shipped.
7. **Detail** (tap a row): `< Record`, name, meta, `GOAL . ESTIMATED 1RM` with
   `Pin as goal` or, when pinned, the target with `-` and `+` steppers (step 5 lb
   or the kg equivalent), then the shipped e1RM chart, weekly working sets and
   recent sessions.

Pin means a goal. Pinning writes a `goals` row (`exercise_id`,
`target_e1rm_kg`), initial target the current e1RM times 1.1 rounded up to the
next 5 lb (or 2.5 kg) step; unpinning removes it. An exercise with no e1RM data
cannot be pinned (the toggle is absent), because a target with no baseline is
invented. Both writes are PWA writes under existing owner RLS, a first for
`goals`; open questions 6 and 7.

Recency and session counts per exercise are derived metrics, so they come from
a view over `v_live_sets`, never a stored column (see plan, Phase 3).

## Invariants that must not change

1. **`load_kg` is the total system load.** A pair of 30 kg dumbbells is 60. The
   one/two toggle, base weight, sled/stack switch, pin drawing, unit override
   and added load never change what the column means. `load_entry` records how
   the number was entered; single-arm work is `'total'`.
2. **`sets` is append-only.** No update or delete path appears. Fix is a void
   plus a new row at the same `set_index` with the same `performed_at`, rest
   and prescription (`pwa/src/lib/corrections.ts`). Editing the dock during rest
   cannot touch a saved set. Reordering writes nothing.
3. **Plan lock.** A day any session references is immutable. Reordering in
   "Today's workout" is session-local presentation, never a prescription edit
   and never a plan RPC.
4. **Per-side.** What is shown per hand or per side is never presented as the
   total, and the total is never presented as per hand.
5. **Durable-first logging.** A set shows as saved only after the local outbox
   commit. `setsLoaded`/`setsFailed` guards stay. Staged drafts, the rest clock
   and selection survive Focus/List, sheet opens and Today's-workout reorder.
6. **Base weight is presentation**, never a database column on `sets` or
   `prescriptions` (`docs/decisions.md`, "Live session adaptation"). The prefs table of
   `feat/exercise-prefs-sync` holds preferences, not loads.
7. **Writes stay PWA-only** for `sets`, `sessions`, `set_voids`, `set_notes`.
   Supersets create no new record type.
8. **Unit override is display and entry only.** Stored values are kg in the
   database everywhere; a value typed in the override unit is accepted exactly,
   with no silent snapping.
9. **Honest claims.** No drawing, caption or Train line states a fact the app
   does not hold (no stack position without metadata, no workout duration, no
   "all sets on the server" while writes are queued).

## Out of scope

- Dark mode (tokens only; no switch, no `Appearance` setting).
- The calendar sheet, training-max entry, exercise demos and the OAuth consent
  screen (listed in the prototype map, not built there).
- The per-set save-status ledger as the List presentation, the structured coach
  "proposed change" card, and the three-step recovery layout of the outbox
  sheet (B and C proposals; the shipped outbox sheet is unchanged).
- Timed focus logging (`tracking = time`) stays List-only until duration
  editing and `duration_seconds` writes have their own plan.
- Three-member circuits.
- The "Tone when rest ends" setting shown in the prototype. Sound and vibration
  need their own decision (training-scenes).
- Pin-stack position metadata, assisted-bodyweight semantics.
- Account-level default unit.
- The exercise-prefs sync table itself (`feat/exercise-prefs-sync`).

## Open questions

1. Pin stack drawing: neutral illustration with the caption as the only claim
   (spec default), or add stack metadata to `ExercisePref` first?
2. Warmup/working toggle and "Already warm": the prototype dock shows no toggle.
   Keep them on the hero as shipped, in the middle band above the load picture?
3. Superset member-by-member: remove `enqueueBatch` and `SupersetRoundEditor`
   as dead code, or keep them? What should happen to a half-finished round if
   the lifter wants to log A2 first?
4. `Check in` on Train, against warm-precision's "check-in lives in Program".
5. Third tab label, `Program` (shipped) or `Plan` (prototype).
6. Unpin deletes a `goals` row. Acceptable, given goals are targets and not
   history, or should unpin keep the row hidden?
7. Should the coach (MCP `set_goal`) and the PWA pin share one goal row per
   exercise? The `unique (user_id, exercise_id)` constraint says yes.
8. Bodyweight added load: what does `load_kg` hold, and how do `v_e1rm` and
   volume treat it? See Bodyweight. Needs a code owner and a decision entry
   before the write path ships.

## Verification

Per phase, the plan's acceptance criteria apply, plus: screenshots at 390, 320
and 320 at 1.3x of every state listed for the phase, saved to
`docs/design-log/2026-10-*-version-d/` with a README in the style of
`docs/design-log/2026-09-12-warm-precision/README.md`; a real-phone pass; and
`AGENTS.md` "Tests, by area" for what each phase touches.

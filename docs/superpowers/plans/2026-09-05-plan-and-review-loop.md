# A plan above the program, and a loop after the session

Written 2026-09-05 from the first session Colt logged against a coach-parsed
day, plus the coach turns, feedback and logs around it. Two asks drove it: a
LONG-TERM plan the in-app coach can build against, and "look at what I just did
and make the whole thing a system rather than a one-off". Design only; nothing
here is built. The sequenced plan keeps the order.

## What the session actually showed

One session, 52 minutes, 21 set rows, one correction, sRPE 6, bodyweight
logged, a session note ("sleep wasn't great"). Nine prescriptions across six
movements, every one trained. That is the app working. The lessons are in the
edges.

**Bands have no home, so the load field got lied to.** Three activation
movements were done with bands. The prescriptions had no load and `tracking:
reps`. Colt typed the band's NOMINAL resistance into the weight field (35 lb, 45
lb) and explained in set notes: "These are with bands, not actual weight",
"Weight doesn't really apply". Those rows are now `working` sets with a load, so
`v_weekly_volume` counts roughly 1.8 t of tonnage that nobody lifted, and any
e1RM over them is fiction. He did the only thing the UI allowed. Set 1 of the
side plank is load 0; sets 2 and 3 are 35 lb, because the grey band was "too
light" and he moved up: that is real, useful information about progression, and
it is trapped in a note.

**Percent prescriptions became prose because the tool refuses them without a
training max.** The coach wrote "60-75% of 1 rep max" and "70-85%" for leg
extensions. `resolveTrainingMaxes` refuses `load_pct_tm` when no TM exists, and
Colt has no TMs, so the coach put the percentages in `prescriptions.notes` and
left the load empty. The strictness is right for a %TM program someone will
train tomorrow; it is wrong for a FIRST session, which is the calibration the
TM would come from. The session produced the number: 130 lb x 5 is an e1RM of
about 69 kg on leg extensions. Nothing will turn that into a TM unless someone
remembers to.

**Parse commentary is rendering mid-set.** `prescriptions.notes` on this day
read "Coach's app left the reps column blank; 10/side set by Colt 2026-09-05"
and "Coach note visible through set 4; set 5 set to repeat by Colt". The rule
that day notes are the coach's own words and parse caveats go in chat exists
for `planned_workouts.notes`. It was never written for the prescription note,
and the model did the natural thing.

**"Per side" is being smuggled through notes.** "10 REPS PER SIDE", "20 REPS
PER SIDE" on three prescriptions, because per-side reps are deliberately not
modelled. TrainingPeaks shows "Reps/side" on the same movements. The coach
writes it, the lifter reads it, the app cannot say it.

**A set note was a note to next time.** Leg extension warmup: "Could be more,
maybe 70?" That is not a fact about the set. It is an instruction to the person
who prescribes the next one, and today nobody reads it before the next one is
prescribed.

**The order changed and nothing recorded that as a preference.** Plan order was
D (leg extensions) then E (ATG split squat). Colt did E first, then D, by
timestamp. Legal, fine, and the next parse of the same screenshots will put D
first again.

**One program per screenshot.** Colt now has "Coach — Lower Strength
(2026-08-27)" and "Coach — Lower + Activation (2026-09-06)", one day each. The
coach names a program per parse because there is nothing above `programs` to
file a day under. Two months of this is sixteen one-day programs and a
`list_programs` result nobody can read. The second user has two programs both
named "My plan", from the app.

**The coach did its job well and was let down by tools twice.** Both turns were
honest and correct. The first found the day unconfirmed and dated tomorrow; the
second confirmed it, could not move it, filed the gap, and told Colt exactly
what to do instead. Both tool failures are fixed in `da552e4`.

## What to do about each, smallest first

| Finding | Change | Size | Needs a decision? |
| --- | --- | --- | --- |
| Parse commentary in prescription notes | Prompt rule extended to `prescriptions.notes`; an eval check that no prescription note contains "Colt", "coach's app", "left blank" or a date | 0.25 | no |
| %TM refused with no TM | Allow `load_pct_tm` with no current TM on an UNCONFIRMED write; the app shows "70-85% of TM (none set)"; the post-session review below proposes the TM | 0.5 | no |
| Set notes that are instructions | Post-session review reads them (see loop below) | in the loop | no |
| Order changed | `repeat_planned_workout` (below) defaults to the order the sets were actually logged in last time, and says so | in the loop | no |
| Bands | `sets.load_entry` gains `'band'`: load_kg is the band's nominal resistance, `v_weekly_volume` and e1RM exclude `load_entry = 'band'`. The session screen offers BAND on exercises whose equipment is `bands`, with the colour/strength typed once and remembered per exercise in device settings. Prescriptions get the same value so the coach can write "strong band". | 1.0 | **yes**: a filter on a set fact (`load_entry`) in the analysis views. Defensible because it is about the set, not the plan, unlike `tracking`. |
| Per-side reps | `prescriptions.per_side boolean default false`, carried to `sets`. Display "10/side". Volume counts reps as logged (the lifter logs one side's count, as today). Reverses a deliberate non-modelling. | 0.75 | **yes**: reverses a CLAUDE.md rule |
| One program per parse | The plan below | | |

## The long-term plan: structure

### What it is and is not

A plan is the STRATEGY: where this person is going over months, in what phases,
with what emphasis and what progression rule. It is written rarely and revised
deliberately. A program is a set of days; a day is a set of prescriptions. Today
the hierarchy stops at program, so every strategic fact lives in a chat that is
gone, or in `coach_memory`, which is for standing facts about the person and
is capped at 300 characters per fact for a reason.

It is not goals: `goals` already measures an e1RM target against real sets and
the plan REFERENCES goals, it does not restate them. It is not memory: "left
shoulder impingement" is a fact about the body; "Accumulation through October,
then a four-week intensification" is a decision about time.

### Tables

```
training_plans
  id, user_id, objective text (<= 1000), starts_on date, ends_on date,
  source_note text, created_at, superseded_at timestamptz
plan_phases
  id, user_id, plan_id, position int, name text (<= 60),
  starts_on date, ends_on date,
  focus text (<= 300)            -- "hypertrophy on the squat pattern, maintain pull"
  progression text (<= 300)      -- "add 2.5 kg when every working set hits the top of the range"
  sessions_per_week int, primary_exercise_ids text[],
  notes text (<= 1000)
programs.phase_id uuid null references plan_phases
```

One live plan per user (`superseded_at is null`). A revision is a NEW plan row
with the old one superseded, so the history of the strategy is append-only like
everything else here. Phases are ordered, dated, and may not overlap within a
plan (an exclusion constraint on the date range).

`programs.phase_id` is what stops one-program-per-screenshot. The coach files a
parsed day under the current phase's program instead of minting a program per
parse: `upsert_program` gets a `phase_id`, and when a live program already
exists for that phase the write becomes "add these days to it" rather than "a
second program". That is the same shape as `update_planned_workout` at the
program level, and it is the piece that makes `list_programs` readable in
November.

### Who writes it

The plan is written through the MCP from Claude Desktop, by Colt working with
Claude, or by the coach's screenshots being parsed there. The in-app coach
READS it on every turn and cannot write it: `set_training_plan` is disabled at
the connector layer, exactly as `delete_program` is. This is a deliberate
authority split. Strategy is set at a desk with time to think; tactics are set
between sets. A coach that can rewrite the strategy mid-workout because the
lifter is tired is the wrong coach.

Plan writes land unconfirmed, like programs, for the same reason: it steers
every future write.

### How the coach sees it

The context block gains one paragraph, always present, about 80 words:

```
Plan: <objective>. Phase 2 of 4, "Accumulation" (2026-09-01 to 2026-10-12):
<focus>. Progression: <rule>. Next: "Intensification" from 2026-10-13.
```

That is what makes it a plan the agent builds AGAINST rather than a document it
could look up. The prompt rule: a day written or edited must fit the current
phase's focus and progression; when the request contradicts the phase, say so
and ask, do not silently comply. One eval case pins it (a request for a
top-single day inside an accumulation phase should be questioned).

Tools: `get_training_plan` (all clients), `set_training_plan` (Desktop only),
`confirm_training_plan`. `get_program` and `list_programs` show `phase`.

### Rejected

A markdown document per user. Cheaper, and it would work for one person, but
nothing could then know WHICH phase today is in, which is the one fact the
context block needs, and the coach would have to parse dates out of prose on
every turn. Putting phases in `coach_memory`: wrong table, wrong size, wrong
lifetime. Letting the in-app coach write the plan: see above.

## The loop: parse, train, review, repeat

Today each of these exists in isolation. The system is the arrows between them.

### 1. Parse: recognise a day you have seen before

Colt will paste the same coach screenshots again. The coach should notice.
Before `upsert_program`, a new read tool `find_similar_days(exercise_ids[])`
returns planned days whose exercise set overlaps (Jaccard >= 0.6), most recent
first, with what was LOGGED against each last time: loads, reps, the order
actually performed, set notes. The prompt then offers: "This is your Lower +
Activation day from 2026-09-05. Schedule it again on <date> with last time's
loads, or write it fresh?" Repeat is the default; fresh is the exception.

### 2. Repeat: clone a day forward, carrying what was learned

`repeat_planned_workout(planned_workout_id, scheduled_date)` clones a day into
the same program on a new date. Prescriptions copy, with three adjustments the
tool makes and SAYS it made:

- Loads that were logged last time replace planned loads (the same rule the
  app's saved-workout apply already uses in `templateLoads.ts`).
- Prescription order follows the order the sets were actually logged in.
- Set notes from last time that read as instructions ("could be more, maybe
  70") are surfaced in the tool result for the coach to act on, not copied.

### 3. Review: the turn after the session

An entry point on Today's completed-session card for 24 hours: "Review with the
coach". It sends one turn with the session id, and the prompt tells the coach
what a review IS:

- Compare logged to prescribed (`v_adherence` has it).
- Where a prescription said a percentage and no TM exists, propose the TM the
  session implies and offer `set_training_max`.
- Read the set notes. A note about the movement in general ("grey band too
  light, use strong") becomes an `exercise_notes` proposal. A note about next
  time ("maybe 70") becomes a proposed load on the next occurrence.
- Note anything the plan's current phase would say about it.

Nothing is written without a yes. This is Decision 4's proposal card doing
review instead of drafting, and it is where the set notes Colt wrote today
would have gone somewhere.

### 4. Train: what is already there

The session screen, HOW TO, the rest strip, corrections. Unchanged by this.

## Build order

1. Prompt rule for prescription notes, and the eval check. Half a day, and it
   stops the mid-set commentary now.
2. `load_pct_tm` allowed without a TM on unconfirmed writes, shown honestly in
   the app. Half a day.
3. The plan tables, tools, context paragraph and prompt rule. Two days. This
   comes before the loop because the loop's "fits the phase" step needs it.
4. `find_similar_days` and `repeat_planned_workout`, and `upsert_program`
   filing under a phase. One and a half days.
5. The review turn. One day.
6. Bands and per-side reps, after their decision entries. One and three
   quarter days together.

Roughly seven days. None of it is a migration to a table the PWA writes, so the
PWA-only ownership of `sets` and `sessions` holds throughout.

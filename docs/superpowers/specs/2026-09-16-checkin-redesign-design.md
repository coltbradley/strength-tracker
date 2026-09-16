# Check-in redesign

Date: 2026-09-16. Status: design approved in chat, awaiting spec review.
Mockups: https://claude.ai/artifact/XXwbxkJzSWg3XvSMgYQtpd (version 3).
Research inputs (not committed): an intraday check-in pass and a menstrual
cycle pass, both run 2026-09-16. Their conclusions that shaped this spec are
restated where they apply.

## Problem

The current `CheckInSheet` is two forms in one sheet with two save models: a
spontaneous check-in (text, five mood chips, energy, explicit button) and a
folded readiness panel (three autosaving scales, then "Anything else?" with two
more scales, three numeric fields, two checkboxes and a second note box). That
is 13 inputs, two note boxes, and "Energy" and "Fatigue" asking the same thing
in two places. `.pad-sheet` zeroes the sheet's side padding and gap and only
the header gets it back, so every control runs edge to edge. Mood chips are
appended into the note as words, so nothing can count them.

## Goal

Check in whenever you want, in a few seconds, and see how energy and context
change hour to hour and day to day. Training stays the point of the Today
screen; the check-in is as needed.

## Out of scope

- Menstrual cycle tracking. Held. The schema from 20260907040000 stays as it
  is, unused. The research pass found real gaps (contraception method, a status
  history table, stricter privacy handling) that a future spec must address
  before any UI is built on those tables.
- Closing a symptom episode from the app. Episodes opened here stay open; see
  Open questions.
- Push prompts for check-ins. None are added. `dailyEnabled` stays false. The
  existing `daily_readiness` push kind stays; if someone re-enables it, its
  notification opens the new sheet.

## Decisions

1. Every check-in is its own timestamped `checkins` row (kind `spontaneous`).
   Nothing overwrites. A day may have any number.
2. Three inputs, in this order: note, tags, energy 1-5. None is required.
   Check in is disabled only when all three are empty.
3. The entry point is a quiet link, not a card.
4. Tagging Pain opens a three-field follow-up that files the check-in against
   a symptom episode.
5. History gets a week grid of energy by time of day, with a Monday-to-Sunday
   day row beneath it.
6. Energy from check-ins is a pattern signal, not a validated score. There is
   no composite and no whole-day average.

## Today screen

The existing full-width `.checkin-open` line is removed. In its place, the date
eyebrow row above the heading becomes a flex row: date on the left, a link on
the right reading `CHECK IN →`, in the same mono uppercase style as the date.
Tap target at least 44px tall through padding, without growing the row's
visual height. Shown whenever a user id is known, including during an open
session. Nothing else on Today changes.

## The sheet

`CheckInSheet` is rewritten. It keeps its props minus `onSkipped` (the
readiness skip path leaves with the panel).

Layout, top to bottom, with an 18px gutter (`--gutter`) on every row, 16px
(`--s-8`) between groups and 8px (`--s-4`) inside a group:

1. Earlier today: this device's view of today's check-ins as `7:18 3`,
   `11:42 4` (time, energy; a row with no energy shows its time and a dash).
   Hidden when there are none. Read from the cache of the History query plus
   any queued outbox inserts, so an offline check-in appears immediately.
2. Note: label "How are you feeling?", two-row textarea, placeholder "Anything
   worth noting", 1000 character limit (the column's).
3. Tags: six toggle chips, multi-select: Great, Slept badly, Unusually sore,
   Stressed, Sick, Pain.
4. Pain follow-up, shown only while Pain is on (below).
5. Energy: five chips, 1-5, tap again to clear. End labels "drained" and
   "full of it".
6. Check in: primary button, full width. Disabled when note is blank, no tag
   is on and energy is null. On tap: enqueue, toast "Checked in", close.

The sheet no longer contains the readiness scales, the "Anything else?"
fields, or "Not today". Those inputs leave the UI; their columns stay.

The fix for the cramped rendering lives in the stylesheet: the check-in
sheet's body rows get the gutter back rather than relying on `.pad-sheet`'s
zeroed padding. No colour literals; tokens only.

### Tag vocabulary

Tags are stored as values, not words in the note. `Great` exists because a
list that can only name bad things can't show wellbeing rising, which is half
of the finding the readiness work rests on (Saw 2016). `Unusually sore`, not
`Sore`, because normal soreness after lifting would otherwise mark good training
days as bad ones.

Stored values: `great`, `slept_badly`, `unusually_sore`, `stressed`, `sick`,
`pain`. Labels live in `pwa/src/lib/checkins.ts`, next to the vocabulary, and
the database CHECK is the source of truth for what's legal.

### Pain follow-up

Three single-choice groups, each optional:

- Where: Knee, Ankle, Shin, Foot, Hip, Thigh, Lower back, Upper back,
  Shoulder, Elbow, Wrist/hand, Neck, Other.
- Side: Left, Right, Both.
- Did it change training? No, Modified, Stopped.

On Check in with Pain on and a region chosen, the check-in is filed against an
episode:

- Find the user's open episode (`closed_on is null`) with the same
  `body_region` and `side` (Both maps to `bilateral`; no side chosen maps to
  `n/a`). If exactly one exists, use it. If more than one, use the most
  recently opened.
- Otherwise insert a new `symptom_episodes` row (client UUID, `opened_on` =
  device local date) through the outbox, queued ahead of the check-in so the
  foreign key resolves in order.
- When a match is found locally, the follow-up shows "Adds to Left knee, being
  tracked since 2 Sep" under the choices before submit.

Pain on with no region chosen saves the tag and the training answer with no
episode. Matching uses cached episodes; an episode created on another device
that this one hasn't fetched yet can produce a duplicate. That is accepted and
visible, and it is the same trade the outbox makes elsewhere.

The follow-up does not write `symptom_reports` (OSTRC answers are a 7-day
recall instrument and must not be faked from a tap) or `pain_checks` (its
phases are tied to a run and its 0-10 score is required).

## Schema

One new migration, additive only:

```sql
alter table checkins
  add column tags text[] not null default '{}'
    check (tags <@ array['great','slept_badly','unusually_sore',
                         'stressed','sick','pain']::text[]),
  add column episode_id uuid references symptom_episodes (id) on delete set null,
  add column training_impact text
    check (training_impact in ('none','modified','stopped')),
  add constraint checkins_pain_fields
    check ((episode_id is null and training_impact is null) or 'pain' = any (tags));
```

Existing rows get `'{}'`. Their mood words stay in `note` and are not
backfilled: parsing prose into tags would invent data.

The PWA's row builder emits `tags`, `episode_id` and `training_impact` on every
row, per the bulk-insert NULL rule in CLAUDE.md.

The `checkins` table comment is replaced to say rows are events, read
bucketed by time of day, never averaged into `daily_readiness`.

### View

`v_checkin_buckets` (`security_invoker`): one row per user, local date and
bucket, computed at read time with `app_tz(user_id)`.

| column                     | meaning                                                                   |
| -------------------------- | ------------------------------------------------------------------------- |
| `user_id`, `local_date`    | the day, in the row owner's timezone                                      |
| `bucket`                   | `morning` (before 11:00), `midday` (11:00 to 15:59), `evening` (16:00 on) |
| `checkins`                 | count of check-ins in the bucket                                          |
| `energy_n`                 | count with energy present                                                 |
| `energy_mean`              | mean over rows with energy; null when `energy_n` is 0                     |
| `energy_min`, `energy_max` | range                                                                     |
| `tags`                     | distinct tags seen in the bucket                                          |

Every mean ships with its own count, per the existing rule. Buckets are fixed
clock times, not personalised, because a personal split needs weeks of data
nobody has on day one.

## History

A new section in `History.tsx`, labelled `CHECK-INS`, placed after `THIS WEEK`.

- Week header with previous and next arrows and the range ("Mon 7 – Sun 13
  Sep"). Weeks run Monday to Sunday, matching the rest of the app. Next is
  disabled on the current week.
- Grid: rows Morning, Midday, Evening; columns the seven days. A cell with
  energy shows the mean (one decimal unless whole) and `n`; fill is the accent
  at an opacity scaled 1-5, with text switching to the inverse colour past the
  midpoint so it passes contrast. A bucket with check-ins but no energy shows
  `–` with its `n`. A bucket with no check-ins is a dashed empty cell.
- Day row beneath: seven buttons, weekday abbreviation and check-in count.
  Default selection is today on the current week, Monday otherwise. The
  selected column gets an outline in the grid.
- Day detail below: that day's check-ins in time order: time, energy, tags,
  note, and the pain region when filed against an episode. "No check-ins."
  when empty.

Reads go through `fetchWithCache`: `v_checkin_buckets` for the grid, `checkins`
for the day detail, one week at a time.

## Coach and MCP

- `get_checkins` returns `tags`, `training_impact` and the episode's region
  and side. Its description gains: compare a reading only with the same time
  of day, and don't mention a dip until it repeats across several days, the
  same persistence rule the injury tracking already uses.
- A new read-only `get_checkin_buckets` tool returns `v_checkin_buckets` for a
  date range, so the coach can see a pattern without reading every row.
- Nothing is added to the per-turn context block. It already costs tokens on
  every turn; check-ins are asked about occasionally.
- The coach system prompt gets two sentences on the same comparison and
  persistence rules.
- The checkin-memory extraction route is unchanged; it reads `note`.

## Docs

- `docs/decisions.md`: one entry covering the move from a once-a-day anchored
  panel to repeatable timestamped check-ins as the primary subjective capture,
  why tags became a column, why the readiness inputs left the UI while their
  columns stayed, and why energy is bucketed rather than averaged.
- `CLAUDE.md`: rewrite the subjective capture paragraph to match (the sheet
  no longer leads with a disclosure; `daily_readiness` is no longer written by
  the PWA; `checkins.tags` and the pain link exist).

## Testing

- `validate-db.mjs` passes with the new migration: the tag CHECK rejects an
  unknown tag, and the pain constraint rejects an `episode_id` without the pain
  tag.
- Vitest for `checkins.ts`: the row builder emits every column on every row;
  the enabled rule (each input alone enables, all empty disables); episode
  matching (exact region and side, most recent of several, no region means no
  episode, Both maps to bilateral).
- Vitest for the History bucket rendering: mean formatting, empty versus
  no-energy cells, the contrast switch.
- Component test for the sheet: Pain reveals the follow-up and hiding it
  clears its choices; submit enqueues an episode insert ahead of the check-in
  when there's no match.
- Manual: check in offline, confirm it shows under Earlier today and syncs
  in order after reconnecting.

## Open questions

- Episodes opened from a Pain tap never close, because nothing in the app
  closes one yet. Matching still works, but History and the coach will see
  long-open episodes. A follow-up should add "This has cleared up" somewhere.
- The research recommended saving energy the moment it's tapped (under five
  seconds per check-in). This spec keeps an explicit Check in button with the
  note on top, as chosen. Revisit if check-ins turn out to be rare in practice.

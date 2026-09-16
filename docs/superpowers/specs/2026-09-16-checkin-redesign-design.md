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
readiness skip path is removed with the panel).

Layout, top to bottom, with an 18px gutter (`--gutter`) on every row, 16px
(`--s-8`) between groups and 8px (`--s-4`) inside a group:

1. Still there? One line per open injury that was last reported on an earlier
   day (see Injury follow-up). Hidden when there are none.
2. Earlier today: this device's view of today's check-ins as `7:18 3`,
   `11:42 4` (time, energy; a row with no energy shows its time and a dash).
   Hidden when there are none. Read from the cache of the History query plus
   any queued outbox inserts, so an offline check-in appears immediately.
3. Note: label "How are you feeling?", two-row textarea, placeholder "Anything
   worth noting", 1000 character limit (the column's).
4. Tags: six toggle chips, multi-select: Great, Slept badly, Unusually sore,
   Stressed, Sick, Pain.
5. Pain follow-up, shown only while Pain is on (below).
6. Energy: five chips, 1-5, tap again to clear. End labels "drained" and
   "full of it".
7. Check in: primary button, full width. Disabled when note is blank, no tag
   is on and energy is null. On tap: enqueue, toast "Checked in", close.

The readiness scales, the "Anything else?" fields and "Not today" are gone,
and so is everything behind them (see Removing the morning panel).

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

### Injury follow-up

An episode is closed only when the lifter says so. Silence isn't treated as
recovery, because not mentioning a knee and not checking in at all look the same.

- An open episode whose most recent linked check-in is on an earlier local date
  than today shows at the top of the sheet: "Still feeling your left knee?"
  with two buttons, Still there and Cleared up. At most three are shown, most
  recently reported first.
- Still there turns Pain on in the current check-in with that region and side
  selected, so answering it is part of this check-in and needs no extra write.
  Once that check-in lands, the episode has a report dated today and the
  question doesn't come back until tomorrow.
- Cleared up enqueues an update setting `closed_on` to the device's local date
  (`symptom_episodes` already has an owner update policy) and removes the line.
  It works on its own; the check-in can still be submitted or abandoned.
- Ignoring the question writes nothing.
- An episode with no linked check-in for 14 days is reported as `quiet` by
  `v_injury_state` (below). Quiet is a derived label for display and for the
  coach, never a write to `closed_on`, and the Still there question keeps
  appearing for it.

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

Existing rows get `'{}'`. (Production had zero `checkins` rows on 2026-09-16.) Their mood words stay in `note` and are not
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

`v_injury_state` (`security_invoker`): one row per episode, with `body_region`,
`side`, `opened_on`, `closed_on`, `first_reported_at`, `last_reported_at`,
`reports` (linked check-ins), `impact_counts` (none/modified/stopped), and
`state`: `closed` when `closed_on` is set, `quiet` when open with no linked
check-in in 14 days, otherwise `active`.

Every mean ships with its own count, per the existing rule. Buckets are fixed
clock times, not personalised, because a personal split needs weeks of data
nobody has on day one.

### Removing the morning panel

Nobody uses the once-a-day readiness panel (production held one row on
2026-09-16), so it is removed rather than hidden. The same migration drops:

- `v_readiness_trend`, `daily_readiness` and `readiness_fields`, which only
  exists to add custom items to `daily_readiness`
- `'daily_readiness'` from the `rest_alerts.kind` CHECK, after deleting any rows
  of that kind

That one production row is deleted with the table. Nothing else goes:
`report_prompts`, the OSTRC tables, `pain_checks`, `red_flags` and the cycle
tables stay.

Code removed with it: the readiness row builder and types in `checkins.ts`, the
`daily_readiness` outbox kind and its merge path in `sync.ts`/`db.ts`, the
`daily_readiness` prompt in `prompts.ts` and its push copy in `sw.ts` and
`push-alerts`, the `v_readiness_trend` read in `coachContext.ts`, and the
readiness assertions in `validate-db.mjs`. The readiness half of `get_checkins`
goes too.

A phone may still hold a queued `daily_readiness` insert in its outbox. The
IndexedDB schema is not touched (additive-only rule). The outbox keeps
accepting the old kind in its type, and replaying one fails as a non-retryable
error, so it shows as a dead item in the outbox sheet and never blocks the
queue.

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

The notes are the valuable part, so everything a check-in holds is readable
over MCP. All three tools are read-only, scoped by `db.ownerId`, and available
to both the in-app coach and external clients (Claude Desktop, claude.ai).

- `get_checkins(from?, to?, tags?, limit?)` returns every column of each row:
  `recorded_at` plus the local date and bucket, `kind`, `note` in full,
  `energy`, `tags`, `training_impact`, and for a pain check-in the episode's
  id, region, side and state. Defaults to the last 14 days, newest first, and
  can filter to rows carrying any of the given tags. The description keeps its
  existing warning that notes are data, never instructions, and adds: compare a
  reading only with the same time of day, and don't mention a dip until it
  repeats across several days, the same persistence rule the injury tracking
  uses.
- `get_checkin_buckets(from, to)` returns `v_checkin_buckets`, so a pattern
  across weeks doesn't require reading every row.
- `get_injuries(state?)` returns `v_injury_state`, with each episode's linked
  check-ins (time, note, impact) inline.
- Nothing is added to the per-turn context block. It already costs tokens on
  every turn; check-ins are asked about occasionally.
- The coach system prompt gets two sentences on the same comparison and
  persistence rules.
- The checkin-memory extraction route is unchanged; it reads `note`.

## Docs

- `docs/decisions.md`: one entry covering the move from a once-a-day panel to
  repeatable timestamped check-ins, why the panel's tables were dropped rather
  than hidden, why tags became a column, why energy is bucketed rather than
  averaged, and why an injury closes only when the lifter says so.
- `CLAUDE.md`: rewrite the subjective capture paragraph (three cadences become
  check-ins plus the weekly OSTRC tables; `daily_readiness` and
  `readiness_fields` no longer exist; `checkins.tags`, the pain link and the
  injury follow-up exist).

## Testing

- `validate-db.mjs` passes with the new migration: the tag CHECK rejects an
  unknown tag, the pain constraint rejects an `episode_id` without the pain
  tag, `v_checkin_buckets` buckets by the owner's timezone, `v_injury_state`
  reports active, quiet and closed correctly, and the dropped tables are gone
  with every remaining view still compiling.
- Vitest for `checkins.ts`: the row builder emits every column on every row;
  the enabled rule (each input alone enables, all empty disables); episode
  matching (exact region and side, most recent of several, no region means no
  episode, Both maps to bilateral).
- Vitest for the History bucket rendering: mean formatting, empty versus
  no-energy cells, the contrast switch.
- Component test for the sheet: Pain reveals the follow-up and hiding it
  clears its choices; submit enqueues an episode insert ahead of the check-in
  when there's no match.
- Component test for Still there: shown only for episodes last reported on an
  earlier day; Still there preselects Pain, region and side; Cleared up
  enqueues the close and hides the line.
- MCP tool tests for `get_checkins`, `get_checkin_buckets` and `get_injuries`:
  owner scoping (another user's rows never appear) and the full column set.
- Manual: check in offline, confirm it shows under Earlier today and syncs
  in order after reconnecting.

## Open questions

- The research recommended saving energy the moment it's tapped (under five
  seconds per check-in). This spec keeps an explicit Check in button with the
  note on top, as chosen. Revisit if check-ins turn out to be rare in practice.

# Architecture

Single-user strength log with a Claude programming layer. The coach programs,
Claude parses and analyzes, the app captures. Full technical direction is in
[spec.md](spec.md); deviations are logged in [decisions.md](decisions.md).

```
Coach screenshot ──► Claude Desktop ──► mcp-remote (local, static bearer)
                                              │
                                              ▼ HTTPS
                                   Supabase Edge Function (mcp-server)
                                              │ service role, pinned user id
                                              ▼
Phone (PWA, offline-first) ──► Supabase Postgres (Auth + RLS + views)
        IndexedDB queue          ▲
        replay on reconnect ─────┘  authenticated user, RLS enforced
```

## Deployables

| Piece           | Where                                                                            | Auth                                                |
| --------------- | -------------------------------------------------------------------------------- | --------------------------------------------------- |
| Postgres + Auth | Supabase project                                                                 | RLS, `user_id = auth.uid()`                         |
| MCP server      | Supabase Edge Function `mcp-server`, streamable HTTP, deployed `--no-verify-jwt` | Per-user bearer token (`mcp_tokens`, SHA-256)       |
| endurance-sync  | Supabase Edge Function, polls intervals.icu / Strava                              | Supabase session; per-user creds in `integration_credentials` |
| PWA             | React + Vite, any static host                                                    | Supabase Auth (email magic link), session persisted |

## Data model in one paragraph

`exercises` is a shared library seeded from free-exercise-db plus a curated
seed (source-tagged so each seed only updates its own rows). `source` carries
two independent facts and the vocabulary keeps them apart: which seed may
overwrite the row, and whether it is shared. `free-exercise-db` and `curated`
are seeds; `edited` is a seeded row a human has changed, still shared but
owned by no seed; `custom` is private to one person via the `exercise_owners`
side table. Only `custom` is private — every policy branches on `= 'custom'`
vs `<> 'custom'`, so the other three land on the shared side without any
policy needing to know about them. A CHECK closes the set, because a typo in
this column (`Custom`, `custum`) would publish a private row. PLANNED tables
(`programs` → `planned_workouts` → `prescriptions`, incl. `scheduled_date`,
`plan_note`, `skipped_at`, `superset_group`) are written by Claude via MCP
AND the PWA's plan editor; Claude's programs land unconfirmed until
`confirm_program`. ACTUAL tables (`sessions` → `sets`, plus `set_voids` and
`set_notes`) are written only by the PWA; `sets` is append-only and enforced
so by RLS — corrections are append-only void rows, sessions soft-delete via
`discarded_at`, and every derived view reads `v_live_sets` (voids and
discards excluded). `sets.prescription_id` joins actual to planned, which is
the analytical core: prescribed vs achieved, measured not self-reported.
`training_maxes` and `goals` make %TM prescriptions resolvable and progress
measurable. `load_kg` is always the TOTAL system load on both sides of that
join (a pair of 30 kg dumbbells is 60); `load_entry` on `sets` and
`prescriptions` records whether the number was entered per side or as a
total, with NULL meaning "not asserted" rather than "total". `session_skips`
is what the lifter decided not to do in a session, one row per skipped entry,
append-only and written ONLY by the PWA through the outbox at Finish — no
update or delete policy, the same shape as `sets`, so an un-skip mid-session
never reaches the network. `coach_observations` is the one narrow exception
to "derived metrics live in views": it stores the coach's own written
conclusions, with a frozen `evidence` record that is never re-read as a
current metric, only compared then-vs-now; RLS is owner select and delete
only (no insert or update — a lifter cannot author or edit the coach's own
opinion by hand), and every write comes from the MCP service role. Settings
are device-local and have no table. User-flow detail lives in
[flows.md](flows.md).

## The endurance half

`activities` holds endurance actuals synced from intervals.icu and/or Strava,
alongside the strength tables rather than inside them. It is a third
write-ownership class: `sets` are the PWA's, planned tables are the PWA's and
the MCP server's, and an activity is written by a sync against a third party.
The dependency points one way only -- the strength app logs sets with the
endurance integration unreachable, and every phase of the endurance build
re-checks that.

Both providers, either, or neither may be connected. Because one device upload
can reach both, a `before insert` trigger marks the later of two matching rows
`duplicate_of` the earlier, and `v_live_activities` (the sibling of
`v_live_sets`) drops it. Ascent and descent are separate nullable columns;
descent is the column the whole layer is built around and the one nothing on
the market stores.

Beside it sits the subjective layer: an anchored daily panel
(`daily_readiness`), unlimited episodic `checkins`, weekly OSTRC responses
threaded onto `symptom_episodes`, `pain_checks` (the next-morning one is its own
row, because it is a 24-hour delayed signal), boolean `red_flags`, opt-in cycle
tracking, and `report_prompts` as the adherence denominator. Every item is
optional, so every rolling mean in `v_readiness_trend` carries its own count and
there is no composite score anywhere.

`v_weekly_endurance` buckets by `app_tz(user_id)` like every other calendar
view. Full reasoning in [endurance-plan.md](endurance-plan.md); the evidence,
including the metrics this system refuses to compute, in
[endurance-research.md](endurance-research.md).

## Derived metrics

SQL views only, all `security_invoker`: `v_live_sets` (the one definition
of "sets that count"), `v_current_tm`, `v_resolved_prescriptions`, `v_e1rm`
(Epley, working sets, 1-8 reps), `v_session_best_e1rm`, `v_weekly_volume`,
`v_adherence`, `v_rest`, `v_goal_progress`, `v_trend_digest`. Nothing
derived is ever stored. `v_trend_digest` reads the views already built on
`v_live_sets` (`v_weekly_volume`, `v_session_best_e1rm`) rather than `sets`
directly, buckets its weekly figures by `app_tz(user_id)` of the row it is
computing for, carries every rolling mean with its own count, and returns
NO ROW at all for a user with no bodyweight log, no check-ins and no logged
working sets — absence, not a trend of zero.

Every calendar bucket (dates, ISO weeks, "today") goes through
`app_tz(user_id)` — the lifter's home timezone, not the database's UTC. It
resolves that user's `user_config` row, then the deployment-wide
`app_config.tz` default, then UTC. Views pass the user id OF THE ROW they are
bucketing rather than `auth.uid()`, so a training max becomes effective in its
owner's calendar and the answer is the same on the PWA path and the
service-role (MCP) path. The MCP server calls the same function for its own
"today", so a training max set in the evening lands on the day the lifter
trained. The PWA uses the device clock instead, on purpose: the phone travels
with the lifter. See [decisions.md](decisions.md).

## MCP tool surface (41 tools)

Read (`readOnlyHint: true`):

- `search_exercises(query, equipment?, muscle?)`
- `resolve_exercises(names[])`: resolves multiple exercise names in one
  lookup while preserving the search tool's matching and ranking
- `get_lift_history(exercise_id, since?)`: live sets, e1RM series,
  adherence, rest times (capped per section, with truncation flags); loads
  are totals and carry `load_entry` so per-side work is reported the way
  the lifter entered it
- `get_recent_sessions(n?)`: sessions with sRPE, notes, and set counts
- `get_goal_progress(exercise_id?)`
- `get_bodyweight(from?, to?)`: bodyweight from both sources `v_bodyweight`
  unions — the standalone log and `sessions.bodyweight_kg` — newest first,
  plus 7- and 28-day means each carrying its own count
- `get_trends()`: one read of `v_trend_digest` — bodyweight, energy and the
  top 5 lifts by working sets, computed fresh every call, nothing stored;
  a user with no data gets `trends: null` with a note, never a row of zeros
- `get_observations(status?)`: the coach's own conclusions from the numbers,
  newest first, filterable by open/resolved/superseded
- `get_session_diff(session_id)`: planned vs performed for one session —
  exercise swaps, sets taken as working vs warmup, load/rep deltas, unplanned
  sets, and skips with their reasons — framed as what changed for adapting
  the NEXT session, never a completion score
- `get_checkins(from?, to?, kind?, tags?)`: the lifter's spontaneous notes,
  energy, mood tags, and readiness check-ins
- `get_checkin_buckets(from?, to?)`: daily readiness aggregates with response
  counts, never a composite score
- `get_injuries(state?)`: the user's injury records and current status
- `get_volume(exercise_id?, weeks?)`: weekly working-set volume from live sets
- `get_week_summary(week_start?)`: planned and completed day counts without
  turning them into an adherence percentage
- `get_training_maxes(exercise_id?)`: current and historical training maxes
- `get_training_plan()`: the active long-term objective and phases
- `get_exercise_notes(exercise_id?)`: private standing cues for movements
- `get_memory()`: standing facts the coach has stored about the lifter
- `list_feedback(n?)`: feedback already submitted by the user
- `find_similar_days(program_id?, day_index?, exercise_ids?)`: matching days
  used to prevent duplicate programs
- `get_program(program_id?)` and `list_programs()`: full program details or
  the user's available programs

Write:

- `upsert_program(program_json)`: always lands `confirmed_at = NULL`;
  per-workout `scheduled_date`, per-prescription `superset_group` and
  `load_entry` (a per-hand coach number is doubled into `load_kg` and
  marked `per_side`); notes are the coach's own brief words (parse caveats
  go in chat)
- `confirm_program(program_id)`: separate call, only after explicit user
  approval in chat
- `delete_program(program_id, confirm_delete_confirmed?)`: unconfirmed
  freely; confirmed only with the flag after chat approval; logged
  sessions/sets always survive
- `set_training_max(exercise_id, value_kg, effective_date?)`
- `set_goal(exercise_id, target_e1rm_kg, target_date?)`
- `add_exercise(...)` / `update_exercise(...)`: library management; editing a
  seeded row re-tags it 'edited' so re-seeds can't revert it, and it stays
  shared. (It re-tagged to 'custom' until 20260901010000: that made the row
  private, and private to nobody, since the claim trigger fires on insert and
  the MCP path is the service role with no auth.uid(). The row became readable
  by no one and every prescription naming it left the plan.)
- `delete_exercise(id)`: custom + unreferenced only (FKs enforce it)
- `record_observation(topic, observation, recommendation?, evidence?,
  check_back_on?)`: the coach's own conclusion reached from the numbers,
  with `evidence` frozen at write time for a later then-vs-now comparison,
  never read back as a live metric
- `resolve_observation(id, status, outcome?, superseded_by?)`: closes an
  observation as resolved (with an outcome) or superseded (by a newer
  observation's id)
- `set_exercise_note(exercise_id, note?)`: writes or removes a private
  movement cue
- `set_training_plan(...)`: replaces the unconfirmed long-term plan, or
  requires `confirm_change=true` after approval to replace a confirmed one
- `confirm_training_plan(plan_id)`: confirms the user's reviewed training plan
- `update_planned_workout(...)`: replaces one day's prescriptions in place;
  confirmed changes require approval
- `repeat_planned_workout(...)`: creates the next day from the last performed
  day while preserving ramps, supersets, and sections
- `remember(fact, category?)` / `forget(memory_id)`: adds or removes a
  standing coach memory
- `submit_feedback(category, message)`: records product feedback
- `resolve_feedback(id, resolution)`: closes a feedback record

Claude cannot write `sessions`, `sets`, `set_voids`, or `set_notes`. Only
the PWA logs training.

## PWA scope (5 screens)

1. Today: resolved prescriptions for the planned workout, start button.
2. Set entry: prefilled from prescription, fallback to last actuals.
   Steppers, not keyboards. Logging a set auto-starts the rest timer.
   Mid-session swap and add.
3. History: per exercise set list, e1RM chart with goal line, weekly
   working-set bars. Two charts total.
4. End session: sRPE (0-10), optional bodyweight and note.
5. Plan editor: the user's own edits to a parsed program — the other writer
   of `planned_workouts`/`prescriptions` besides the MCP server. `plan_note`
   is the user's; `notes` stays the coach's words from the parse.

Settings (a sheet, not a screen) is a typed device-local registry: units,
plate and bar inventories, load steps, per-exercise overrides, rest, export.
Nothing there is stored server-side.

Offline is a hard requirement. Writes go to an IndexedDB outbox and flush on
reconnect; client-generated UUIDs + `on conflict do nothing` make replay
idempotent with zero merge logic.

## Error tracking

- PWA: all errors route through `pwa/src/lib/errors.ts`: console in dev,
  optional Sentry when `VITE_SENTRY_DSN` is set, and a global handler for
  unhandled rejections. Queue failures surface in the sync status UI, never
  silently dropped: transient errors retry, permanent ones (FK, RLS,
  constraint) park the item as dead but kept, with a visible count and a
  manual retry. A set whose prescription vanished server-side retries once
  with the link nulled so the training data always lands.
- Edge function: structured JSON logs (request id, tool, duration, outcome)
  readable in the Supabase dashboard; tool errors return proper MCP error
  results, never crash the function.

## Module boundaries (built to be rebuilt)

- Set entry UI is isolated in its own components; the spec expects it to be
  rebuilt after real gym use.
- The outbox (`pwa/src/lib/outbox.ts`) knows nothing about screens; screens
  know nothing about sync.
- Each MCP tool is one file under `tools/`; the transport and auth live in
  `index.ts` and `lib/`.

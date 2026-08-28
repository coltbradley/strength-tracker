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
| PWA             | React + Vite, any static host                                                    | Supabase Auth (email magic link), session persisted |

## Data model in one paragraph

`exercises` is a shared library seeded from free-exercise-db plus a curated
seed (source-tagged so each seed only updates its own rows). Seeded rows are
shared by every user; a `source = 'custom'` row belongs to one person via the
`exercise_owners` side table. PLANNED tables
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
total, with NULL meaning "not asserted" rather than "total". Settings are
device-local and have no table. User-flow detail lives in
[flows.md](flows.md).

## Derived metrics

SQL views only, all `security_invoker`: `v_live_sets` (the one definition
of "sets that count"), `v_current_tm`, `v_resolved_prescriptions`, `v_e1rm`
(Epley, working sets, 1-8 reps), `v_session_best_e1rm`, `v_weekly_volume`,
`v_adherence`, `v_rest`, `v_goal_progress`. Nothing derived is ever stored.

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

## MCP tool surface (12 tools)

Read (`readOnlyHint: true`):

- `search_exercises(query, equipment?, muscle?)`
- `get_lift_history(exercise_id, since?)`: live sets, e1RM series,
  adherence, rest times (capped per section, with truncation flags); loads
  are totals and carry `load_entry` so per-side work is reported the way
  the lifter entered it
- `get_recent_sessions(n?)`: sessions with sRPE, notes, and set counts
- `get_goal_progress(exercise_id?)`

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
- `add_exercise(...)` / `update_exercise(...)`: library management; edits
  re-tag rows 'custom' so re-seeds can't revert them
- `delete_exercise(id)`: custom + unreferenced only (FKs enforce it)

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

# Strength log + Claude programming layer

Original technical direction doc, as provided 2026-08-25. Kept verbatim for
reference; where the build deviates, [decisions.md](decisions.md) wins.

## 1. Goal

A coached lifter logs sets on their phone. Claude reads the log to analyze
progress and writes programming parsed from coach-provided screenshots.
The coach programs. Claude parses, analyzes, and proposes. The app captures.

**Non-goals:** social features, nutrition, running data,
multi-user, RIR or per-set subjective ratings.

## 2. Architecture

```
Coach screenshot ──► Claude (desktop) ──► MCP server ──┐
                                                        ▼
Phone (PWA, offline-first) ────────────────────► Supabase Postgres
                                                   (Auth + RLS)
```

Three deployables:

| Piece      | Stack                                     | Notes                                      |
| ---------- | ----------------------------------------- | ------------------------------------------ |
| Database   | Supabase Postgres                         | RLS on every table, `user_id = auth.uid()` |
| MCP server | Supabase Edge Function, streamable HTTP   | Same project, public HTTPS                 |
| Client     | PWA (React + Vite), IndexedDB write queue | Installed to home screen                   |

The MCP server must be publicly reachable. Claude connects from Anthropic's
cloud, not from the device, so a Tailscale-only endpoint will not work.
_(Build note: superseded — see decisions.md, mcp-remote connects locally.)_

## 3. Data model

Seed `exercises` from `yuhonas/free-exercise-db` (800+ entries, Unlicense,
ships an NDJSON make target for direct Postgres import).

```sql
exercises(id, name, primary_muscles[], equipment, mechanic, source)
training_maxes(id, user_id, exercise_id, value_kg, effective_date)
goals(id, user_id, exercise_id, target_e1rm_kg, target_date, created_at)

-- PLANNED (written by Claude, confirmed by user)
programs(id, user_id, name, source_note, created_at, confirmed_at)
planned_workouts(id, program_id, day_index, label, notes)
prescriptions(id, planned_workout_id, exercise_id, position,
              sets, reps_min, reps_max,
              load_kg, load_pct_tm,        -- one or the other
              rest_seconds, notes)

-- ACTUAL (written by the PWA only)
sessions(id, user_id, planned_workout_id NULL, started_at, ended_at,
         session_rpe SMALLINT, bodyweight_kg, notes)
sets(id, session_id, exercise_id, prescription_id NULL, set_index,
     set_type ENUM('warmup','working','backoff'),
     load_kg, reps, performed_at)
```

`sets` is append-only. That makes offline sync trivial: no merge logic, just
replay the queue. Do not add an edit path in v1.

Note `prescription_id` on `sets`. That join is the whole analytical value of
the system: prescribed vs achieved, measured rather than self-reported.

## 4. Derived metrics (SQL views, never stored)

- `v_e1rm` — Epley, computed **only** from `set_type='working'` where
  `reps BETWEEN 1 AND 8`. Above 8 reps the estimate degrades.
- `v_weekly_volume` — count of working sets per exercise per ISO week.
- `v_adherence` — `sets ⋈ prescriptions`, yielding hit / missed / exceeded
  per prescribed set.
- `v_rest` — `performed_at - lag(performed_at)` partitioned by session and
  exercise. Free proxy for set difficulty.
- `v_goal_progress` — `v_e1rm` trend vs `goals.target_e1rm_kg`.

## 5. MCP tool surface

Six tools. Reads annotated `readOnlyHint: true`.
_(Build note: eight — see decisions.md.)_

**Read**

- `search_exercises(query, equipment?, muscle?)`
- `get_lift_history(exercise_id, since)` — sets, e1RM series, adherence
- `get_recent_sessions(n)` — sessions with sRPE and set counts
- `get_goal_progress(exercise_id?)`

**Write**

- `upsert_program(program_json)` — creates program in `confirmed_at = NULL`
  state
- `confirm_program(program_id)` — separate call, requires explicit user
  approval in chat

Claude cannot write `sessions` or `sets`. Only the PWA logs training. This
keeps the blast radius on the training record at zero.

### Screenshot ingestion flow

1. User pastes coach screenshot into Claude desktop.
2. Claude parses to `program_json`, renders it back as a table in chat.
3. User confirms or corrects in conversation.
4. `upsert_program` → `confirm_program`.

Never write directly from a parse. Percentage-based programming requires a
current row in `training_maxes` or the prescription cannot be resolved.

## 6. Client scope

Four screens. Anything not on this list goes through Claude instead.

1. **Today** — resolved prescriptions for the planned workout, start button.
2. **Set entry** — prefilled from prescription, falling back to last session's
   actual. Steppers, not keyboards. Logging a set auto-starts the rest timer
   at `rest_seconds`. Mid-session exercise swap and add.
3. **History** — per exercise: set list, e1RM chart with goal line, weekly
   working-set bars. Two charts total.
4. **End session** — session RPE (single 0-10), optional bodyweight and note.

**Offline is a hard requirement**, not a nice-to-have. Gyms have no signal.
Writes go to IndexedDB and flush on reconnect. The PWA must be fully usable
with the network off.

## 7. Risks

| Risk                                                                                       | Severity | Mitigation                                                                                         |
| ------------------------------------------------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------- |
| MCP OAuth 2.1 (PKCE, token validation, audience binding) is not a drop-in on Supabase Auth | High     | Spike this **before** anything else. _(Resolved: static bearer via mcp-remote, see decisions.md.)_ |
| Offline sync tail                                                                          | Medium   | Append-only `sets` removes conflict resolution entirely                                            |
| Screenshot parse errors                                                                    | Medium   | Mandatory confirm step, never auto-write                                                           |
| Set entry ergonomics                                                                       | Medium   | Only real gym use will tell you; expect to rebuild once                                            |

## 8. Build order

1. **Auth spike.** Prove Claude can call an authenticated MCP tool against
   Supabase. Stop if this fails; everything else depends on it.
2. Schema + RLS + exercise seed + views.
3. MCP server, read tools only. Hand-insert a fake session and confirm Claude
   can analyze it.
4. Write tools + screenshot flow.
5. PWA: set entry and Today first, offline queue with it. History last.

Steps 1-4 are usable without a UI: log by talking to Claude, confirm the model
is right, then build the client. If you stop wanting to use it during that
phase, you have saved yourself the PWA.

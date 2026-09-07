#!/usr/bin/env node
// Runs the real migrations + seed + fixtures inside PGlite (Postgres-in-WASM)
// and asserts the derived-metric views and RLS invariants. Zero infrastructure.
//
//   npm --prefix scripts install
//   node scripts/build-exercise-seed.mjs   # once, for the seed assertion
//   node scripts/validate-db.mjs
//
// The Supabase platform pieces we can't reproduce (PostgREST, GoTrue) are
// shimmed: auth.users is a plain table, auth.uid() reads the app.user_id GUC,
// and `authenticated` is a plain role we SET ROLE into. Everything in
// supabase/migrations/ runs unmodified.
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const db = new PGlite();

let failures = 0;
const ok = (name) => console.log(`  ok    ${name}`);
const fail = (name, detail) => {
  failures++;
  console.error(`  FAIL  ${name}\n        ${detail}`);
};
async function check(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (e) {
    fail(name, e.message);
  }
}
const assertEq = (actual, expected, what) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};
/** For the checks whose point is "there is at least one", where the exact
 *  count depends on the seed and asserting it would be brittle. */
const assert = (ok, what) => {
  if (!ok) throw new Error(what);
};

// --- auth shim -------------------------------------------------------------
await db.exec(`
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid
    language sql stable
    as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;
  create role authenticated login;
  create role anon login;
  -- Supabase grants EXECUTE on every new public function to anon and
  -- authenticated through default privileges, i.e. at CREATE time. Modelled the
  -- same way, and BEFORE the migrations run, so that a migration which revokes
  -- execute on one function (20260905030000) is not silently re-granted by the
  -- harness afterwards. A blanket grant after the migrations was exactly that.
  alter default privileges in schema public grant execute on functions to anon, authenticated;
`);

// --- migrations (unmodified) ----------------------------------------------
const migDir = join(root, "supabase", "migrations");
const migrations = (await readdir(migDir)).filter((f) => f.endsWith(".sql")).sort();
if (migrations.length === 0) throw new Error("no migrations found");
console.log(`migrations: ${migrations.join(", ")}`);
for (const m of migrations) await db.exec(await readFile(join(migDir, m), "utf8"));

// platform-equivalent grants (Supabase grants these to `authenticated`)
await db.exec(`
  grant usage on schema public, auth to authenticated;
  grant select, insert, update, delete on all tables in schema public to authenticated;
  grant execute on all functions in schema auth to authenticated;
`);

// --- seed ------------------------------------------------------------------
let seeded = false;
let seedSql = null;
try {
  seedSql = await readFile(join(root, "supabase", "seed", "exercises.generated.sql"), "utf8");
} catch (e) {
  // ENOENT only. Catching everything here (including db.exec below) meant any
  // SQL error in the generated seed was reported as "seed file missing", the
  // 800-exercise assertion was skipped, and CI went green on a broken seed.
  if (e.code !== "ENOENT") throw e;
  console.log("  note  seed file missing, run scripts/build-exercise-seed.mjs (seed checks skipped)");
}
if (seedSql !== null) {
  // Deliberately unguarded: a seed that exists but does not load is a failure,
  // not a skip.
  await db.exec(seedSql);
  seeded = true;
}
// curated seed is hand-maintained and always present
await db.exec(await readFile(join(root, "supabase", "seed", "exercises.curated.sql"), "utf8"));

// --- fixtures (as the service role would write them) -----------------------
const OWNER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
await db.exec(`
  insert into auth.users (id, email) values ('${OWNER}', 'owner@example.test'), ('${OTHER}', 'other@example.test');
  ${seeded ? "" : `insert into exercises (id, name, primary_muscles) values
      ('Barbell_Squat', 'Barbell Squat', array['quadriceps']),
      ('Barbell_Deadlift', 'Barbell Deadlift', array['lower back']),
      ('Pullups', 'Pullups', array['lats']);`}
  insert into training_maxes (user_id, exercise_id, value_kg, effective_date) values
    ('${OWNER}', 'Barbell_Squat', 140, current_date - 30),
    ('${OWNER}', 'Barbell_Squat', 150, current_date - 5),           -- current TM
    ('${OWNER}', 'Barbell_Squat', 160, current_date + 10);          -- future, must be ignored
  insert into goals (user_id, exercise_id, target_e1rm_kg, target_date) values
    ('${OWNER}', 'Barbell_Squat', 170, current_date + 90);

  insert into programs (id, user_id, name, confirmed_at) values
    ('11111111-0000-4000-8000-000000000001', '${OWNER}', 'Block 1', now());
  insert into planned_workouts (id, user_id, program_id, day_index, label) values
    ('22222222-0000-4000-8000-000000000001', '${OWNER}', '11111111-0000-4000-8000-000000000001', 0, 'Day A');
  insert into prescriptions (id, user_id, planned_workout_id, exercise_id, position, sets, reps_min, reps_max, load_pct_tm, rest_seconds) values
    ('33333333-0000-4000-8000-000000000001', '${OWNER}', '22222222-0000-4000-8000-000000000001', 'Barbell_Squat', 0, 3, 5, 5, 80, 180);
  insert into prescriptions (id, user_id, planned_workout_id, exercise_id, position, sets, reps_min, reps_max, load_kg) values
    ('33333333-0000-4000-8000-000000000002', '${OWNER}', '22222222-0000-4000-8000-000000000001', 'Barbell_Deadlift', 1, 2, 3, 5, 180);
  insert into prescriptions (id, user_id, planned_workout_id, exercise_id, position, sets, reps_min, reps_max, load_pct_tm) values
    ('33333333-0000-4000-8000-000000000003', '${OWNER}', '22222222-0000-4000-8000-000000000001', 'Pullups', 2, 3, 8, 12, 90); -- no TM on purpose

  insert into sessions (id, user_id, planned_workout_id, started_at) values
    ('44444444-0000-4000-8000-000000000001', '${OWNER}', '22222222-0000-4000-8000-000000000001', now() - interval '1 hour');
  insert into sets (id, user_id, session_id, exercise_id, prescription_id, set_index, set_type, load_kg, reps, performed_at) values
    ('55555555-0000-4000-8000-000000000001', '${OWNER}', '44444444-0000-4000-8000-000000000001', 'Barbell_Squat', null, 0, 'warmup', 60, 10, now() - interval '55 minutes'),
    ('55555555-0000-4000-8000-000000000002', '${OWNER}', '44444444-0000-4000-8000-000000000001', 'Barbell_Squat', '33333333-0000-4000-8000-000000000001', 1, 'working', 120, 5, now() - interval '50 minutes'),
    ('55555555-0000-4000-8000-000000000003', '${OWNER}', '44444444-0000-4000-8000-000000000001', 'Barbell_Squat', '33333333-0000-4000-8000-000000000001', 2, 'working', 120, 4, now() - interval '47 minutes'),
    ('55555555-0000-4000-8000-000000000004', '${OWNER}', '44444444-0000-4000-8000-000000000001', 'Barbell_Squat', '33333333-0000-4000-8000-000000000001', 3, 'working', 120, 6, now() - interval '44 minutes'),
    ('55555555-0000-4000-8000-000000000005', '${OWNER}', '44444444-0000-4000-8000-000000000001', 'Barbell_Squat', null, 4, 'backoff', 100, 12, now() - interval '41 minutes');
`);

console.log("\nview + invariant checks:");

if (seeded)
  await check("seed: 800+ exercises from free-exercise-db", async () => {
    // range, not exact: CI regenerates from live upstream, which grows over time
    const r = await db.query(`select count(*)::int as n from exercises where source = 'free-exercise-db'`);
    if (r.rows[0].n < 800) throw new Error(`only ${r.rows[0].n} exercises seeded`);
  });

await check("seed: curated exercises present with source='curated'", async () => {
  const r = await db.query(`select count(*)::int as n from exercises where source = 'curated'`);
  if (r.rows[0].n < 100) throw new Error(`only ${r.rows[0].n} curated exercises`);
});

await check("curated seed re-run is idempotent and respects source guard", async () => {
  const seed = await readFile(join(root, "supabase", "seed", "exercises.curated.sql"), "utf8");
  await db.exec(seed); // second run: upsert, no dupes, no error
  const r = await db.query(`select count(*)::int as n from exercises where id = 'Nordic_Hamstring_Curl'`);
  assertEq(r.rows[0].n, 1, "single row after re-seed");
});

await check("v_current_tm picks latest effective TM, ignores future rows", async () => {
  const r = await db.query(
    `select value_kg::float as v from v_current_tm where user_id = $1 and exercise_id = 'Barbell_Squat'`,
    [OWNER],
  );
  assertEq(r.rows[0].v, 150, "current TM");
});

await check("v_resolved_prescriptions resolves %TM and plate-rounds", async () => {
  const r = await db.query(
    `select resolved_load_kg::float as r, plate_load_kg::float as p
       from v_resolved_prescriptions where id = '33333333-0000-4000-8000-000000000001'`,
  );
  assertEq(r.rows[0].r, 120, "80% of 150"); // 0.8 * 150 = 120
  assertEq(r.rows[0].p, 120, "plate round");
});

await check("v_resolved_prescriptions yields null load when TM missing", async () => {
  const r = await db.query(
    `select resolved_load_kg from v_resolved_prescriptions where id = '33333333-0000-4000-8000-000000000003'`,
  );
  assertEq(r.rows[0].resolved_load_kg, null, "no TM -> null, never guessed");
});

await check("v_e1rm: Epley on working sets 1-8 reps only", async () => {
  const r = await db.query(
    `select count(*)::int as n, max(e1rm_kg)::float as best
       from v_e1rm where user_id = $1 and exercise_id = 'Barbell_Squat'`,
    [OWNER],
  );
  assertEq(r.rows[0].n, 3, "warmup + 12-rep backoff excluded");
  assertEq(r.rows[0].best, 144, "120*(1+6/30)");
});

await check("v_weekly_volume counts working sets", async () => {
  // Summed across weeks rather than read off rows[0]. The fixture seeds these
  // sets at `now() - 41..55 minutes`, so for about an hour after every ISO
  // Monday boundary they straddle two buckets and rows[0] is a partial count.
  // Caught at 00:47 UTC on a Monday. What this check is about is that three
  // working sets are counted and the warmup and backoff are not; which bucket
  // they land in is v_weekly_volume's own business and is asserted by the
  // timezone checks instead.
  const r = await db.query(
    `select coalesce(sum(working_sets), 0)::int as n
       from v_weekly_volume where user_id = $1 and exercise_id = 'Barbell_Squat'`,
    [OWNER],
  );
  assertEq(r.rows[0].n, 3, "working sets, warmup and backoff excluded");
});

await check("v_adherence: hit / missed / exceeded vs prescription", async () => {
  const r = await db.query(
    `select set_index, rep_outcome, prescribed_load_kg::float as rx
       from v_adherence where user_id = $1 order by set_index`,
    [OWNER],
  );
  assertEq(
    r.rows.map((x) => x.rep_outcome),
    ["hit", "missed", "exceeded"],
    "outcomes",
  );
  assertEq(r.rows[0].rx, 120, "prescribed load from TM at performance date");
});

await check("v_rest computes lag within session+exercise", async () => {
  const r = await db.query(
    `select rest_seconds_before from v_rest
      where user_id = $1 and set_index = 2`,
    [OWNER],
  );
  assertEq(r.rows[0].rest_seconds_before, 180, "3 min between working sets");
});

await check("v_goal_progress computes pct of target", async () => {
  const r = await db.query(
    `select recent_best_e1rm_kg::float as best, pct_of_target::float as pct
       from v_goal_progress where user_id = $1`,
    [OWNER],
  );
  assertEq(r.rows[0].best, 144, "recent best");
  assertEq(r.rows[0].pct, 84.7, "144/170");
});

await check("v_session_set_counts aggregates per session", async () => {
  const r = await db.query(
    `select total_sets::int as t, working_sets::int as w
       from v_session_set_counts where session_id = '44444444-0000-4000-8000-000000000001'`,
  );
  assertEq(r.rows[0].t, 5, "total");
  assertEq(r.rows[0].w, 3, "working");
});

await check("timezone: evening local set buckets into the local ISO week", async () => {
  // Sunday 2026-08-16 18:00 America/Los_Angeles = Monday 2026-08-17 01:00 UTC.
  // With the tz config set, the set must land in the week starting Mon 2026-08-10.
  await db.exec(`update app_config set value = 'America/Los_Angeles' where key = 'tz'`);
  await db.exec(`
    insert into sessions (id, user_id, started_at) values
      ('44444444-0000-4000-8000-000000000002', '${OWNER}', '2026-08-17T00:30:00Z');
    insert into sets (id, user_id, session_id, exercise_id, set_index, set_type, load_kg, reps, performed_at) values
      ('55555555-0000-4000-8000-000000000010', '${OWNER}', '44444444-0000-4000-8000-000000000002',
       'Barbell_Deadlift', 0, 'working', 180, 3, '2026-08-17T01:00:00Z');
  `);
  const r = await db.query(
    `select week_start::text as w from v_weekly_volume
      where user_id = $1 and exercise_id = 'Barbell_Deadlift'`,
    [OWNER],
  );
  assertEq(r.rows[0].w, "2026-08-10", "local Sunday stays in the prior ISO week");
  await db.exec(`update app_config set value = 'UTC' where key = 'tz'`);
});

await check("timezone: 'today' is app_tz()'s date, and a UTC stamp is not it", async () => {
  // The SQL half of the MCP server's date rule (see
  // supabase/functions/mcp-server/lib/dates.test.ts, which pins the same
  // instant on the TypeScript side -- change one, change the other).
  //
  // The defect this guards against: the MCP server stamped
  // training_maxes.effective_date from a UTC "today". At 2026-08-27T02:30Z the
  // lifter in America/Los_Angeles is in the evening of 2026-08-26, so the row
  // landed on tomorrow, v_current_tm could not see it, and %TM programs were
  // rejected as having no current training max.
  const NOW = "2026-08-27T02:30:00Z";
  const utcToday = NOW.slice(0, 10); // what the old todayIso() produced
  await db.exec(`update app_config set value = 'America/Los_Angeles' where key = 'tz'`);
  try {
    // 1. the two dates genuinely differ at this instant
    const tzToday = (
      await db.query(`select ($1::timestamptz at time zone app_tz())::date::text as d`, [NOW])
    ).rows[0].d;
    assertEq(tzToday, "2026-08-26", "app_tz() date for an evening-PT instant");
    if (tzToday === utcToday) throw new Error("premise broken: UTC and app_tz agree here");

    // 2. a TM stamped with the UTC date is invisible to v_current_tm's rule
    await db.exec(`insert into training_maxes (user_id, exercise_id, value_kg, effective_date)
                   values ('${OWNER}', 'Pullups', 90, '${utcToday}')`);
    const visible = await db.query(
      `select count(*)::int as n from training_maxes
        where user_id = $1 and exercise_id = 'Pullups'
          and effective_date <= ($2::timestamptz at time zone app_tz())::date`,
      [OWNER, NOW],
    );
    assertEq(visible.rows[0].n, 0, "UTC-stamped TM is not yet current for the lifter");

    // 3. the tz-aware stamp is current immediately, which is the fix
    await db.exec(`insert into training_maxes (user_id, exercise_id, value_kg, effective_date)
                   values ('${OWNER}', 'Pullups', 95, '${tzToday}')`);
    const nowVisible = await db.query(
      `select count(*)::int as n from training_maxes
        where user_id = $1 and exercise_id = 'Pullups'
          and effective_date <= ($2::timestamptz at time zone app_tz())::date`,
      [OWNER, NOW],
    );
    assertEq(nowVisible.rows[0].n, 1, "tz-stamped TM is current on the day it is set");

    // 4. upsert_program's future-TM explanation: gt() drops the boundary row,
    //    gte() keeps it, which is the difference between "no current training
    //    max" with an explanation and without one.
    const gt = await db.query(
      `select count(*)::int as n from training_maxes
        where user_id = $1 and exercise_id = 'Pullups' and effective_date > $2`,
      [OWNER, utcToday],
    );
    const gte = await db.query(
      `select count(*)::int as n from training_maxes
        where user_id = $1 and exercise_id = 'Pullups' and effective_date >= $2`,
      [OWNER, utcToday],
    );
    assertEq(gt.rows[0].n, 0, "gt() cannot see a TM dated exactly the boundary day");
    assertEq(gte.rows[0].n, 1, "gte() explains it");
  } finally {
    await db.exec(`delete from training_maxes where user_id = '${OWNER}' and exercise_id = 'Pullups'`);
    await db.exec(`update app_config set value = 'UTC' where key = 'tz'`);
  }
});

await check("goals: unique (user_id, exercise_id) rejects duplicates", async () => {
  let rejected = false;
  try {
    await db.exec(
      `insert into goals (user_id, exercise_id, target_e1rm_kg) values ('${OWNER}', 'Barbell_Squat', 999)`,
    );
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("duplicate goal insert succeeded");
});

// --- RLS: run as `authenticated` ------------------------------------------
console.log("\nRLS checks (as role authenticated):");
const asUser = async (uid, sql, params) => {
  await db.exec(`set role authenticated; select set_config('app.user_id', '${uid}', false);`);
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec(`reset role; select set_config('app.user_id', '', false);`);
  }
};

await check("owner sees own sets through RLS", async () => {
  const r = await asUser(OWNER, `select count(*)::int as n from sets`);
  assertEq(r.rows[0].n, 6, "own sets");
});

await check("other user sees nothing", async () => {
  const r = await asUser(OTHER, `select count(*)::int as n from sets`);
  assertEq(r.rows[0].n, 0, "cross-user isolation");
});

await check("views enforce RLS (security_invoker)", async () => {
  const r = await asUser(OTHER, `select count(*)::int as n from v_e1rm`);
  assertEq(r.rows[0].n, 0, "view leaks nothing cross-user");
});

await check("sets are append-only: update affects 0 rows", async () => {
  const r = await asUser(OWNER, `update sets set reps = 99 where user_id = '${OWNER}'`);
  assertEq(r.affectedRows ?? 0, 0, "no update policy");
  const still = await db.query(`select count(*)::int as n from sets where reps = 99`);
  assertEq(still.rows[0].n, 0, "data unchanged");
});

await check("sets are append-only: delete affects 0 rows", async () => {
  const r = await asUser(OWNER, `delete from sets where user_id = '${OWNER}'`);
  assertEq(r.affectedRows ?? 0, 0, "no delete policy");
  const still = await db.query(`select count(*)::int as n from sets`);
  assertEq(still.rows[0].n, 6, "data unchanged");
});

await check("sessions cannot be deleted, can be updated (end-of-session)", async () => {
  const del = await asUser(OWNER, `delete from sessions where user_id = '${OWNER}'`);
  assertEq(del.affectedRows ?? 0, 0, "no delete policy");
  const upd = await asUser(
    OWNER,
    `update sessions set ended_at = now(), session_rpe = 7 where id = '44444444-0000-4000-8000-000000000001'`,
  );
  assertEq(upd.affectedRows ?? 0, 1, "update allowed");
});

await check("insert with someone else's user_id is rejected", async () => {
  let rejected = false;
  try {
    await asUser(
      OWNER,
      `insert into sessions (id, user_id, started_at) values ('44444444-0000-4000-8000-000000000099', '${OTHER}', now())`,
    );
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("insert impersonating another user succeeded");
});

await check("client uuid replay is idempotent (on conflict do nothing)", async () => {
  const r = await asUser(
    OWNER,
    `insert into sets (id, user_id, session_id, exercise_id, set_index, set_type, load_kg, reps)
     values ('55555555-0000-4000-8000-000000000001', '${OWNER}', '44444444-0000-4000-8000-000000000001', 'Barbell_Squat', 0, 'warmup', 60, 10)
     on conflict (id) do nothing`,
  );
  assertEq(r.affectedRows ?? 0, 0, "replay is a no-op");
});

await check("set void hides the set from every derived view", async () => {
  // void the 6-rep working set (the session's best e1RM)
  await asUser(
    OWNER,
    `insert into set_voids (set_id, user_id) values ('55555555-0000-4000-8000-000000000004', '${OWNER}')`,
  );
  const live = await db.query(
    `select count(*)::int as n from v_live_sets where session_id = '44444444-0000-4000-8000-000000000001'`,
  );
  assertEq(live.rows[0].n, 4, "one of five sets voided");
  const e1 = await db.query(
    `select max(e1rm_kg)::float as best from v_e1rm where user_id = $1 and exercise_id = 'Barbell_Squat'`,
    [OWNER],
  );
  assertEq(e1.rows[0].best, 140, "e1RM best recomputed without the voided set");
});

await check("cannot void another user's set", async () => {
  let rejected = false;
  try {
    await asUser(
      OTHER,
      `insert into set_voids (set_id, user_id) values ('55555555-0000-4000-8000-000000000001', '${OTHER}')`,
    );
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("cross-user void insert succeeded");
});

await check("set_voids is append-only: update/delete affect 0 rows", async () => {
  const upd = await asUser(OWNER, `update set_voids set created_at = now() where user_id = '${OWNER}'`);
  assertEq(upd.affectedRows ?? 0, 0, "no update policy");
  const del = await asUser(OWNER, `delete from set_voids where user_id = '${OWNER}'`);
  assertEq(del.affectedRows ?? 0, 0, "no delete policy");
});

await check("discarded session leaves every view, rows survive", async () => {
  await asUser(
    OWNER,
    `update sessions set discarded_at = now() where id = '44444444-0000-4000-8000-000000000002'`,
  );
  const vol = await db.query(
    `select count(*)::int as n from v_weekly_volume where user_id = $1 and exercise_id = 'Barbell_Deadlift'`,
    [OWNER],
  );
  assertEq(vol.rows[0].n, 0, "volume gone from views");
  const raw = await db.query(
    `select count(*)::int as n from sets where session_id = '44444444-0000-4000-8000-000000000002'`,
  );
  assertEq(raw.rows[0].n, 1, "raw set row still present");
  await db.exec(`update sessions set discarded_at = null where id = '44444444-0000-4000-8000-000000000002'`);
});

await check("owner can edit planning fields on planned_workouts", async () => {
  const upd = await asUser(
    OWNER,
    `update planned_workouts
        set scheduled_date = current_date, plan_note = 'focus on bracing', skipped_at = null
      where id = '22222222-0000-4000-8000-000000000001'`,
  );
  assertEq(upd.affectedRows ?? 0, 1, "planning update allowed");
});

await check("set_notes: upsert own, reject cross-user, view exposes superset", async () => {
  await asUser(
    OWNER,
    `insert into set_notes (set_id, user_id, note) values ('55555555-0000-4000-8000-000000000002', '${OWNER}', 'felt heavy')
     on conflict (set_id) do update set note = excluded.note, updated_at = now()`,
  );
  const upd = await asUser(
    OWNER,
    `update set_notes set note = 'bar speed fine actually' where set_id = '55555555-0000-4000-8000-000000000002'`,
  );
  assertEq(upd.affectedRows ?? 0, 1, "note editable");
  let rejected = false;
  try {
    await asUser(
      OTHER,
      `insert into set_notes (set_id, user_id, note) values ('55555555-0000-4000-8000-000000000003', '${OTHER}', 'x')`,
    );
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("cross-user set note insert succeeded");
  const col = await db.query(
    `select superset_group from v_resolved_prescriptions limit 1`,
  );
  if (!("superset_group" in col.rows[0]))
    throw new Error("superset_group missing from v_resolved_prescriptions");
});

await check("auth.uid() default stamps user_id on insert", async () => {
  await asUser(
    OWNER,
    `insert into goals (exercise_id, target_e1rm_kg) values ('Barbell_Deadlift', 220)`,
  );
  const r = await db.query(
    `select user_id from goals where exercise_id = 'Barbell_Deadlift'`,
  );
  assertEq(r.rows[0].user_id, OWNER, "default auth.uid()");
});

// --- per-side load convention ----------------------------------------------
// Runs last, and brings its own fixtures: the checks above assert exact set
// counts, and adding these rows to the shared fixture block would move those
// numbers for reasons unrelated to what they test.
console.log("\nper-side load convention (load_entry):");

await db.exec(`
  -- Dumbbell_Bench_Press is in the generated seed; the row is inserted anyway
  -- so this section also runs when the seed is missing.
  insert into exercises (id, name, equipment, primary_muscles, source) values
    ('Dumbbell_Bench_Press', 'Dumbbell Bench Press', 'dumbbell', array['chest'], 'custom'),
    ('One_Arm_Dumbbell_Row', 'One-Arm Dumbbell Row', 'dumbbell', array['lats'], 'custom')
    on conflict (id) do nothing;

  insert into planned_workouts (id, user_id, program_id, day_index, label) values
    ('22222222-0000-4000-8000-000000000002', '${OWNER}', '11111111-0000-4000-8000-000000000001', 1, 'Day B');

  -- the coach wrote "DB bench 3x6-10 @ 30 per hand": stored as the 60 kg TOTAL
  insert into prescriptions (id, user_id, planned_workout_id, exercise_id, position, sets, reps_min, reps_max, load_kg, load_entry) values
    ('33333333-0000-4000-8000-000000000011', '${OWNER}', '22222222-0000-4000-8000-000000000002', 'Dumbbell_Bench_Press', 0, 3, 6, 10, 60, 'per_side');
  -- pre-convention shape: a load, with no assertion about how it was expressed
  insert into prescriptions (id, user_id, planned_workout_id, exercise_id, position, sets, reps_min, reps_max, load_kg) values
    ('33333333-0000-4000-8000-000000000012', '${OWNER}', '22222222-0000-4000-8000-000000000002', 'One_Arm_Dumbbell_Row', 1, 3, 8, 12, 30);

  insert into sessions (id, user_id, planned_workout_id, started_at) values
    ('44444444-0000-4000-8000-000000000003', '${OWNER}', '22222222-0000-4000-8000-000000000002', now() - interval '2 hours');
  insert into sets (id, user_id, session_id, exercise_id, prescription_id, set_index, set_type, load_kg, reps, load_entry, performed_at) values
    -- 30 per hand -> 60 total, exactly what the prescription asks for
    ('55555555-0000-4000-8000-000000000020', '${OWNER}', '44444444-0000-4000-8000-000000000003', 'Dumbbell_Bench_Press', '33333333-0000-4000-8000-000000000011', 0, 'working', 60, 10, 'per_side', now() - interval '110 minutes'),
    ('55555555-0000-4000-8000-000000000021', '${OWNER}', '44444444-0000-4000-8000-000000000003', 'Dumbbell_Bench_Press', '33333333-0000-4000-8000-000000000011', 1, 'working', 60, 6, 'per_side', now() - interval '105 minutes'),
    -- a bar on the same day, explicitly whole-system
    ('55555555-0000-4000-8000-000000000022', '${OWNER}', '44444444-0000-4000-8000-000000000003', 'Barbell_Squat', null, 2, 'working', 100, 5, 'total', now() - interval '100 minutes'),
    -- logged before the convention existed: permanently ambiguous
    ('55555555-0000-4000-8000-000000000023', '${OWNER}', '44444444-0000-4000-8000-000000000003', 'One_Arm_Dumbbell_Row', '33333333-0000-4000-8000-000000000012', 3, 'working', 30, 10, null, now() - interval '95 minutes');
`);

await check("load_entry: total, per_side and unknown are three distinct states", async () => {
  // NULL must never collapse into "confirmed total": sets is append-only, so
  // rows logged before the convention can never be corrected, and analysis
  // has to be able to tell "not asserted" from "asserted whole-system".
  const r = await db.query(
    `select count(*) filter (where load_entry is null)::int as unknown,
            count(*) filter (where load_entry = 'total')::int as total,
            count(*) filter (where load_entry = 'per_side')::int as per_side
       from sets where session_id = '44444444-0000-4000-8000-000000000003'`,
  );
  assertEq([r.rows[0].unknown, r.rows[0].total, r.rows[0].per_side], [1, 1, 2], "three states");
});

await check("v_live_sets exposes load_entry (select s.* re-expanded)", async () => {
  // `select s.*` is expanded when the view is created, so adding a column to
  // `sets` does NOT reach the view — the migration has to replace it. Without
  // this, load_entry is invisible to every reader that goes through v_live_sets.
  const r = await db.query(
    `select load_entry from v_live_sets
      where session_id = '44444444-0000-4000-8000-000000000003' order by set_index`,
  );
  assertEq(
    r.rows.map((x) => x.load_entry),
    ["per_side", "per_side", "total", null],
    "passthrough",
  );
});

await check("per-side sets count their TOTAL load toward volume", async () => {
  // Summed across weeks: the fixtures are relative to now(), which can straddle
  // an ISO week boundary depending on when this runs.
  const r = await db.query(
    `select sum(tonnage_kg)::float as t from v_weekly_volume
      where user_id = $1 and exercise_id = 'Dumbbell_Bench_Press'`,
    [OWNER],
  );
  assertEq(r.rows[0].t, 960, "60x10 + 60x6; the per-hand reading would be 480");
});

await check("v_e1rm estimates from the total, not the per-hand number", async () => {
  const r = await db.query(
    `select max(e1rm_kg)::float as best from v_e1rm
      where user_id = $1 and exercise_id = 'Dumbbell_Bench_Press'`,
    [OWNER],
  );
  assertEq(r.rows[0].best, 72, "60*(1+6/30); per-hand would read 36");
});

await check("v_adherence: per-side prescription and per-side set agree exactly", async () => {
  // Both sides of the join are totals, so the delta is zero. Storing the typed
  // per-hand number on either side alone would show a phantom +30 kg overshoot.
  const r = await db.query(
    `select actual_load_kg::float as a, prescribed_load_kg::float as p,
            load_delta_kg::float as d, rep_outcome,
            actual_load_entry, prescribed_load_entry
       from v_adherence where set_id = '55555555-0000-4000-8000-000000000020'`,
  );
  assertEq([r.rows[0].a, r.rows[0].p, r.rows[0].d], [60, 60, 0], "totals vs totals");
  assertEq(r.rows[0].rep_outcome, "hit", "10 reps in 6-10");
  assertEq(
    [r.rows[0].actual_load_entry, r.rows[0].prescribed_load_entry],
    ["per_side", "per_side"], "both modes surfaced",
  );
  // and an unasserted row stays unasserted rather than being coalesced
  const legacy = await db.query(
    `select actual_load_entry, prescribed_load_entry from v_adherence
      where set_id = '55555555-0000-4000-8000-000000000023'`,
  );
  assertEq(
    [legacy.rows[0].actual_load_entry, legacy.rows[0].prescribed_load_entry],
    [null, null], "unknown stays unknown",
  );
});

await check("v_resolved_prescriptions exposes load_entry; %TM resolves to a total", async () => {
  // Training maxes are whole-system values, so a %TM prescription resolves to a
  // total; load_entry then says only how to express that total to the lifter.
  await db.exec(`
    insert into training_maxes (user_id, exercise_id, value_kg, effective_date)
      values ('${OWNER}', 'Dumbbell_Bench_Press', 70, current_date - 1);
    insert into prescriptions (id, user_id, planned_workout_id, exercise_id, position, sets, reps_min, reps_max, load_pct_tm, load_entry)
      values ('33333333-0000-4000-8000-000000000013', '${OWNER}', '22222222-0000-4000-8000-000000000002', 'Dumbbell_Bench_Press', 2, 3, 8, 8, 80, 'per_side');
  `);
  const r = await db.query(
    `select resolved_load_kg::float as r, load_entry from v_resolved_prescriptions
      where id = '33333333-0000-4000-8000-000000000013'`,
  );
  assertEq([r.rows[0].r, r.rows[0].load_entry], [56, "per_side"], "80% of a 70 kg total");
});

await check("per_side is rejected on a bodyweight set, allowed with a load", async () => {
  // load_kg = 0 means bodyweight; half of nothing is still nothing.
  let rejected = false;
  try {
    await db.exec(
      `insert into sets (id, user_id, session_id, exercise_id, set_index, set_type, load_kg, reps, load_entry)
       values ('55555555-0000-4000-8000-000000000024', '${OWNER}', '44444444-0000-4000-8000-000000000003', 'Pullups', 4, 'working', 0, 5, 'per_side')`,
    );
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("per_side bodyweight set accepted");
  // the constraint must not be over-broad: bodyweight itself is still legal
  await db.exec(
    `insert into sets (id, user_id, session_id, exercise_id, set_index, set_type, load_kg, reps, load_entry) values
      ('55555555-0000-4000-8000-000000000025', '${OWNER}', '44444444-0000-4000-8000-000000000003', 'Pullups', 4, 'working', 0, 5, 'total'),
      ('55555555-0000-4000-8000-000000000026', '${OWNER}', '44444444-0000-4000-8000-000000000003', 'Pullups', 5, 'working', 0, 5, null)`,
  );
});

await check("per_side prescriptions need a load ('by feel' has no side to halve)", async () => {
  let rejected = false;
  try {
    await db.exec(
      `insert into prescriptions (id, user_id, planned_workout_id, exercise_id, position, sets, reps_min, reps_max, load_entry)
       values ('33333333-0000-4000-8000-000000000014', '${OWNER}', '22222222-0000-4000-8000-000000000002', 'Pullups', 3, 3, 8, 12, 'per_side')`,
    );
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("by-feel per_side prescription accepted");
});

await check("load_entry has no default: writing nothing asserts nothing", async () => {
  // The mistake this guards against is `add column load_entry ... default 'total'`,
  // which would silently backdate a claim onto every row already logged and
  // onto every client that has not been taught the convention yet. Inserting
  // without naming the column is exactly what a legacy writer does.
  await db.exec(
    `insert into sets (id, user_id, session_id, exercise_id, set_index, set_type, load_kg, reps)
     values ('55555555-0000-4000-8000-000000000027', '${OWNER}', '44444444-0000-4000-8000-000000000003', 'Barbell_Squat', 6, 'working', 100, 5)`,
  );
  const r = await db.query(
    `select load_entry from sets where id = '55555555-0000-4000-8000-000000000027'`,
  );
  assertEq(r.rows[0].load_entry, null, "unmentioned load_entry stays null");
});

await check("load_entry can never be backfilled on an existing set", async () => {
  // The reason NULL is permanent, and therefore the reason it must not be read
  // as "total": there is no update policy on sets, so nothing can revise it.
  const r = await asUser(OWNER, `update sets set load_entry = 'total' where load_entry is null`);
  assertEq(r.affectedRows ?? 0, 0, "no update policy");
  const still = await db.query(`select count(*)::int as n from sets where load_entry is null`);
  if (still.rows[0].n === 0) throw new Error("unasserted rows disappeared");
});

// --- multi-user -------------------------------------------------------------
// The schema was always per-user. These pin the three things that were not:
// one global timezone, an unowned exercise library, and one MCP credential.
console.log("\nmulti-user (per-user tz, exercise ownership, MCP tokens):");

await check("app_tz falls back deployment-wide when a user has no row", async () => {
  await db.exec(`update app_config set value = 'America/Los_Angeles' where key = 'tz'`);
  const r = await db.query(`select app_tz('${OWNER}'::uuid) as tz, app_tz('${OTHER}'::uuid) as other`);
  assertEq(r.rows[0].tz, "America/Los_Angeles", "owner falls back to app_config");
  assertEq(r.rows[0].other, "America/Los_Angeles", "other falls back to app_config");
});

await check("app_tz's parameter is named p_user_id (PostgREST resolves the overload by name)", async () => {
  // The edge function calls this over PostgREST RPC as {"p_user_id": "..."},
  // and PostgREST picks between app_tz() and app_tz(uuid) by matching argument
  // NAMES. Renaming the parameter would keep every SQL caller working and break
  // the MCP server silently, so pin the name here.
  const r = await db.query(`select app_tz(p_user_id => '${OWNER}'::uuid) as tz`);
  if (typeof r.rows[0].tz !== "string") throw new Error("named-arg call failed");
});

await check("a user_config row overrides the default for THAT user only", async () => {
  await asUser(OTHER, `insert into user_config (user_id, tz) values ('${OTHER}', 'Europe/Berlin')`);
  const r = await db.query(`select app_tz('${OWNER}'::uuid) as owner, app_tz('${OTHER}'::uuid) as other`);
  assertEq(r.rows[0].owner, "America/Los_Angeles", "owner keeps the default");
  assertEq(r.rows[0].other, "Europe/Berlin", "other gets their own zone");
});

await check("user_config is private: no reading or writing another user's zone", async () => {
  const read = await asUser(OWNER, `select count(*)::int as n from user_config`);
  assertEq(read.rows[0].n, 0, "owner cannot see other's row");
  let rejected = false;
  try {
    await asUser(OWNER, `insert into user_config (user_id, tz) values ('${OTHER}', 'UTC')`);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("wrote a zone onto another user");
});

await check("views bucket by the ROW OWNER's zone, not the caller's", async () => {
  // The whole point of app_tz(user_id): a training max becomes effective in its
  // OWNER's calendar. Reading it as the service role (no auth.uid()) must give
  // the same answer as reading it as the owner.
  await db.exec(`insert into user_config (user_id, tz) values ('${OWNER}', 'Pacific/Kiritimati')
                 on conflict (user_id) do update set tz = excluded.tz`);
  const asService = await db.query(
    `select count(*)::int as n from v_current_tm where user_id = '${OWNER}'`,
  );
  const asOwner = await asUser(OWNER, `select count(*)::int as n from v_current_tm`);
  assertEq(asOwner.rows[0].n, asService.rows[0].n, "same answer on both paths");
  await db.exec(`delete from user_config where user_id = '${OWNER}'`);
});

await check("seeded exercises stay shared; custom ones do not", async () => {
  await db.exec(
    `insert into exercises (id, name, primary_muscles, source)
     values ('Owner_Only_Lift', 'Owner Only Lift', array['quadriceps'], 'custom');
     insert into exercise_owners (exercise_id, user_id) values ('Owner_Only_Lift', '${OWNER}');`,
  );
  const mine = await asUser(OWNER, `select count(*)::int as n from exercises where id = 'Owner_Only_Lift'`);
  assertEq(mine.rows[0].n, 1, "owner sees their custom exercise");
  const theirs = await asUser(OTHER, `select count(*)::int as n from exercises where id = 'Owner_Only_Lift'`);
  assertEq(theirs.rows[0].n, 0, "the other user does not");
  const shared = await asUser(OTHER, `select count(*)::int as n from exercises where id = 'Barbell_Squat'`);
  assertEq(shared.rows[0].n, 1, "the seeded library is still shared");
});

await check("inserting a custom exercise claims it automatically", async () => {
  await asUser(
    OTHER,
    `insert into exercises (id, name, primary_muscles, source)
     values ('Other_Only_Lift', 'Other Only Lift', array['chest'], 'custom')`,
  );
  const owner = await db.query(
    `select user_id from exercise_owners where exercise_id = 'Other_Only_Lift'`,
  );
  assertEq(owner.rows[0].user_id, OTHER, "trigger stamped the inserting user");
  const seen = await asUser(OWNER, `select count(*)::int as n from exercises where id = 'Other_Only_Lift'`);
  assertEq(seen.rows[0].n, 0, "not visible to anyone else");
});

await check("a planned day is soft-deleted, and logged sets keep their plan", async () => {
  // The bug: prescriptions cascade from planned_workouts and
  // sets.prescription_id is ON DELETE SET NULL, so hard-deleting one planned
  // day silently severed every set ever logged against it from the plan it
  // fulfilled. `sets` is append-only, so v_adherence lost that history for good.
  const pw = (await db.query(
    `select id from planned_workouts where not is_template limit 1`,
  )).rows[0].id;
  const before = await db.query(
    `select count(*)::int as n from v_resolved_prescriptions where planned_workout_id = $1`,
    [pw],
  );
  assert(before.rows[0].n > 0, "the day has prescriptions to begin with");

  await db.exec(`update planned_workouts set discarded_at = now() where id = '${pw}'`);
  const after = await db.query(
    `select count(*)::int as n from v_resolved_prescriptions where planned_workout_id = $1`,
    [pw],
  );
  assertEq(after.rows[0].n, 0, "a discarded day leaves every plan read");
  const gone = await db.query(
    `select count(*)::int as n from v_plan_workouts where id = $1`,
    [pw],
  );
  assertEq(gone.rows[0].n, 0, "and leaves the calendar");
  const rows = await db.query(
    `select count(*)::int as n from prescriptions where planned_workout_id = $1`,
    [pw],
  );
  assert(rows.rows[0].n > 0, "but the rows themselves survive in Postgres");
  await db.exec(`update planned_workouts set discarded_at = null where id = '${pw}'`);
});

await check("a prescription with logged sets against it refuses to be deleted", async () => {
  const row = (await db.query(
    `select p.id from prescriptions p
      join sets s on s.prescription_id = p.id limit 1`,
  )).rows[0];
  assert(row !== undefined, "there is a prescription with a set logged against it");
  let refused = false;
  try {
    await db.exec(`delete from prescriptions where id = '${row.id}'`);
  } catch {
    refused = true;
  }
  assertEq(refused, true, "the trigger refuses rather than orphaning history");
  const still = await db.query(
    `select count(*)::int as n from sets where prescription_id = $1`,
    [row.id],
  );
  assert(still.rows[0].n > 0, "and the sets still point at it");
});

await check("a prescription nothing was logged against still deletes freely", async () => {
  // the ordinary case: editing a plan before you train it
  const pw = (await db.query(
    `select id from planned_workouts where not is_template limit 1`,
  )).rows[0].id;
  await db.exec(
    `insert into prescriptions (id, user_id, planned_workout_id, exercise_id,
                                position, sets, reps_min, reps_max)
     values ('11111111-2222-4333-8444-555555555555', '${OWNER}', '${pw}',
             'Barbell_Squat', 99, 3, 5, 5)`,
  );
  const del = await db.query(
    `delete from prescriptions where id = '11111111-2222-4333-8444-555555555555'`,
  );
  assertEq(del.affectedRows ?? 0, 1, "an untrained prescription deletes");
});

await check("an edited library row stays shared, and no seed may revert it", async () => {
  // The bug this replaced: update_exercise re-tagged an edited seeded row
  // 'custom' so a re-seed could not revert it, but multi-user had made
  // 'custom' mean "belongs to one person" — and the claim trigger fires on
  // insert only, while the MCP path is the service role with no auth.uid().
  // The row satisfied neither branch of exercises_read and became readable by
  // NOBODY, taking every prescription naming it out of the plan with it.
  await db.exec(
    `update exercises set name = 'Barbell Back Squat', source = 'edited'
      where id = 'Barbell_Squat'`,
  );
  const mine = await asUser(OWNER, `select name from exercises where id = 'Barbell_Squat'`);
  assertEq(mine.rows.length, 1, "the editor can still see it");
  assertEq(mine.rows[0].name, "Barbell Back Squat", "and sees the edit");
  const theirs = await asUser(OTHER, `select count(*)::int as n from exercises where id = 'Barbell_Squat'`);
  assertEq(theirs.rows[0].n, 1, "so can everyone else — it is still a library row");
  const owned = await db.query(
    `select count(*)::int as n from exercise_owners where exercise_id = 'Barbell_Squat'`,
  );
  assertEq(owned.rows[0].n, 0, "and it belongs to nobody");
  // still not editable or deletable from the PWA: both policies want 'custom'
  const upd = await asUser(OTHER, `update exercises set name = 'X' where id = 'Barbell_Squat'`);
  assertEq(upd.affectedRows ?? 0, 0, "an edited row is no more writable than a seeded one");
  await db.exec(`update exercises set source = 'free-exercise-db', name = 'Barbell Squat'
                  where id = 'Barbell_Squat'`);
});

await check("source is a closed vocabulary, because RLS branches on it", async () => {
  // A typo used to publish a private row: `source <> 'custom'` is true for
  // 'Custom' and 'custum' alike.
  let rejected = false;
  try {
    await db.exec(
      `insert into exercises (id, name, primary_muscles, source)
       values ('Typo_Lift', 'Typo Lift', array['chest'], 'Custom')`,
    );
  } catch {
    rejected = true;
  }
  assertEq(rejected, true, "a source outside the four known values is refused");
});

await check("a custom exercise can only be edited or deleted by its owner", async () => {
  const foreignUpd = await asUser(
    OTHER,
    `update exercises set name = 'Hijacked' where id = 'Owner_Only_Lift'`,
  );
  assertEq(foreignUpd.affectedRows ?? 0, 0, "cannot edit another user's custom exercise");
  const ownUpd = await asUser(
    OWNER,
    `update exercises set name = 'Owner Only Lift v2' where id = 'Owner_Only_Lift'`,
  );
  assertEq(ownUpd.affectedRows ?? 0, 1, "owner can edit their own");
  const seededUpd = await asUser(OWNER, `update exercises set name = 'X' where id = 'Barbell_Squat'`);
  assertEq(seededUpd.affectedRows ?? 0, 0, "the shared library is not editable");
});

await check("mcp_tokens is invisible to authenticated users entirely", async () => {
  await db.exec(
    `insert into mcp_tokens (token_sha256, user_id, label)
     values ('${"a".repeat(64)}', '${OWNER}', 'owner laptop')`,
  );
  const r = await asUser(OWNER, `select count(*)::int as n from mcp_tokens`);
  assertEq(r.rows[0].n, 0, "RLS with no policies hides it even from its own user");
  let rejected = false;
  try {
    await asUser(OWNER, `insert into mcp_tokens (token_sha256, user_id, label)
                         values ('${"b".repeat(64)}', '${OWNER}', 'forged')`);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("authenticated user minted a credential");
});

await check("only a SHA-256 digest can be stored, never a raw token", async () => {
  let rejected = false;
  try {
    await db.exec(
      `insert into mcp_tokens (token_sha256, user_id, label)
       values ('sk-live-plaintext-token', '${OWNER}', 'oops')`,
    );
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("a non-digest was accepted as a token hash");
});

await check("deleting a user takes their tokens, config and ownership with them", async () => {
  await db.exec(`insert into auth.users (id, email) values ('00000000-0000-4000-8000-000000000009', 'temp@example.test');
                 insert into mcp_tokens (token_sha256, user_id, label) values ('${"c".repeat(64)}', '00000000-0000-4000-8000-000000000009', 'temp');
                 insert into user_config (user_id, tz) values ('00000000-0000-4000-8000-000000000009', 'UTC');
                 delete from auth.users where id = '00000000-0000-4000-8000-000000000009';`);
  const t = await db.query(`select count(*)::int as n from mcp_tokens where label = 'temp'`);
  assertEq(t.rows[0].n, 0, "tokens cascade");
  const c = await db.query(
    `select count(*)::int as n from user_config where user_id = '00000000-0000-4000-8000-000000000009'`,
  );
  assertEq(c.rows[0].n, 0, "config cascades");
});

console.log("\nprescription set_type (warmups live in the plan, not just the log):");

await check("existing prescriptions default to working, never null", async () => {
  const r = await db.query(
    `select count(*)::int as n, count(*) filter (where set_type = 'working')::int as working
       from prescriptions`,
  );
  assertEq(r.rows[0].n, r.rows[0].working, "every seeded prescription is working");
});

await check("v_resolved_prescriptions exposes set_type", async () => {
  const r = await db.query(`select set_type from v_resolved_prescriptions limit 1`);
  assertEq(r.rows[0].set_type, "working", "view carries the column through");
});

await check("a prescription can be marked warmup", async () => {
  await db.exec(
    `update prescriptions set set_type = 'warmup'
      where id = (select id from prescriptions order by id limit 1)`,
  );
  const r = await db.query(
    `select count(*)::int as n from v_resolved_prescriptions where set_type = 'warmup'`,
  );
  assertEq(r.rows[0].n, 1, "the view reflects it");
  await db.exec(`update prescriptions set set_type = 'working' where set_type = 'warmup'`);
});

await check("set_type on a prescription is constrained to the enum", async () => {
  let rejected = false;
  try {
    await db.exec(
      `update prescriptions set set_type = 'cooldown'
        where id = (select id from prescriptions order by id limit 1)`,
    );
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("an unknown set_type was accepted");
});

await check("adherence still gates on the ACTUAL set, not the plan", async () => {
  // Marking the PLAN a warmup must not delete real work from the analysis:
  // what the lifter did is what counts.
  const before = await db.query(`select count(*)::int as n from v_adherence`);
  await db.exec(`update prescriptions set set_type = 'warmup'`);
  const after = await db.query(`select count(*)::int as n from v_adherence`);
  assertEq(after.rows[0].n, before.rows[0].n, "adherence row count is unchanged");
  await db.exec(`update prescriptions set set_type = 'working'`);
});

console.log("\nworkout templates (a saved day with no date):");

await check("a template cannot carry a scheduled date", async () => {
  let rejected = false;
  try {
    await db.exec(
      `insert into planned_workouts (user_id, program_id, day_index, label, is_template, scheduled_date)
       values ('${OWNER}', (select id from programs limit 1), 900, 'bad', true, current_date)`,
    );
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("a dated template was accepted");
});

await check("v_plan_workouts hides templates from every plan read", async () => {
  await db.exec(
    `insert into planned_workouts (user_id, program_id, day_index, label, is_template)
     values ('${OWNER}', (select id from programs limit 1), 901, 'Push A', true)`,
  );
  const all = await db.query(
    `select count(*)::int as n from planned_workouts where label = 'Push A'`,
  );
  assertEq(all.rows[0].n, 1, "the row exists");
  const plan = await db.query(
    `select count(*)::int as n from v_plan_workouts where label = 'Push A'`,
  );
  assertEq(plan.rows[0].n, 0, "and the plan view does not see it");
});

await check("a template still owns prescriptions like any other day", async () => {
  await db.exec(
    `insert into prescriptions (user_id, planned_workout_id, exercise_id, position, sets, reps_min, reps_max, load_kg, set_type)
     values ('${OWNER}',
             (select id from planned_workouts where label = 'Push A'),
             (select id from exercises limit 1), 0, 3, 5, 5, 60, 'working')`,
  );
  const r = await db.query(
    `select count(*)::int as n from v_resolved_prescriptions
      where planned_workout_id = (select id from planned_workouts where label = 'Push A')`,
  );
  assertEq(r.rows[0].n, 1, "prescriptions resolve for a template too");
});

await check("deleting a template takes its prescriptions, not any session", async () => {
  const before = await db.query(`select count(*)::int as n from sessions`);
  await db.exec(`delete from planned_workouts where label = 'Push A'`);
  const rx = await db.query(
    `select count(*)::int as n from prescriptions
      where planned_workout_id not in (select id from planned_workouts)`,
  );
  assertEq(rx.rows[0].n, 0, "no orphaned prescriptions");
  const after = await db.query(`select count(*)::int as n from sessions`);
  assertEq(after.rows[0].n, before.rows[0].n, "sessions untouched");
});

console.log("\nfeedback (Claude's channel for what it could not do):");

await check("kind is a closed set", async () => {
  let rejected = false;
  try {
    await db.exec(
      `insert into feedback (user_id, kind, title) values ('${OWNER}', 'idea', 'nope')`,
    );
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("an unknown kind was accepted");
});

await check("a blank title is rejected", async () => {
  let rejected = false;
  try {
    await db.exec(
      `insert into feedback (user_id, kind, title) values ('${OWNER}', 'feature', '   ')`,
    );
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("a whitespace title was accepted");
});

await check("an entry is filed and resolves without being deleted", async () => {
  await db.exec(
    `insert into feedback (user_id, kind, title, context)
     values ('${OWNER}', 'data_gap', 'Cannot express AMRAP sets', 'coach wrote 3x5 + AMRAP')`,
  );
  await db.exec(
    `update feedback set resolved_at = now() where title = 'Cannot express AMRAP sets'`,
  );
  const r = await db.query(
    `select count(*)::int as n, count(resolved_at)::int as done from feedback
      where title = 'Cannot express AMRAP sets'`,
  );
  assertEq(r.rows[0].n, 1, "the row survives resolution");
  assertEq(r.rows[0].done, 1, "and is marked resolved");
});

await check("feedback is private to its owner", async () => {
  const pol = await db.query(
    `select count(*)::int as n from pg_policies
      where tablename = 'feedback' and cmd = 'DELETE'`,
  );
  assertEq(pol.rows[0].n, 0, "no delete policy: asking is a record");
});

await check("deleting a user takes their feedback with them", async () => {
  await db.exec(`insert into auth.users (id, email) values ('00000000-0000-4000-8000-00000000000a', 'fb@example.test');
                 insert into feedback (user_id, kind, title) values ('00000000-0000-4000-8000-00000000000a', 'bug', 'temp');
                 delete from auth.users where id = '00000000-0000-4000-8000-00000000000a';`);
  const r = await db.query(`select count(*)::int as n from feedback where title = 'temp'`);
  assertEq(r.rows[0].n, 0, "feedback cascades");
});

console.log("\nprograms are soft-deleted (nothing a model writes is unrecoverable):");

await check("discarding a program takes its days off the calendar", async () => {
  const before = await db.query(`select count(*)::int as n from v_plan_workouts`);
  await db.exec(`update programs set discarded_at = now()`);
  const after = await db.query(`select count(*)::int as n from v_plan_workouts`);
  assertEq(after.rows[0].n, 0, "no plannable days survive a discarded program");
  if (before.rows[0].n === 0) throw new Error("fixture had no days to hide");
  await db.exec(`update programs set discarded_at = null`);
});

await check("but the rows themselves survive, and can come back", async () => {
  const restored = await db.query(`select count(*)::int as n from v_plan_workouts`);
  if (restored.rows[0].n === 0) throw new Error("undiscarding did not restore the days");
  const rx = await db.query(`select count(*)::int as n from prescriptions`);
  if (rx.rows[0].n === 0) throw new Error("prescriptions were destroyed");
});

await check("a discarded program takes no sessions or sets with it", async () => {
  const s0 = await db.query(`select count(*)::int as n from sessions`);
  const x0 = await db.query(`select count(*)::int as n from sets`);
  await db.exec(`update programs set discarded_at = now()`);
  const s1 = await db.query(`select count(*)::int as n from sessions`);
  const x1 = await db.query(`select count(*)::int as n from sets`);
  assertEq(s1.rows[0].n, s0.rows[0].n, "sessions untouched");
  assertEq(x1.rows[0].n, x0.rows[0].n, "sets untouched");
  await db.exec(`update programs set discarded_at = null`);
});

await check("v_plan_workouts still hides templates as well", async () => {
  await db.exec(
    `insert into planned_workouts (user_id, program_id, day_index, label, is_template)
     values ('${OWNER}', (select id from programs where discarded_at is null limit 1), 950, 'Tpl', true)`,
  );
  const r = await db.query(
    `select count(*)::int as n from v_plan_workouts where label = 'Tpl'`,
  );
  assertEq(r.rows[0].n, 0, "both filters apply, not just the newer one");
  await db.exec(`delete from planned_workouts where label = 'Tpl'`);
});

console.log("\nsections and tracking mode:");

await check("section is optional and length-bounded", async () => {
  const w = `(select id from planned_workouts where not is_template limit 1)`;
  const e = `(select id from exercises limit 1)`;
  await db.exec(
    `insert into prescriptions (user_id, planned_workout_id, exercise_id, position, sets, reps_min, reps_max, section)
     values ('${OWNER}', ${w}, ${e}, 800, 3, 8, 8, 'Activations')`,
  );
  let rejected = false;
  try {
    await db.exec(
      `insert into prescriptions (user_id, planned_workout_id, exercise_id, position, sets, reps_min, reps_max, section)
       values ('${OWNER}', ${w}, ${e}, 801, 3, 8, 8, '   ')`,
    );
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("a blank section name was accepted");
});

await check("tracking defaults to reps, so nothing existing changes meaning", async () => {
  const r = await db.query(
    `select count(*)::int as n, count(*) filter (where tracking = 'reps')::int as reps
       from prescriptions`,
  );
  assertEq(r.rows[0].n, r.rows[0].reps, "every existing prescription is 'reps'");
});

await check("v_resolved_prescriptions exposes section and tracking", async () => {
  const r = await db.query(
    `select section, tracking from v_resolved_prescriptions where section = 'Activations'`,
  );
  assertEq(r.rows.length, 1, "the sectioned row is visible");
  assertEq(r.rows[0].tracking, "reps", "and carries its tracking mode");
});

await check("a 'done' set is a real set and pollutes no analytics", async () => {
  // reps 0 at load 0 is already legal; the point is that volume and e1RM
  // ignore it through their EXISTING filters, with no new coupling.
  const sess = await db.query(`select id, user_id from sessions limit 1`);
  const s = sess.rows[0];
  const before = await db.query(
    `select coalesce(sum(tonnage_kg),0)::float as t from v_weekly_volume`,
  );
  await db.exec(
    `insert into sets (id, user_id, session_id, exercise_id, set_index, set_type, load_kg, reps)
     values (gen_random_uuid(), '${s.user_id}', '${s.id}', (select id from exercises limit 1), 99, 'working', 0, 0)`,
  );
  const after = await db.query(
    `select coalesce(sum(tonnage_kg),0)::float as t from v_weekly_volume`,
  );
  assertEq(after.rows[0].t, before.rows[0].t, "tonnage unchanged");
  const e = await db.query(
    `select count(*)::int as n from v_e1rm where reps = 0`,
  );
  assertEq(e.rows[0].n, 0, "and no e1RM row");
});

console.log("\nexercise notes (a cue that belongs to the movement):");

await check("one note per person per exercise", async () => {
  const ex = `(select id from exercises limit 1)`;
  await db.exec(
    `insert into exercise_notes (user_id, exercise_id, note)
     values ('${OWNER}', ${ex}, 'front foot stays flat')`,
  );
  let rejected = false;
  try {
    await db.exec(
      `insert into exercise_notes (user_id, exercise_id, note)
       values ('${OWNER}', ${ex}, 'second note')`,
    );
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("a duplicate note was accepted");
});

await check("it is editable, unlike a set", async () => {
  await db.exec(
    `update exercise_notes set note = 'ribs down too' where user_id = '${OWNER}'`,
  );
  const r = await db.query(
    `select note from exercise_notes where user_id = '${OWNER}'`,
  );
  assertEq(r.rows[0].note, "ribs down too", "the note updated in place");
});

await check("two people can note the same shared exercise", async () => {
  const ex = `(select id from exercises limit 1)`;
  await db.exec(
    `insert into exercise_notes (user_id, exercise_id, note)
     values ('${OTHER}', ${ex}, 'mine, not theirs')`,
  );
  const r = await db.query(`select count(*)::int as n from exercise_notes`);
  assertEq(r.rows[0].n, 2, "both rows coexist");
});

await check("a note is private to its owner", async () => {
  const mine = await asUser(OWNER, `select count(*)::int as n from exercise_notes`);
  assertEq(mine.rows[0].n, 1, "the owner sees only their own");
  let rejected = false;
  try {
    await asUser(
      OWNER,
      `insert into exercise_notes (user_id, exercise_id, note)
       values ('${OTHER}', (select id from exercises offset 1 limit 1), 'not mine to write')`,
    );
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("wrote a note onto another user");
});

await check("deleting a user takes their notes, not the exercise", async () => {
  const ex = await db.query(`select count(*)::int as n from exercises`);
  await db.exec(`delete from auth.users where id = '${OTHER}'`);
  const n = await db.query(`select count(*)::int as n from exercise_notes`);
  assertEq(n.rows[0].n, 1, "their note went with them");
  const after = await db.query(`select count(*)::int as n from exercises`);
  assertEq(after.rows[0].n, ex.rows[0].n, "the shared exercise survives");
});

console.log("\ncoach memory (so they stop repeating themselves):");

await check("kind is a closed set and a blank fact is rejected", async () => {
  await db.exec(
    `insert into coach_memory (user_id, kind, fact)
     values ('${OWNER}', 'injury', 'Left shoulder impingement; avoid overhead pressing')`,
  );
  for (const bad of [
    `insert into coach_memory (user_id, kind, fact) values ('${OWNER}', 'vibe', 'x')`,
    `insert into coach_memory (user_id, kind, fact) values ('${OWNER}', 'injury', '   ')`,
  ]) {
    let rejected = false;
    try {
      await db.exec(bad);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`accepted: ${bad}`);
  }
});

await check("a fact that stops being true can be deleted", async () => {
  // Unlike the training record. An expired fact is not history, it is
  // something that would make every future answer worse.
  const pol = await db.query(
    `select count(*)::int as n from pg_policies
      where tablename = 'coach_memory' and cmd = 'DELETE'`,
  );
  assertEq(pol.rows[0].n, 1, "there is a delete policy, on purpose");
});

await check("memory is private to its owner", async () => {
  const mine = await asUser(OWNER, `select count(*)::int as n from coach_memory`);
  assertEq(mine.rows[0].n, 1, "owner sees their own");
  let rejected = false;
  try {
    await asUser(
      OWNER,
      `insert into coach_memory (user_id, kind, fact) values ('${OTHER}', 'context', 'not mine')`,
    );
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("wrote a memory onto another user");
});

// --- function grants (20260905030000) -------------------------------------
console.log("\nfunction grants (the linter baseline in docs/security.md):");
await db.exec("reset role;");

await check("purge_expired_mcp_tokens is not callable by anon or authenticated", async () => {
  const r = await db.query(`
    select has_function_privilege('anon', 'public.purge_expired_mcp_tokens()', 'execute') as anon,
           has_function_privilege('authenticated', 'public.purge_expired_mcp_tokens()', 'execute') as authed`);
  assertEq(r.rows[0], { anon: false, authed: false }, "execute on purge_expired_mcp_tokens");
});

await check("but an ordinary public function still is (the revoke is targeted)", async () => {
  const r = await db.query(
    `select has_function_privilege('authenticated', 'public.app_tz()', 'execute') as authed`,
  );
  assertEq(r.rows[0].authed, true, "execute on app_tz");
});

await check("every public function pins search_path", async () => {
  const r = await db.query(`
    select p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
    order by 1`);
  assertEq(r.rows.map((x) => x.proname), [], "functions without search_path");
});

// --- B · training plans ---------------------------------------------------
// The plan above the program (20260905060000). Three rules the schema has to
// hold on its own, whichever path writes: phases of one plan never share a
// day, one live plan per user, and another user's plan does not exist.
console.log("\ntraining plans (one live plan, non-overlapping phases, private):");
await db.exec("reset role;");
// The exercise-notes checks above delete OTHER to prove the cascade; the
// cross-user checks here need a second person again.
await db.exec(`insert into auth.users (id, email) values ('${OTHER}', 'other@example.test') on conflict do nothing`);

const PLAN_A = "66666666-0000-4000-8000-000000000001";
const PLAN_B = "66666666-0000-4000-8000-000000000002";
const PHASE = (n) => `77777777-0000-4000-8000-00000000000${n}`;

await check("a plan with dated, adjacent phases writes in one statement", async () => {
  await db.exec(`
    insert into training_plans (id, user_id, objective, starts_on, ends_on)
      values ('${PLAN_A}', '${OWNER}', 'Squat 200 kg by spring', '2026-09-01', '2026-12-20');
    insert into plan_phases (id, user_id, plan_id, position, name, starts_on, ends_on, focus, progression)
      values
      ('${PHASE(1)}', '${OWNER}', '${PLAN_A}', 0, 'Accumulation',     '2026-09-01', '2026-10-12', 'hypertrophy on the squat pattern', 'add 2.5 kg when every set hits the top of the range'),
      ('${PHASE(2)}', '${OWNER}', '${PLAN_A}', 1, 'Intensification', '2026-10-13', '2026-11-23', 'heavier triples', 'add 2.5 kg per week'),
      ('${PHASE(3)}', '${OWNER}', '${PLAN_A}', 2, 'Peak',            '2026-11-24', '2026-12-20', 'singles', 'by feel');
  `);
  const r = await db.query(`select count(*)::int as n from plan_phases where plan_id = '${PLAN_A}'`);
  assertEq(r.rows[0].n, 3, "three phases");
});

await check("two overlapping phases in ONE bulk insert are refused (the trigger is AFTER ROW)", async () => {
  // set_training_plan writes every phase of a plan in one statement. A BEFORE
  // ROW trigger cannot see the earlier rows of the statement it is part of;
  // an AFTER ROW trigger fires once all of them are in.
  await db.exec(`insert into training_plans (id, user_id, objective, starts_on, ends_on)
                   values ('${PLAN_B}', '${OTHER}', 'other plan', '2026-09-01', '2026-12-31')`);
  let code = null;
  try {
    await db.exec(`
      insert into plan_phases (user_id, plan_id, position, name, starts_on, ends_on) values
        ('${OTHER}', '${PLAN_B}', 0, 'One', '2026-09-01', '2026-09-30'),
        ('${OTHER}', '${PLAN_B}', 1, 'Two', '2026-09-30', '2026-10-31');
    `);
  } catch (e) {
    code = e.code ?? e.message;
  }
  assertEq(code, "23P01", "exclusion_violation, the SQLSTATE an exclusion constraint raises");
  const r = await db.query(`select count(*)::int as n from plan_phases where plan_id = '${PLAN_B}'`);
  assertEq(r.rows[0].n, 0, "the whole statement rolled back");
});

await check("a phase that shares one day with a neighbour is refused; the next day is fine", async () => {
  // Bounds are inclusive on both ends ('[]'): a phase ending on the 12th and
  // one starting on the 12th overlap. Separate statement this time.
  let rejected = false;
  try {
    await db.exec(`insert into plan_phases (user_id, plan_id, position, name, starts_on, ends_on)
                     values ('${OWNER}', '${PLAN_A}', 3, 'Overlap', '2026-12-20', '2026-12-31')`);
  } catch (e) {
    rejected = e.code === "23P01";
  }
  if (!rejected) throw new Error("accepted a phase sharing a day with Peak");
  // An UPDATE that creates an overlap is refused too.
  rejected = false;
  try {
    await db.exec(`update plan_phases set ends_on = '2026-10-13' where id = '${PHASE(1)}'`);
  } catch (e) {
    rejected = e.code === "23P01";
  }
  if (!rejected) throw new Error("accepted an update that made Accumulation overlap Intensification");
  await db.exec(`insert into plan_phases (user_id, plan_id, position, name, starts_on, ends_on)
                   values ('${OWNER}', '${PLAN_A}', 3, 'Deload', '2026-12-21', '2026-12-27')`);
  const r = await db.query(`select count(*)::int as n from plan_phases where plan_id = '${PLAN_A}'`);
  assertEq(r.rows[0].n, 4, "the day after is not an overlap");
});

await check("a second live plan for the same user is refused; superseding the first admits it", async () => {
  let rejected = false;
  try {
    await db.exec(`insert into training_plans (user_id, objective, starts_on, ends_on)
                     values ('${OWNER}', 'a second live plan', '2027-01-01', '2027-03-31')`);
  } catch (e) {
    rejected = e.code === "23505";
  }
  if (!rejected) throw new Error("two live plans for one user");
  await db.exec(`update training_plans set superseded_at = now() where id = '${PLAN_A}'`);
  await db.exec(`insert into training_plans (id, user_id, objective, starts_on, ends_on)
                   values ('66666666-0000-4000-8000-000000000003', '${OWNER}', 'the revision', '2027-01-01', '2027-03-31')`);
  const r = await db.query(
    `select count(*)::int as n from training_plans where user_id = '${OWNER}' and superseded_at is null`,
  );
  assertEq(r.rows[0].n, 1, "exactly one live plan");
  const hist = await db.query(`select count(*)::int as n from training_plans where user_id = '${OWNER}'`);
  assertEq(hist.rows[0].n, 2, "the superseded plan is still in Postgres");
});

await check("another user's plan and phases do not exist through RLS", async () => {
  const plans = await asUser(OTHER, `select count(*)::int as n from training_plans`);
  assertEq(plans.rows[0].n, 1, "OTHER sees only their own plan");
  const phases = await asUser(OTHER, `select count(*)::int as n from plan_phases`);
  assertEq(phases.rows[0].n, 0, "OTHER sees none of OWNER's phases");
  let rejected = false;
  try {
    await asUser(
      OTHER,
      `insert into plan_phases (user_id, plan_id, position, name, starts_on, ends_on)
         values ('${OWNER}', '${PLAN_A}', 9, 'Injected', '2028-01-01', '2028-01-31')`,
    );
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("wrote a phase onto another user's plan");
  // RLS refuses an UPDATE by matching zero rows, not by raising.
  const touched = await asUser(
    OTHER,
    `update plan_phases set name = 'renamed' where id = '${PHASE(1)}' returning id`,
  );
  assertEq(touched.rows.length, 0, "renamed another user's phase");
});

await check("neither plan table has a delete policy, on purpose", async () => {
  const r = await db.query(
    `select tablename, count(*)::int as n from pg_policies
      where tablename in ('training_plans', 'plan_phases') and cmd = 'DELETE'
      group by tablename`,
  );
  assertEq(r.rows, [], "a plan is superseded, never deleted; a phase has no life outside its plan");
});

await check("a program files under a phase, and survives the phase", async () => {
  await db.exec(`insert into programs (id, user_id, name, confirmed_at, phase_id)
                   values ('11111111-0000-4000-8000-000000000077', '${OWNER}', 'Accumulation block', now(), '${PHASE(1)}')`);
  const r = await db.query(
    `select ph.name from programs p join plan_phases ph on ph.id = p.phase_id
      where p.id = '11111111-0000-4000-8000-000000000077'`,
  );
  assertEq(r.rows[0].name, "Accumulation", "joins to the phase by name");
  let rejected = false;
  try {
    await db.exec(`insert into programs (user_id, name, phase_id)
                     values ('${OWNER}', 'dangling', '77777777-0000-4000-8000-0000000000ff')`);
  } catch (e) {
    rejected = e.code === "23503";
  }
  if (!rejected) throw new Error("a program pointed at a phase that does not exist");
  // No client can reach this delete (no policy), but a hand-run one in psql
  // must not take the training with it.
  const deload = await db.query(`select id from plan_phases where name = 'Deload'`);
  await db.exec(`update programs set phase_id = '${deload.rows[0].id}' where id = '11111111-0000-4000-8000-000000000077'`);
  await db.exec(`delete from plan_phases where id = '${deload.rows[0].id}'`);
  const after = await db.query(`select phase_id from programs where id = '11111111-0000-4000-8000-000000000077'`);
  assertEq(after.rows[0].phase_id, null, "on delete set null: the program is still there, unfiled");
});


// --- A · push alerts ---------------------------------------------------------
// The three tables behind "alert me when the app is closed" (20260905050000).
// A subscription is a device's address and must be private to its owner; the
// VAPID key pair must be unreadable by ANY client; an alert is written only by
// the function and readable by the person it belongs to.
console.log("\npush alerts (rest alert while the app is closed):");
await db.exec("reset role;");

// OTHER was deleted above, so this section stands up its own second person.
const PUSH_A = "00000000-0000-4000-8000-00000000000a";
const PUSH_B = "00000000-0000-4000-8000-00000000000b";
await db.exec(`
  insert into auth.users (id, email) values
    ('${PUSH_A}', 'push-a@example.test'), ('${PUSH_B}', 'push-b@example.test')
  on conflict do nothing;
`);
// 65-byte uncompressed P-256 point and 16-byte auth secret, base64url: the
// shapes a real browser hands back from PushSubscription.getKey().
const P256DH = "B" + "A".repeat(86);
const AUTH16 = "A".repeat(22);

await check("push_subscriptions: owner can subscribe, and sees only their own", async () => {
  await asUser(
    PUSH_A,
    `insert into push_subscriptions (endpoint, p256dh, auth, user_agent)
     values ('https://push.example.test/a', '${P256DH}', '${AUTH16}', 'ua')`,
  );
  await db.exec(
    `insert into push_subscriptions (user_id, endpoint, p256dh, auth)
     values ('${PUSH_B}', 'https://push.example.test/b', '${P256DH}', '${AUTH16}')`,
  );
  const a = await asUser(PUSH_A, `select endpoint from push_subscriptions order by endpoint`);
  assertEq(a.rows.map((r) => r.endpoint), ["https://push.example.test/a"], "A sees only A");
  const b = await asUser(PUSH_B, `select count(*)::int as n from push_subscriptions`);
  assertEq(b.rows[0].n, 1, "B sees only B");
});

await check("push_subscriptions: auth.uid() stamps the owner; naming someone else is refused", async () => {
  const r = await db.query(
    `select user_id from push_subscriptions where endpoint = 'https://push.example.test/a'`,
  );
  assertEq(r.rows[0].user_id, PUSH_A, "owner stamped by default");
  let rejected = false;
  try {
    await asUser(
      PUSH_A,
      `insert into push_subscriptions (user_id, endpoint, p256dh, auth)
       values ('${PUSH_B}', 'https://push.example.test/forged', '${P256DH}', '${AUTH16}')`,
    );
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("subscribed a device on someone else's behalf");
});

await check("push_subscriptions: owner can revoke their own, never another's, and nobody deletes", async () => {
  const mine = await asUser(
    PUSH_A,
    `update push_subscriptions set revoked_at = now()
     where endpoint = 'https://push.example.test/a' returning id`,
  );
  assertEq(mine.rows.length, 1, "own row revoked");
  const theirs = await asUser(
    PUSH_A,
    `update push_subscriptions set revoked_at = now()
     where endpoint = 'https://push.example.test/b' returning id`,
  );
  assertEq(theirs.rows.length, 0, "another user's row untouched");
  const del = await asUser(PUSH_A, `delete from push_subscriptions returning id`);
  assertEq(del.rows.length, 0, "no delete policy");
  const pol = await db.query(
    `select count(*)::int as n from pg_policies where tablename = 'push_subscriptions' and cmd = 'DELETE'`,
  );
  assertEq(pol.rows[0].n, 0, "and none exists");
});

await check("push_subscriptions: endpoint is unique and the key shapes are pinned", async () => {
  for (const bad of [
    // duplicate endpoint
    `insert into push_subscriptions (user_id, endpoint, p256dh, auth)
     values ('${PUSH_B}', 'https://push.example.test/b', '${P256DH}', '${AUTH16}')`,
    // http endpoint
    `insert into push_subscriptions (user_id, endpoint, p256dh, auth)
     values ('${PUSH_B}', 'http://push.example.test/plain', '${P256DH}', '${AUTH16}')`,
    // wrong key lengths
    `insert into push_subscriptions (user_id, endpoint, p256dh, auth)
     values ('${PUSH_B}', 'https://push.example.test/short', 'abc', '${AUTH16}')`,
    `insert into push_subscriptions (user_id, endpoint, p256dh, auth)
     values ('${PUSH_B}', 'https://push.example.test/short2', '${P256DH}', 'abc')`,
    // standard base64 padding is not base64url
    `insert into push_subscriptions (user_id, endpoint, p256dh, auth)
     values ('${PUSH_B}', 'https://push.example.test/padded', '${P256DH}', '${"A".repeat(21)}=')`,
  ]) {
    let rejected = false;
    try {
      await db.exec(bad);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`accepted: ${bad}`);
  }
});

await check("push_config: RLS on, no policies, unreadable and unwritable as authenticated", async () => {
  // the service role (here: superuser) writes the key pair
  await db.exec(
    `insert into push_config (id, vapid_public_key, vapid_private_jwk)
     values (1, 'B${"A".repeat(86)}', '{"kty":"EC","crv":"P-256"}')`,
  );
  const rls = await db.query(
    `select relrowsecurity from pg_class where relname = 'push_config'`,
  );
  assertEq(rls.rows[0].relrowsecurity, true, "row security enabled");
  const pol = await db.query(
    `select count(*)::int as n from pg_policies where tablename = 'push_config'`,
  );
  assertEq(pol.rows[0].n, 0, "no policies at all — see docs/security.md");
  const seen = await asUser(PUSH_A, `select count(*)::int as n from push_config`);
  assertEq(seen.rows[0].n, 0, "an authenticated user reads nothing");
  let rejected = false;
  try {
    await asUser(
      PUSH_A,
      `insert into push_config (id, vapid_public_key, vapid_private_jwk)
       values (2, 'x', '{}')`,
    );
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("an authenticated user wrote push_config");
});

await check("push_config: a single row, and only row 1", async () => {
  let rejected = false;
  try {
    await db.exec(
      `insert into push_config (id, vapid_public_key, vapid_private_jwk) values (2, 'x', '{}')`,
    );
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("a second key pair was accepted");
});

await check("rest_alerts: the function writes, the owner reads, nobody else does either", async () => {
  await db.exec(
    `insert into rest_alerts (user_id, fire_at, label)
     values ('${PUSH_A}', now() + interval '90 seconds', 'Barbell Row set 3')`,
  );
  const mine = await asUser(PUSH_A, `select label from rest_alerts`);
  assertEq(mine.rows.map((r) => r.label), ["Barbell Row set 3"], "owner reads own");
  const theirs = await asUser(PUSH_B, `select count(*)::int as n from rest_alerts`);
  assertEq(theirs.rows[0].n, 0, "another user sees nothing");
  for (const sql of [
    `insert into rest_alerts (user_id, fire_at, label) values ('${PUSH_A}', now(), 'mine')`,
    `update rest_alerts set cancelled_at = now() returning id`,
    `delete from rest_alerts returning id`,
  ]) {
    let wrote = false;
    try {
      const r = await asUser(PUSH_A, sql);
      wrote = (r.rows?.length ?? 0) > 0;
    } catch {
      // refused outright — also fine
    }
    if (wrote) throw new Error(`a client wrote rest_alerts: ${sql}`);
  }
});

await check("rest_alerts: the label is one printable line, and the open-alert index exists", async () => {
  for (const bad of ["", "x".repeat(121), "two\nlines", "tab\there"]) {
    let rejected = false;
    try {
      await db.query(
        `insert into rest_alerts (user_id, fire_at, label) values ('${PUSH_A}', now(), $1)`,
        [bad],
      );
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`accepted label ${JSON.stringify(bad)}`);
  }
  const idx = await db.query(
    `select indexdef from pg_indexes where indexname = 'idx_rest_alerts_open'`,
  );
  assert(idx.rows.length === 1, "idx_rest_alerts_open exists");
  assert(
    /WHERE .*sent_at IS NULL.*cancelled_at IS NULL/i.test(idx.rows[0].indexdef),
    `partial on open alerts: ${idx.rows[0].indexdef}`,
  );
});

await check("deleting a user takes their subscriptions and alerts with them", async () => {
  await db.exec(`delete from auth.users where id = '${PUSH_A}'`);
  const subs = await db.query(
    `select count(*)::int as n from push_subscriptions where user_id = '${PUSH_A}'`,
  );
  const alerts = await db.query(
    `select count(*)::int as n from rest_alerts where user_id = '${PUSH_A}'`,
  );
  assertEq([subs.rows[0].n, alerts.rows[0].n], [0, 0], "cascaded");
  const cfg = await db.query(`select count(*)::int as n from push_config`);
  assertEq(cfg.rows[0].n, 1, "the deployment key pair is nobody's and survives");
});

// --- coach cost, priced by model (20260907010000) ----------------------------
// The view charged Sonnet rates for whatever ran, so every Opus turn was
// reported at 40% of its cost. These pin the two behaviours that fix it: rates
// follow the `model` column, and a model with no rates is reported as UNPRICED
// rather than as cheap.
console.log("\ncoach cost (priced by the model that ran):");
await db.exec("reset role;");

const COST_U = "00000000-0000-4000-8000-0000000000c1";
await db.exec(`
  insert into auth.users (id, email) values ('${COST_U}', 'cost@example.test')
  on conflict do nothing;
`);

// One million input and one million output tokens, so cost_usd reads as the
// per-MTok rate directly and an arithmetic slip is visible rather than subtle.
await db.exec(`
  insert into coach_usage (user_id, model, input_tokens, output_tokens,
                           cache_read_tokens, cache_write_tokens)
  values
    ('${COST_U}', 'claude-sonnet-5', 1000000, 1000000, 0, 0),
    ('${COST_U}', 'claude-opus-5',   1000000, 1000000, 0, 0),
    ('${COST_U}', 'claude-haiku-4-5', 1000000, 1000000, 0, 0);
`);

await check("each model is charged its own rates, not the last one hard-coded", async () => {
  const r = await db.query(
    `select model, cost_usd from v_coach_cost
      where user_id = '${COST_U}' order by model`,
  );
  const by = Object.fromEntries(r.rows.map((x) => [x.model, x.cost_usd]));
  assertEq(Number(by["claude-sonnet-5"]), 12, "sonnet 5: $2 in + $10 out");
  assertEq(Number(by["claude-opus-5"]), 30, "opus 5: $5 in + $25 out");
  assert(
    Number(by["claude-opus-5"]) > Number(by["claude-sonnet-5"]),
    "the expensive model costs more, which is the whole bug",
  );
});

await check("an unknown model is unpriced, never silently cheap", async () => {
  const r = await db.query(
    `select cost_usd from v_coach_cost
      where user_id = '${COST_U}' and model = 'claude-haiku-4-5'`,
  );
  assertEq(r.rows[0].cost_usd, null, "no rates means no number");
});

await check("the daily rollup admits the total is a floor", async () => {
  const r = await db.query(
    `select turns, unpriced_turns, cost_usd from v_coach_spend_daily
      where user_id = '${COST_U}'`,
  );
  assertEq(Number(r.rows[0].turns), 3, "three turns");
  assertEq(Number(r.rows[0].unpriced_turns), 1, "one of them unpriced");
  // 12 + 30, with the unpriced turn contributing nothing: a sum() over a null
  // would otherwise shrink the total with nothing to show for it.
  assertEq(Number(r.rows[0].cost_usd), 42, "priced turns only");
});

await check("cache tokens derive from the input rate rather than drifting", async () => {
  await db.exec(`
    insert into coach_usage (user_id, model, input_tokens, output_tokens,
                             cache_read_tokens, cache_write_tokens)
    values ('${COST_U}', 'claude-opus-5', 0, 0, 1000000, 1000000);
  `);
  const r = await db.query(
    `select cost_usd from v_coach_cost
      where user_id = '${COST_U}' and input_tokens = 0 and cache_read_tokens = 1000000`,
  );
  // Opus input is $5: writes at 1.25x = $6.25, reads at 0.10x = $0.50.
  assertEq(Number(r.rows[0].cost_usd), 6.75, "6.25 write + 0.50 read");
});

// --- coach access, the per-person switch (20260907020000) --------------------
// COACH_ALLOWED_USERS is the door (an env var, checked before any db read);
// this is the switch (a row, per person, readable by the app). What has to hold:
// no row means ON, the subject can read their own row but cannot flip it, and
// nobody reads anyone else's.
console.log("\ncoach access (the per-person switch):");
await db.exec("reset role;");

const CA_A = "00000000-0000-4000-8000-0000000000d1";
const CA_B = "00000000-0000-4000-8000-0000000000d2";
await db.exec(`
  insert into auth.users (id, email) values
    ('${CA_A}', 'ca-a@example.test'), ('${CA_B}', 'ca-b@example.test')
  on conflict do nothing;
`);

await check("no row means the coach is ON, so this table changed nothing", async () => {
  const r = await db.query(`select coach_enabled('${CA_A}') as on`);
  assertEq(r.rows[0].on, true, "absent row reads as enabled");
});

await check("the service role switches one person off, and only that person", async () => {
  await db.exec(`
    insert into coach_access (user_id, enabled, reason)
    values ('${CA_A}', false, 'paused while we sort out the bill');
  `);
  const a = await db.query(`select coach_enabled('${CA_A}') as on`);
  const b = await db.query(`select coach_enabled('${CA_B}') as on`);
  assertEq([a.rows[0].on, b.rows[0].on], [false, true], "one off, one untouched");
});

await check("the person reads their own row, and the reason meant for them", async () => {
  const r = await asUser(CA_A, `select enabled, reason from coach_access`);
  assertEq(r.rows.length, 1, "sees their own row");
  assertEq(r.rows[0].enabled, false, "and that it is off");
  assert(
    typeof r.rows[0].reason === "string" && r.rows[0].reason.length > 0,
    "with something to show them",
  );
});

await check("nobody reads anyone else's switch", async () => {
  const r = await asUser(CA_B, `select * from coach_access`);
  assertEq(r.rows.length, 0, "B sees nothing of A's");
});

// The reason this is not a column on user_config, which carries an owner UPDATE
// policy: a switch its subject can flip is not an administrative control. RLS
// refuses an update with no policy by matching ZERO ROWS rather than by
// erroring, so the assertion is affectedRows and not a rejection.
await check("the subject cannot switch themselves back on", async () => {
  const upd = await asUser(
    CA_A,
    `update coach_access set enabled = true where user_id = '${CA_A}'`,
  );
  assertEq(upd.affectedRows ?? 0, 0, "no update policy");
  const still = await db.query(`select coach_enabled('${CA_A}') as on`);
  assertEq(still.rows[0].on, false, "still off");
});

await check("nor delete the row, nor insert one for themselves", async () => {
  const del = await asUser(
    CA_A,
    `delete from coach_access where user_id = '${CA_A}'`,
  );
  assertEq(del.affectedRows ?? 0, 0, "no delete policy");
  // Insert is the one that DOES raise: a with-check violation is an error,
  // where a missing row to update simply is not there.
  let rejected = false;
  try {
    await asUser(
      CA_B,
      `insert into coach_access (user_id, enabled) values ('${CA_B}', true)`,
    );
  } catch {
    rejected = true;
  }
  assert(rejected, "no insert policy");
});

await check("coach_enabled leaks nothing when asked about someone else", async () => {
  // SECURITY INVOKER on purpose. B asking about A reads nothing through RLS and
  // gets the default; definer would have made this a probe for anyone's state.
  const r = await asUser(CA_B, `select coach_enabled('${CA_A}') as on`);
  assertEq(r.rows[0].on, true, "the default, not A's real answer");
});

await check("deleting a user takes their switch with them", async () => {
  await db.exec(`delete from auth.users where id = '${CA_A}'`);
  const n = await db.query(
    `select count(*)::int as n from coach_access where user_id = '${CA_A}'`,
  );
  assertEq(n.rows[0].n, 0, "cascaded");
});

// --- E0 activities: two sources, either, or neither (20260907030000) ---------
console.log("\nendurance activities (both sources, either, or neither):");
await db.exec("reset role;");

const EA = "00000000-0000-4000-8000-0000000000e1";
const EB = "00000000-0000-4000-8000-0000000000e2";
await db.exec(`
  insert into auth.users (id, email) values
    ('${EA}', 'ea@example.test'), ('${EB}', 'eb@example.test')
  on conflict do nothing;
`);

const act = (o) => `
  insert into activities (user_id, source, external_id, sport, started_at,
                          elapsed_s, moving_s, distance_m, ascent_m, descent_m)
  values ('${o.user}', '${o.source}', '${o.ext}', '${o.sport ?? "Run"}',
          timestamptz '${o.at}', ${o.elapsed}, ${o.moving},
          ${o.dist ?? "null"}, ${o.up ?? "null"}, ${o.down ?? "null"})`;

// NONE configured is a supported state and must not be an error anywhere.
await check("with no source connected, the endurance views are simply empty", async () => {
  const a = await db.query(
    `select count(*)::int as n from v_live_activities where user_id = '${EA}'`,
  );
  const w = await db.query(
    `select count(*)::int as n from v_weekly_endurance where user_id = '${EA}'`,
  );
  assertEq([a.rows[0].n, w.rows[0].n], [0, 0], "empty, not broken");
});

await check("one source alone lands its activities", async () => {
  await db.exec(
    act({ user: EA, source: "strava", ext: "s1", at: "2026-09-01T07:00:00Z",
          elapsed: 3600, moving: 3500, dist: 10000, up: 300, down: 290 }),
  );
  const r = await db.query(
    `select count(*)::int as n from v_live_activities where user_id = '${EA}'`,
  );
  assertEq(r.rows[0].n, 1, "one run");
});

// The reason the dedup rule exists: one Garmin upload reaching both providers.
await check("the same effort from a second source is marked, not counted twice", async () => {
  await db.exec(
    act({ user: EA, source: "intervals_icu", ext: "i1", at: "2026-09-01T07:00:40Z",
          elapsed: 3600, moving: 3510, dist: 10010, up: 301, down: 291 }),
  );
  const raw = await db.query(
    `select count(*)::int as n from activities where user_id = '${EA}'`,
  );
  const live = await db.query(
    `select count(*)::int as n from v_live_activities where user_id = '${EA}'`,
  );
  assertEq(raw.rows[0].n, 2, "both rows kept -- the duplicate is evidence");
  assertEq(live.rows[0].n, 1, "counted once");
  const dup = await db.query(
    `select duplicate_of is not null as marked from activities
      where user_id = '${EA}' and source = 'intervals_icu'`,
  );
  assertEq(dup.rows[0].marked, true, "the later arrival is the one marked");
});

await check("weekly endurance counts the effort once, descent kept separate", async () => {
  const r = await db.query(
    `select activities::int as n, ascent_m::float as up, descent_m::float as down
       from v_weekly_endurance where user_id = '${EA}'`,
  );
  assertEq(r.rows[0].n, 1, "not doubled");
  assertEq([r.rows[0].up, r.rows[0].down], [300, 290], "gain and loss are different numbers");
});

// The conservative direction: rather leave two rows than hide a real session.
await check("a genuinely separate effort is not swallowed by the matcher", async () => {
  await db.exec(
    act({ user: EA, source: "intervals_icu", ext: "i2", at: "2026-09-01T07:25:00Z",
          elapsed: 1200, moving: 1200, dist: 4000 }),
  );
  const live = await db.query(
    `select count(*)::int as n from v_live_activities where user_id = '${EA}'`,
  );
  assertEq(live.rows[0].n, 2, "a second, shorter run 25 minutes later still counts");
});

await check("two rows from ONE source at the same instant are both real", async () => {
  // A split "Part 1 / Part 2" run is a real pair; dedup is cross-source only.
  await db.exec(
    act({ user: EA, source: "strava", ext: "s2", at: "2026-09-01T07:00:30Z",
          elapsed: 3600, moving: 3500, dist: 10000 }),
  );
  const r = await db.query(
    `select count(*)::int as n from v_live_activities
      where user_id = '${EA}' and source = 'strava'`,
  );
  assertEq(r.rows[0].n, 2, "same source is never deduped against itself");
});

await check("a different sport at the same instant is never matched", async () => {
  await db.exec(
    act({ user: EB, source: "strava", ext: "b1", sport: "Run",
          at: "2026-09-02T07:00:00Z", elapsed: 3600, moving: 3600 }),
  );
  await db.exec(
    act({ user: EB, source: "intervals_icu", ext: "b2", sport: "WeightTraining",
          at: "2026-09-02T07:00:10Z", elapsed: 3600, moving: 3600 }),
  );
  const r = await db.query(
    `select count(*)::int as n from v_live_activities where user_id = '${EB}'`,
  );
  assertEq(r.rows[0].n, 2, "both kept");
});

await check("replaying a sync writes nothing", async () => {
  let rejected = false;
  try {
    await db.exec(
      act({ user: EA, source: "strava", ext: "s1", at: "2026-09-01T07:00:00Z",
            elapsed: 3600, moving: 3500 }),
    );
  } catch {
    rejected = true;
  }
  assert(rejected, "unique (user_id, source, external_id)");
});

await check("null ascent means unknown, and never reads as flat", async () => {
  const r = await db.query(
    `select ascent_m from activities where user_id = '${EA}' and external_id = 'i2'`,
  );
  assertEq(r.rows[0].ascent_m, null, "a treadmill has no vert, not zero vert");
});

await check("owner reads their own activities and nobody else's", async () => {
  const mine = await asUser(EA, `select count(*)::int as n from activities`);
  const theirs = await asUser(EB, `select count(*)::int as n from activities`);
  assertEq(mine.rows[0].n, 4, "EA sees their four");
  assertEq(theirs.rows[0].n, 2, "EB sees their two");
});

await check("a user cannot forge a row claiming to come from a sync", async () => {
  let rejected = false;
  try {
    await asUser(
      EA,
      `insert into activities (user_id, source, external_id, sport, started_at, elapsed_s)
       values ('${EA}', 'strava', 'forged', 'Run', now(), 60)`,
    );
  } catch {
    rejected = true;
  }
  assert(rejected, "insert policy allows manual and fit_upload only");
  const ok = await asUser(
    EA,
    `insert into activities (user_id, source, external_id, sport, started_at, elapsed_s)
     values ('${EA}', 'manual', 'm1', 'Hike', timestamptz '2026-09-03T08:00:00Z', 3600)`,
  );
  assertEq(ok.affectedRows ?? 0, 1, "but may log one by hand");
});

await check("measurements are the sync's; annotations are the owner's", async () => {
  let rejected = false;
  try {
    await asUser(
      EA,
      `update activities set distance_m = 99999 where external_id = 'm1'`,
    );
  } catch {
    rejected = true;
  }
  assert(rejected, "a measurement is not editable, even on your own row");
  const ann = await asUser(
    EA,
    `update activities set perceived_rpe = 7, rpe_recorded_at = now(),
                           name = 'felt easy' where external_id = 'm1'`,
  );
  assertEq(ann.affectedRows ?? 0, 1, "rpe, its timestamp and the name are");
});

await check("a discarded activity leaves every view but stays in Postgres", async () => {
  await asUser(EA, `update activities set discarded_at = now() where external_id = 'm1'`);
  const live = await db.query(
    `select count(*)::int as n from v_live_activities where external_id = 'm1'`,
  );
  const raw = await db.query(
    `select count(*)::int as n from activities where external_id = 'm1'`,
  );
  assertEq([live.rows[0].n, raw.rows[0].n], [0, 1], "hidden, not gone");
});

await check("nobody deletes an activity", async () => {
  const del = await asUser(EA, `delete from activities where external_id = 'm1'`);
  assertEq(del.affectedRows ?? 0, 0, "no delete policy");
});

await check("sync credentials are unreadable by any client", async () => {
  await db.exec(`
    insert into integration_credentials (user_id, provider, secret)
    values ('${EA}', 'intervals_icu', '{"api_key":"secret"}'::jsonb);
  `);
  const rls = await db.query(
    `select relrowsecurity from pg_class where relname = 'integration_credentials'`,
  );
  assertEq(rls.rows[0].relrowsecurity, true, "row security enabled");
  const pol = await db.query(
    `select count(*)::int as n from pg_policies where tablename = 'integration_credentials'`,
  );
  assertEq(pol.rows[0].n, 0, "no policies at all -- service role only");
  const seen = await asUser(EA, `select count(*)::int as n from integration_credentials`);
  assertEq(seen.rows[0].n, 0, "not even your own token");
});

await check("deleting a user takes their activities and credentials", async () => {
  await db.exec(`delete from auth.users where id = '${EA}'`);
  const a = await db.query(`select count(*)::int as n from activities where user_id = '${EA}'`);
  const c = await db.query(
    `select count(*)::int as n from integration_credentials where user_id = '${EA}'`,
  );
  assertEq([a.rows[0].n, c.rows[0].n], [0, 0], "cascaded");
});

// --- E1 subjective capture (20260907040000) ----------------------------------
console.log("\nsubjective capture (partial is normal):");
await db.exec("reset role;");

const SA = "00000000-0000-4000-8000-0000000000f1";
const SB = "00000000-0000-4000-8000-0000000000f2";
await db.exec(`
  insert into auth.users (id, email) values
    ('${SA}', 'sa@example.test'), ('${SB}', 'sb@example.test')
  on conflict do nothing;
`);
const uuid = (n) => `00000000-1111-4000-8000-${String(n).padStart(12, "0")}`;

// THE REQUIREMENT: leave part of it blank and everything still works.
await check("a panel with one item answered is a real row", async () => {
  const r = await asUser(
    SA,
    `insert into daily_readiness (id, user_id, local_date, sleep_hours)
     values ('${uuid(1)}', '${SA}', date '2026-09-01', 7.5)`,
  );
  assertEq(r.affectedRows ?? 0, 1, "no item is required");
});

await check("a panel with NOTHING answered is also legal, and visibly empty", async () => {
  await asUser(
    SA,
    `insert into daily_readiness (id, user_id, local_date)
     values ('${uuid(2)}', '${SA}', date '2026-09-02')`,
  );
  const r = await db.query(
    `select answered_items from v_readiness_trend
      where user_id = '${SA}' and local_date = date '2026-09-02'`,
  );
  // Opening the sheet and skipping it is not the same as never opening it, and
  // only one of those is a gap in the series.
  assertEq(r.rows[0].answered_items, 0, "an empty answer is an answer");
});

await check("a rolling mean carries the count of real answers behind it", async () => {
  await asUser(
    SA,
    `insert into daily_readiness (id, user_id, local_date, sleep_hours, fatigue)
     values ('${uuid(3)}', '${SA}', date '2026-09-03', 6.5, 3)`,
  );
  const r = await db.query(
    `select sleep_hours_7d::float as sleep, sleep_hours_7d_n::int as sleep_n,
            fatigue_7d::float as fat, fatigue_7d_n::int as fat_n,
            days_of_history
       from v_readiness_trend
      where user_id = '${SA}' and local_date = date '2026-09-03'`,
  );
  assertEq(r.rows[0].sleep_n, 2, "two sleep answers across three days");
  assertEq(r.rows[0].sleep, 7, "(7.5 + 6.5) / 2, not / 3");
  // The distinction the counts exist for: one item answered once, another
  // twice, over the same three rows.
  assertEq(r.rows[0].fat_n, 1, "one fatigue answer");
  assertEq(r.rows[0].days_of_history, 3, "three rows, which is a different number");
});

await check("one panel per local date", async () => {
  let rejected = false;
  try {
    await asUser(
      SA,
      `insert into daily_readiness (id, user_id, local_date, mood)
       values ('${uuid(4)}', '${SA}', date '2026-09-01', 4)`,
    );
  } catch {
    rejected = true;
  }
  assert(rejected, "unique (user_id, local_date)");
});

await check("the panel is correctable within the day, unlike a set", async () => {
  const upd = await asUser(
    SA,
    `update daily_readiness set mood = 4 where id = '${uuid(1)}'`,
  );
  assertEq(upd.affectedRows ?? 0, 1, "a self-report may be corrected");
});

await check("custom fields are the athlete's, and never gate anything", async () => {
  await asUser(
    SA,
    `insert into readiness_fields (id, user_id, key, label, kind)
     values ('${uuid(5)}', '${SA}', 'knee_niggle', 'Left knee', 'scale_1_5')`,
  );
  await asUser(
    SA,
    `update daily_readiness set custom = '{"knee_niggle": 2}'::jsonb
      where id = '${uuid(1)}'`,
  );
  const r = await db.query(
    `select custom->>'knee_niggle' as v from v_readiness_trend
      where user_id = '${SA}' and local_date = date '2026-09-01'`,
  );
  assertEq(r.rows[0].v, "2", "recorded and readable");
  let rejected = false;
  try {
    await asUser(
      SA,
      `insert into readiness_fields (id, user_id, key, label, kind)
       values ('${uuid(6)}', '${SA}', 'Bad Key!', 'x', 'number')`,
    );
  } catch {
    rejected = true;
  }
  assert(rejected, "a key must survive being a JSON key and a chart label");
});

await check("checkins are unlimited per day and never touch the daily trend", async () => {
  for (let i = 0; i < 3; i++) {
    await asUser(
      SA,
      `insert into checkins (id, user_id, kind, energy, note)
       values ('${uuid(10 + i)}', '${SA}', 'spontaneous', ${i + 1}, 'tap ${i}')`,
    );
  }
  const c = await asUser(SA, `select count(*)::int as n from checkins`);
  assertEq(c.rows[0].n, 3, "three taps");
  const d = await db.query(
    `select days_of_history from v_readiness_trend
      where user_id = '${SA}' and local_date = date '2026-09-03'`,
  );
  // If these fed the baseline it would depend on how often somebody happened
  // to tap, which is not a fact about their training.
  assertEq(d.rows[0].days_of_history, 3, "still three days, not six");
});

// --- OSTRC ------------------------------------------------------------------
await check("OSTRC v2 scores 0-8-17-25 on all four and tops out at 100", async () => {
  await asUser(
    SA,
    `insert into symptom_episodes (id, user_id, body_region, side, opened_on)
     values ('${uuid(20)}', '${SA}', 'achilles', 'left', date '2026-08-10')`,
  );
  await asUser(
    SA,
    `insert into symptom_reports (id, user_id, episode_id, instrument, recall_end, q1,q2,q3,q4)
     values ('${uuid(21)}', '${SA}', '${uuid(20)}', 'ostrc_o2', date '2026-08-16', 3,3,3,3)`,
  );
  const r = await db.query(
    `select severity, is_health_problem, is_substantial from v_ostrc_severity
      where id = '${uuid(21)}'`,
  );
  assertEq(r.rows[0].severity, 100, "the worst answer to all four is 100");
  assertEq([r.rows[0].is_health_problem, r.rows[0].is_substantial], [true, true], "and substantial");
});

await check("a v2 row cannot carry an option its own instrument lacks", async () => {
  let rejected = false;
  try {
    await asUser(
      SA,
      `insert into symptom_reports (id, user_id, episode_id, instrument, recall_end, q1,q2,q3,q4)
       values ('${uuid(22)}', '${SA}', '${uuid(20)}', 'ostrc_o2', date '2026-08-23', 0,4,0,0)`,
    );
  } catch {
    rejected = true;
  }
  assert(rejected, "v2 collapsed Q2/Q3 to four options; 4 is a v1 answer");
});

await check("v1 keeps its own five-option scale for Q2 and Q3", async () => {
  await asUser(
    SB,
    `insert into symptom_episodes (id, user_id, body_region, opened_on)
     values ('${uuid(30)}', '${SB}', 'shin', date '2026-08-01')`,
  );
  await asUser(
    SB,
    `insert into symptom_reports (id, user_id, episode_id, instrument, recall_end, q1,q2,q3,q4)
     values ('${uuid(31)}', '${SB}', '${uuid(30)}', 'ostrc_o1', date '2026-08-09', 0,4,4,0)`,
  );
  const r = await db.query(`select severity from v_ostrc_severity where id = '${uuid(31)}'`);
  // Scoring is per version, which is why `instrument` is a column and why
  // severity is derived rather than stored.
  assertEq(r.rows[0].severity, 50, "0 + 25 + 25 + 0 on the v1 scale");
});

await check("substantial is the published case definition, not a severity cutoff", async () => {
  await asUser(
    SB,
    `insert into symptom_reports (id, user_id, episode_id, instrument, recall_end, q1,q2,q3,q4)
     values ('${uuid(32)}', '${SB}', '${uuid(30)}', 'ostrc_o2', date '2026-08-16', 1,2,0,1)`,
  );
  const r = await db.query(
    `select severity, is_substantial from v_ostrc_severity where id = '${uuid(32)}'`,
  );
  assert(r.rows[0].severity < 50, "a middling score");
  assertEq(r.rows[0].is_substantial, true, "but Q2 >= moderate makes it substantial");
});

await check("persistence is counted in consecutive weeks, which is the signal", async () => {
  for (const [n, d] of [[40, "2026-08-23"], [41, "2026-08-30"], [42, "2026-09-06"]]) {
    await asUser(
      SA,
      `insert into symptom_reports (id, user_id, episode_id, instrument, recall_end, q1,q2,q3,q4)
       values ('${uuid(n)}', '${SA}', '${uuid(20)}', 'ostrc_o2', date '${d}', 1,1,1,1)`,
    );
  }
  const r = await db.query(
    `select consecutive_weeks, persistent, is_open from v_symptom_episode_state
      where episode_id = '${uuid(20)}'`,
  );
  assertEq(r.rows[0].consecutive_weeks, 4, "16 Aug through 6 Sep, unbroken");
  assertEq(r.rows[0].persistent, true, "three weeks in one region warrants a clinician");
  assertEq(r.rows[0].is_open, true, "and it is still open");
});

await check("a missed week breaks the run rather than being counted through", async () => {
  await asUser(
    SB,
    `insert into symptom_reports (id, user_id, episode_id, instrument, recall_end, q1,q2,q3,q4)
     values ('${uuid(33)}', '${SB}', '${uuid(30)}', 'ostrc_o2', date '2026-08-30', 1,1,1,1)`,
  );
  const r = await db.query(
    `select consecutive_weeks, persistent from v_symptom_episode_state
      where episode_id = '${uuid(30)}'`,
  );
  // 9 Aug, 16 Aug, then a gap, then 30 Aug: the current run is one week.
  assertEq(r.rows[0].consecutive_weeks, 1, "the gap ends the run");
  assertEq(r.rows[0].persistent, false, "and persistence is not claimed");
});

// --- pain and red flags -----------------------------------------------------
await check("the next-morning pain check is its own row with its own timestamp", async () => {
  await asUser(
    SA,
    `insert into pain_checks (id, user_id, episode_id, phase, nrs_0_10, captured_at)
     values ('${uuid(50)}', '${SA}', '${uuid(20)}', 'post', 3, timestamptz '2026-09-06T09:00:00Z'),
            ('${uuid(51)}', '${SA}', '${uuid(20)}', 'next_morning', 5, timestamptz '2026-09-07T07:00:00Z')`,
  );
  const r = await db.query(
    `select phase, nrs_0_10 from pain_checks where episode_id = '${uuid(20)}' order by captured_at`,
  );
  // A 24-hour delayed signal cannot be a column on the run.
  assertEq(r.rows.map((x) => x.phase), ["post", "next_morning"], "two rows, a day apart");
  assertEq(r.rows[1].nrs_0_10, 5, "worse the next morning, which is the criterion");
});

await check("a red flag row must actually flag something", async () => {
  let rejected = false;
  try {
    await asUser(
      SA,
      `insert into red_flags (id, user_id, episode_id) values ('${uuid(60)}', '${SA}', '${uuid(20)}')`,
    );
  } catch {
    rejected = true;
  }
  assert(rejected, "an all-false row would read as a cleared flag");
  const ok = await asUser(
    SA,
    `insert into red_flags (id, user_id, episode_id, focal_bone_tenderness)
     values ('${uuid(61)}', '${SA}', '${uuid(20)}', true)`,
  );
  assertEq(ok.affectedRows ?? 0, 1, "any single one is a report");
});

// --- adherence denominator --------------------------------------------------
await check("prompts give a computable adherence rate", async () => {
  await asUser(
    SA,
    `insert into report_prompts (id, user_id, kind, scheduled_for, channel, responded_at)
     values ('${uuid(70)}', '${SA}', 'daily_readiness', now() - interval '2 days', 'push', now() - interval '2 days'),
            ('${uuid(71)}', '${SA}', 'daily_readiness', now() - interval '1 day', 'push', null)`,
  );
  const r = await db.query(
    `select count(*)::int as sent, count(responded_at)::int as answered
       from report_prompts where user_id = '${SA}'`,
  );
  // Without the denominator there is no way to tell 91% adherence from a
  // drop-off, and adherence is the load-bearing assumption of the injury half.
  assertEq([r.rows[0].sent, r.rows[0].answered], [2, 1], "one of two answered");
});

// --- cycle: opt-in, screening only ------------------------------------------
await check("nobody who has not opted in appears in the cycle screen at all", async () => {
  const r = await db.query(`select count(*)::int as n from v_cycle_screen`);
  assertEq(r.rows[0].n, 0, "no rows, no inference");
});

await check("a long absence refers, and only for someone it would be unexpected for", async () => {
  await asUser(SB, `insert into cycle_context (user_id, status) values ('${SB}', 'natural')`);
  await asUser(
    SB,
    `insert into cycle_events (id, user_id, kind, local_date)
     values ('${uuid(80)}', '${SB}', 'period_start', current_date - 200)`,
  );
  const r = await db.query(
    `select refer_for_amenorrhoea, days_since_period from v_cycle_screen where user_id = '${SB}'`,
  );
  assertEq(r.rows[0].refer_for_amenorrhoea, true, "200 days is a referral, not a diagnosis");
});

await check("contraception is never flagged for an absent period", async () => {
  await asUser(
    SB,
    `update cycle_context set status = 'hormonal_contraception' where user_id = '${SB}'`,
  );
  const r = await db.query(
    `select refer_for_amenorrhoea from v_cycle_screen where user_id = '${SB}'`,
  );
  // Clinically opposite to the case above, and identical without the status.
  assertEq(r.rows[0].refer_for_amenorrhoea, false, "no bleed by design is not a signal");
});

await check("a naturally long cycle is not flagged for being long", async () => {
  await db.exec(
    `update cycle_context set status = 'natural', typical_length_days = 60 where user_id = '${SB}'`,
  );
  await db.exec(
    `update cycle_events set local_date = current_date - 100 where id = '${uuid(80)}'`,
  );
  const r = await db.query(
    `select refer_for_amenorrhoea from v_cycle_screen where user_id = '${SB}'`,
  );
  assertEq(r.rows[0].refer_for_amenorrhoea, false, "100 days against a 60-day norm is not 2x");
});

await check("cycle data is deletable, unlike the training record", async () => {
  const ev = await asUser(SB, `delete from cycle_events where id = '${uuid(80)}'`);
  const ctx = await asUser(SB, `delete from cycle_context where user_id = '${SB}'`);
  assertEq([ev.affectedRows ?? 0, ctx.affectedRows ?? 0], [1, 1], "health data can be withdrawn");
});

await check("nobody reads anyone else's subjective data", async () => {
  const a = await asUser(SB, `select count(*)::int as n from daily_readiness`);
  const b = await asUser(SB, `select count(*)::int as n from symptom_reports where user_id = '${SA}'`);
  const c = await asUser(SB, `select count(*)::int as n from pain_checks`);
  assertEq([a.rows[0].n, b.rows[0].n, c.rows[0].n], [0, 0, 0], "scoped to the owner");
});

await check("deleting a user takes every subjective row with them", async () => {
  await db.exec(`delete from auth.users where id = '${SA}'`);
  const n = await db.query(`
    select (select count(*) from daily_readiness where user_id = '${SA}')
         + (select count(*) from checkins where user_id = '${SA}')
         + (select count(*) from symptom_reports where user_id = '${SA}')
         + (select count(*) from symptom_episodes where user_id = '${SA}')
         + (select count(*) from pain_checks where user_id = '${SA}')
         + (select count(*) from red_flags where user_id = '${SA}')
         + (select count(*) from report_prompts where user_id = '${SA}')
         + (select count(*) from readiness_fields where user_id = '${SA}') as n`);
  assertEq(Number(n.rows[0].n), 0, "cascaded");
});

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

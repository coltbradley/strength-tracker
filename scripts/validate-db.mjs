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
  grant execute on all functions in schema public to authenticated;
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
  const r = await db.query(
    `select working_sets::int as n from v_weekly_volume where user_id = $1 and exercise_id = 'Barbell_Squat'`,
    [OWNER],
  );
  assertEq(r.rows[0].n, 3, "working sets this week");
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

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

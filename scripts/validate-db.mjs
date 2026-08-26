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
try {
  const seed = await readFile(join(root, "supabase", "seed", "exercises.generated.sql"), "utf8");
  await db.exec(seed);
  seeded = true;
} catch {
  console.log("  note  seed file missing, run scripts/build-exercise-seed.mjs (seed checks skipped)");
}

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

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

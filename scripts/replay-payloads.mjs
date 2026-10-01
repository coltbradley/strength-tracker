#!/usr/bin/env node
// Replays the writes a live browser run captured (pwa/e2e/live-load-sync.mjs)
// into the REAL schema: PGlite (Postgres-in-WASM) with the full, unmodified
// migration chain, one authenticated owner, and every set inserted the way
// PostgREST would insert it (json_populate_recordset, ON CONFLICT DO NOTHING,
// RLS applied as the `authenticated` role). A DB rejection is reported with
// the payload and the UI step that produced it.
//
//   npm --prefix scripts ci                                 # once
//   node scripts/replay-payloads.mjs live-payloads.json [--out replay.json]
//
// It also audits each payload against the AGENTS.md load invariants
// independently of the database (so a rule the DB does not enforce is still
// caught): load_kg is the TOTAL; per_side is doubled; entered_load/entered_unit
// travel as a pair and reproduce load_kg; what the screen showed / the lifter
// typed is what was written; a correction reuses set_index, performed_at,
// rest and prescription.
//
// Exit code 1 on any rejection or invariant violation.

import { readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const argv = process.argv.slice(2);
// --repo DIR: take supabase/migrations + seeds from another checkout, so a
// run against a branch with new migrations replays against ITS schema.
const repoIdx = argv.indexOf("--repo");
const root = repoIdx >= 0 ? argv[repoIdx + 1] : join(dirname(fileURLToPath(import.meta.url)), "..");
const inFile = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--out" && argv[i - 1] !== "--repo");
const outIdx = argv.indexOf("--out");
const outFile = outIdx >= 0 ? argv[outIdx + 1] : null;
if (!inFile) {
  console.error("usage: replay-payloads.mjs live-payloads.json [--out replay.json]");
  process.exit(2);
}
const input = JSON.parse(await readFile(inFile, "utf8"));
const ops = Array.isArray(input) ? input : input.ops;
const plan = Array.isArray(input) ? [] : (input.plan ?? []);

const KG_PER_LB = 0.45359237;
const OWNER = "00000000-0000-4000-8000-000000000001";
const uuidish = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toUuid = (s) => {
  if (uuidish.test(s)) return s;
  const h = createHash("sha1").update(`replay:${s}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

// ---- boot the real schema ----------------------------------------------------
const db = new PGlite();
await db.exec(`
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;
  create role authenticated login;
  create role anon login;
  create role service_role nologin bypassrls;
  alter default privileges in schema public grant execute on functions to anon, authenticated;
`);
const migDir = join(root, "supabase", "migrations");
const migrations = (await readdir(migDir)).filter((f) => f.endsWith(".sql")).sort();
for (const m of migrations) await db.exec(await readFile(join(migDir, m), "utf8"));
await db.exec(`
  grant usage on schema public, auth to authenticated;
  grant select, insert, update, delete on all tables in schema public to authenticated;
  grant execute on all functions in schema auth to authenticated;
  grant usage on schema public, auth to service_role;
  grant select, insert, update, delete on all tables in schema public to service_role;
  grant execute on all functions in schema auth to service_role;
`);
await db.exec(await readFile(join(root, "supabase", "seed", "exercises.curated.sql"), "utf8"));
console.log(`schema: ${migrations.length} migrations applied`);

// ---- fixtures (what the plan editor / MCP would have written) ----------------
const exerciseIds = new Set();
for (const o of ops) {
  const p = o.op?.payload;
  if (p?.exercise_id) exerciseIds.add(p.exercise_id);
}
for (const rx of plan) exerciseIds.add(rx.exercise_id);
for (const id of exerciseIds) {
  await db.query(
    `insert into exercises (id, name, primary_muscles) values ($1, $2, array['other']) on conflict (id) do nothing`,
    [id, id.replace(/_/g, " ")],
  );
}
const PROGRAM = toUuid("replay-program");
const WORKOUT = toUuid("replay-workout");
await db.exec(`insert into auth.users (id, email) values ('${OWNER}', 'owner@example.test')`);
await db.exec(`insert into training_maxes (user_id, exercise_id, value_kg, effective_date)
  values ('${OWNER}', 'Barbell_Deadlift', 180, current_date - 30) on conflict do nothing`);
await db.exec(`insert into programs (id, user_id, name, confirmed_at) values ('${PROGRAM}', '${OWNER}', 'Replay block', now())`);
await db.exec(`insert into planned_workouts (id, user_id, program_id, day_index, label, scheduled_date)
  values ('${WORKOUT}', '${OWNER}', '${PROGRAM}', 0, 'Live day', current_date)`);
const fixtureErrors = [];
const rxIds = new Map();
for (let i = 0; i < plan.length; i++) {
  const rx = plan[i];
  const id = toUuid(`live-rx-${i}`);
  rxIds.set(`live-rx-${i}`, id);
  try {
    await db.query(
      `insert into prescriptions (id, user_id, planned_workout_id, exercise_id, position, sets, reps_min, reps_max,
         load_kg, load_pct_tm, rest_seconds, superset_group, load_entry, entered_load, entered_unit, set_type, tracking)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [id, OWNER, WORKOUT, rx.exercise_id, i, rx.sets, rx.reps_min, rx.reps_max, rx.load_kg, rx.load_pct_tm,
       rx.rest_seconds, rx.superset_group, rx.load_entry, rx.entered_load, rx.entered_unit, rx.set_type ?? "working", rx.tracking ?? "reps"],
    );
  } catch (e) {
    fixtureErrors.push({ prescription: i, exercise: rx.exercise_id, error: e.message });
  }
}

// ---- column lists (PostgREST answers PGRST204 for an unknown column) ---------
const cols = {};
async function colsFor(table) {
  if (!cols[table]) {
    const r = await db.query(`select column_name from information_schema.columns where table_schema='public' and table_name=$1`, [table]);
    cols[table] = new Set(r.rows.map((x) => x.column_name));
  }
  return cols[table];
}

// ---- replay ------------------------------------------------------------------
const asOwner = async (fn) => {
  await db.exec(`set role authenticated; select set_config('app.user_id', '${OWNER}', false);`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role; select set_config('app.user_id', '', false);`);
  }
};

const mapPayload = (table, p) => {
  const q = { ...p };
  if (q.planned_workout_id != null) q.planned_workout_id = WORKOUT;
  if (q.prescription_id != null) q.prescription_id = rxIds.get(q.prescription_id) ?? toUuid(q.prescription_id);
  for (const k of ["id", "session_id", "set_id"]) if (typeof q[k] === "string") q[k] = toUuid(q[k]);
  return q;
};

const results = [];
const rejected = [];
let accepted = 0;
const acceptedSets = [];
for (const rec of ops) {
  const { op } = rec;
  const base = { run: rec.run, step: rec.step, kind: op.kind, table: op.table };
  try {
    if (op.kind === "insert") {
      const payload = mapPayload(op.table, op.payload);
      const keys = Object.keys(payload);
      const known = await colsFor(op.table);
      const unknown = keys.filter((k) => !known.has(k));
      if (known.size === 0) throw Object.assign(new Error(`relation "${op.table}" does not exist`), { code: "42P01" });
      if (unknown.length) {
        const err = { code: "PGRST204", message: `Could not find the '${unknown[0]}' column of '${op.table}' in the schema cache` };
        throw Object.assign(new Error(err.message), { code: err.code });
      }
      const list = keys.map((k) => `"${k}"`).join(", ");
      // The outbox's conflict policy per table: set_notes and exercise_prefs
      // MERGE (last write wins); everything else is on conflict do nothing.
      const conflict =
        op.table === "set_notes"
          ? `on conflict (set_id) do update set note = excluded.note`
          : op.table === "exercise_prefs"
            ? `on conflict (user_id, exercise_id) do update set ${keys.filter((k) => !["user_id", "exercise_id"].includes(k)).map((k) => `"${k}" = excluded."${k}"`).join(", ")}`
            : `on conflict do nothing`;
      await asOwner(() =>
        db.query(
          `insert into public.${op.table} (${list}) select ${list} from json_populate_recordset(null::public.${op.table}, $1::json) ${conflict}`,
          [JSON.stringify([payload])],
        ),
      );
      if (op.table === "sets") acceptedSets.push({ rec, row: payload });
    } else if (op.kind === "update") {
      const patch = op.patch;
      const keys = Object.keys(patch);
      const sets = keys.map((k, i) => `"${k}" = $${i + 2}`).join(", ");
      await asOwner(() => db.query(`update public.${op.table} set ${sets} where id = $1`, [toUuid(op.id), ...keys.map((k) => patch[k])]));
    }
    accepted++;
    results.push({ ...base, ok: true });
  } catch (e) {
    const r = { ...base, ok: false, code: e.code ?? null, message: e.message, payload: op.payload ?? op.patch };
    results.push(r);
    rejected.push(r);
  }
}

// ---- read back: what the database now says -----------------------------------
const readback = [];
for (const { rec, row } of acceptedSets) {
  const r = await db.query(`select load_kg::float as load_kg, entered_load::float as entered_load, entered_unit::text as entered_unit, load_entry::text as load_entry from sets where id = $1`, [row.id]);
  const got = r.rows[0];
  if (!got) continue;
  const sent = rec.op.payload;
  if (got.load_kg !== sent.load_kg || (sent.entered_load != null && got.entered_load !== sent.entered_load))
    readback.push({ run: rec.run, step: rec.step, sent: { load_kg: sent.load_kg, entered_load: sent.entered_load }, got });
}

// Exact decimal expectation, the way the production trigger computes it:
// round(entered * (0.45359237 | 1) * (2 | 1), 2) in NUMERIC, half away from
// zero. A binary-float Math.round(x * 100) / 100 disagrees on exact ties
// (1.005 kg -> 1 vs 1.01), which is how the client and the trigger part ways.
function exactTotalKg(entered, unit, mult) {
  const str = String(entered);
  const [i, f = ""] = str.split(".");
  const frac = (f + "000").slice(0, 3);
  const t = BigInt(i + frac); // entered * 1000
  const factor = unit === "lb" ? 45359237n : 100000000n; // * 1e8
  const v = t * factor * BigInt(mult); // scaled 1e11
  const q = v / 1000000000n;
  const r = v % 1000000000n;
  return Number(q + (r * 2n >= 1000000000n ? 1n : 0n)) / 100;
}

// ---- AGENTS.md invariants, independent of the DB ------------------------------
const violations = [];
const v = (rec, rule, detail) => violations.push({ run: rec.run, step: rec.step, rule, detail, payload: rec.op.payload });
const setRecs = ops.filter((o) => o.op.kind === "insert" && o.op.table === "sets");
for (const rec of setRecs) {
  const s = rec.op.payload;
  const hasEL = s.entered_load != null;
  const hasEU = s.entered_unit != null;
  if (hasEL !== hasEU) v(rec, "entered pair", "entered_load and entered_unit must both be set or both null");
  if (!(s.load_kg >= 0)) v(rec, "load_kg", `load_kg ${s.load_kg} is not a non-negative total`);
  if (s.load_kg > 9999.99) v(rec, "load_kg range", `load_kg ${s.load_kg} does not fit numeric(6,2)`);
  if (s.load_entry === "per_side" && !(s.load_kg > 0)) v(rec, "per_side", "per_side on a 0 kg set");
  if (hasEL && hasEU) {
    if (s.load_entry == null) v(rec, "load_entry", "authored load without load_entry");
    const mult = s.load_entry === "per_side" ? 2 : 1;
    const want = exactTotalKg(s.entered_load, s.entered_unit, mult);
    if (Math.abs(want - s.load_kg) > 1e-9)
      v(rec, "load_kg total", `entered ${s.entered_load} ${s.entered_unit}${mult === 2 ? " per side" : ""} implies ${want} kg total but load_kg is ${s.load_kg}`);
  } else if (s.load_kg > 0 && !hasEL) {
    v(rec, "provenance", "load > 0 but no entered_load/entered_unit (unknown provenance; legacy-only shape)");
  }
  const e = rec.expect;
  if (e) {
    if (e.typed && (s.entered_load !== e.typed.value || s.entered_unit !== e.typed.unit))
      v(rec, "typed value", `typed ${e.typed.value} ${e.typed.unit}; wrote ${s.entered_load} ${s.entered_unit}`);
    if (e.shownValue != null && s.load_kg > 0) {
      const f = e.displayUnit === "lb" ? KG_PER_LB : 1;
      const mult = e.perHand ? 2 : 1;
      const want = e.shownValue * f * mult;
      const tol = 0.06 * f * mult + 0.011;
      if (Math.abs(want - s.load_kg) > tol)
        v(rec, "screen vs write", `screen showed ${e.shownValue} ${e.displayUnit}${e.perHand ? " per hand" : ""} (${want.toFixed(2)} kg); wrote ${s.load_kg} kg`);
    }
  }
}
// corrections: a void plus a new row at the SAME set_index with the same
// performed_at, rest and prescription; only load, reps, type and rpe change
const voids = ops.filter((o) => o.op.kind === "insert" && o.op.table === "set_voids");
for (const vd of voids) {
  const orig = setRecs.find((s) => s.op.payload.id === vd.op.payload.set_id && s.run === vd.run);
  const repl = setRecs.filter((s) => s.run === vd.run && s !== orig && orig && s.op.payload.exercise_id === orig.op.payload.exercise_id && s.op.payload.set_index === orig.op.payload.set_index && s.t >= vd.t - 5000);
  if (!orig) continue; // original synced in an earlier session; cannot compare
  const o = orig.op.payload;
  if (repl.length === 0) {
    v(vd, "correction", `void of set_index ${o.set_index} has no replacement row at the same index`);
    continue;
  }
  const n = repl[repl.length - 1].op.payload;
  for (const k of ["performed_at", "rest_seconds_actual", "prescription_id", "session_id"])
    if (o[k] !== n[k]) v(repl[repl.length - 1], "correction", `${k} changed from ${o[k]} to ${n[k]}`);
}

const summary = {
  input: inFile,
  opsReplayed: ops.length,
  accepted,
  rejected: rejected.length,
  sets: setRecs.length,
  invariantViolations: violations.length,
  readbackDiffs: readback.length,
  fixtureErrors,
};
const result = { summary, rejected, violations, readback };
if (outFile) await writeFile(outFile, JSON.stringify(result, null, 1));

console.log(`replay: ${accepted}/${ops.length} ops accepted, ${rejected.length} rejected, ${violations.length} invariant violations, ${readback.length} readback diffs`);
for (const r of rejected) console.log(`  REJECTED  [${r.run}] ${r.step} -> ${r.table}: ${r.message} (${r.code ?? "no code"})`);
for (const x of violations.slice(0, 40)) console.log(`  INVARIANT [${x.run}] ${x.step}: ${x.rule}: ${x.detail}`);
if (violations.length > 40) console.log(`  ... ${violations.length - 40} more`);
for (const f of fixtureErrors) console.log(`  FIXTURE   ${f.exercise}: ${f.error}`);
process.exit(rejected.length || violations.length || fixtureErrors.length ? 1 : 0);

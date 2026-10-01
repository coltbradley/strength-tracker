// Rehearse the repair of a phone's dead write queue against the REAL schema.
//
//   node scripts/rehearse-queue-repair.mjs <queue-export.json>
//
// The export is the file the Unsynced Writes sheet saves (see buildQueueExport
// in pwa/src/lib/export.ts). The data is never committed: this script takes
// the path as an argument and prints a report. CI runs it on the anonymized
// fixture scripts/fixtures/phone-queue-anonymized.json
// (scripts/rehearse-queue-repair.test.mjs).
//
// What it does, in order:
//   1. boots PGlite with the WHOLE supabase/migrations chain (the production
//      trigger, checks, RLS and views);
//   2. recreates the parents the export implies: the owner, the exercises
//      (from the seed when it has them, else custom rows, and says which), a
//      planned workout with the exported prescription ids, and the session
//      (ended, not discarded, same owner);
//   3. runs the SAME repair the app runs (repairAuthoredLoad from
//      pwa/src/lib/setLoad.ts, then the admission gate isAcceptedAuthoredLoad)
//      on every dead authored-load set;
//   4. replays in outbox order as that owner through the authenticated role,
//      honoring the void-hold: every set goes first, a void or note only after
//      its parent set was accepted (the order the app's Retry failed enforces);
//   5. asserts the outcome and then replays EVERYTHING a second time to prove
//      the replay is a no-op.
//
// Exit code 0 only when every assertion held.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootChain, root } from "./lib/pglite-chain.mjs";
import { repairAuthoredLoad, isAcceptedAuthoredLoad } from "../pwa/src/lib/setLoad.ts";

const LOAD_ERROR = "load_kg must match entered_load, entered_unit, and load_entry";
// The incident: totals that are exactly these pounds under the trigger formula.
const INCIDENT_LB = new Map([[65.77, 145], [34.02, 75], [45.36, 100], [52.16, 115]]);
const SET_COLUMNS = [
  "id", "session_id", "exercise_id", "prescription_id", "set_index", "set_type", "load_kg", "reps",
  "performed_at", "rest_seconds_actual", "load_entry", "entered_load", "entered_unit", "rpe",
  "duration_seconds",
];

const sqlLiteral = (v) => `'${String(v).replaceAll("'", "''")}'`;

export function readExport(text) {
  const bundle = JSON.parse(text);
  if (!bundle || !Array.isArray(bundle.items)) throw new Error("not a queue export: no items array");
  return bundle;
}

/** Everything the rehearsal asserts, as {name, ok, detail}. */
export async function rehearse(exportPath) {
  const lines = [];
  const out = (s = "") => lines.push(s);
  const checks = [];
  const check = (name, ok, detail = "") => {
    checks.push({ name, ok: Boolean(ok), detail });
    out(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
  };

  const bundle = readExport(await readFile(exportPath, "utf8"));
  const items = [...bundle.items].sort((a, b) => a.position - b.position);
  const sets = items.filter((i) => i.operation === "insert sets");
  const voids = items.filter((i) => i.operation === "insert set_voids");
  const notes = items.filter((i) => i.operation === "insert set_notes");

  out("QUEUE REPAIR REHEARSAL");
  out(`export app_version=${bundle.app_version} exported_at=${bundle.exported_at}`);
  out(`items=${items.length}: ${sets.length} insert sets, ${voids.length} insert set_voids, ${notes.length} insert set_notes`);
  out(`states: ${[...new Set(items.map((i) => `${i.state}/${i.cause}`))].join(", ")}`);
  out();

  const owners = new Set(items.map((i) => i.queued_by));
  const sessions = new Set(sets.map((s) => s.row.session_id));
  const owner = [...owners][0];
  if (owners.size !== 1 || typeof owner !== "string") throw new Error("export must have exactly one string owner");
  if (sessions.size !== 1) throw new Error("export must cover exactly one session");
  const sessionId = [...sessions][0];

  // ---- 1. real schema ------------------------------------------------------
  const { db, migrations } = await bootChain();
  try {
    out(`schema: PGlite + ${migrations.length} migrations (${migrations[0]} .. ${migrations.at(-1)})`);
    // the platform-equivalent grants Supabase gives `authenticated` (same as
    // validate-db.mjs); RLS and the triggers still decide every row.
    await db.exec(`
      grant usage on schema public, auth to authenticated;
      grant select, insert, update, delete on all tables in schema public to authenticated;
      grant execute on all functions in schema auth to authenticated;
    `);
    const asOwner = async (sql, params) => {
      await db.exec(`set role authenticated; select set_config('app.user_id', ${sqlLiteral(owner)}, false);`);
      try {
        return await db.query(sql, params);
      } finally {
        await db.exec(`reset role; select set_config('app.user_id', '', false);`);
      }
    };

    // ---- 2. parents --------------------------------------------------------
    for (const file of ["exercises.generated.sql", "exercises.curated.sql"]) {
      try {
        await db.exec(await readFile(join(root, "supabase", "seed", file), "utf8"));
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    const exerciseIds = [...new Set(sets.map((s) => s.row.exercise_id))];
    const have = new Set(
      (await db.query(`select id from exercises where id = any($1)`, [exerciseIds])).rows.map((r) => r.id),
    );
    const created = exerciseIds.filter((id) => !have.has(id));
    for (const id of created) {
      const name = sets.find((s) => s.row.exercise_id === id)?.exercise_name ?? id.replaceAll("_", " ");
      await db.query(`insert into exercises (id, name, primary_muscles, source) values ($1, $2, '{}', 'custom')`, [id, name]);
    }
    out(`exercises: ${have.size} of ${exerciseIds.length} in the seed${created.length ? `; created custom rows for ${created.join(", ")}` : ""}`);

    const ids = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const first = sets.map((s) => Date.parse(s.row.performed_at)).reduce((a, b) => Math.min(a, b));
    const last = sets.map((s) => Date.parse(s.row.performed_at)).reduce((a, b) => Math.max(a, b));
    await db.exec(`
      insert into auth.users (id, email) values (${sqlLiteral(owner)}, 'rehearsal-owner@example.test');
      insert into programs (id, user_id, name, confirmed_at) values (${sqlLiteral(ids(1))}, ${sqlLiteral(owner)}, 'Rehearsal', now());
      insert into planned_workouts (id, user_id, program_id, day_index, label)
        values (${sqlLiteral(ids(2))}, ${sqlLiteral(owner)}, ${sqlLiteral(ids(1))}, 0, 'Rehearsal day');
    `);
    const rxByExercise = new Map();
    for (const s of sets) if (s.row.prescription_id) rxByExercise.set(s.row.prescription_id, s.row.exercise_id);
    let pos = 0;
    for (const [rxId, exerciseId] of rxByExercise) {
      await db.query(
        `insert into prescriptions (id, user_id, planned_workout_id, exercise_id, position, sets, reps_min, reps_max, load_kg)
         values ($1, $2, $3, $4, $5, 3, 5, 12, 20)`,
        [rxId, owner, ids(2), exerciseId, pos++],
      );
    }
    await db.query(
      `insert into sessions (id, user_id, planned_workout_id, started_at, ended_at) values ($1, $2, $3, $4, $5)`,
      [sessionId, owner, ids(2), new Date(first - 10 * 60_000).toISOString(), new Date(last + 5 * 60_000).toISOString()],
    );
    out(`parents: owner, ${rxByExercise.size} prescriptions, 1 session (ended, not discarded)`);
    out();

    // ---- 3. the app's repair -------------------------------------------------
    out("REPAIR (repairAuthoredLoad + admission gate, the functions the app uses)");
    const repaired = new Map(); // position -> payload to send
    for (const s of sets) {
      const eligible =
        s.state === "dead" && s.last_error === LOAD_ERROR && s.row.entered_load != null && s.row.entered_unit != null;
      let payload = s.row;
      let note = "not an authored-load failure; sent as exported";
      if (eligible) {
        const r = repairAuthoredLoad(s.row);
        payload = r.row;
        note = r.restored
          ? `restored ${payload.entered_load} ${payload.entered_unit}${r.alternative ? ` (ALSO FITS ${r.alternative.entered_load} ${r.alternative.entered_unit})` : ""} (was saved as ${r.was.entered_load} ${r.was.entered_unit})`
          : "no typed weight reproduces the total: entered_load/entered_unit null";
        const verdict = isAcceptedAuthoredLoad(payload, "sets");
        if (!verdict.ok) note += ` -- GATE REFUSES: ${verdict.message}`;
      }
      repaired.set(s.position, payload);
      out(`  #${s.position} ${s.exercise_name ?? s.row.exercise_id} set_index ${s.row.set_index}: ${note}`);
    }
    out();

    // ---- 4. replay (PostgREST upsert semantics) -----------------------------
    const accepted = new Set(); // set ids the server has acknowledged
    const results = new Map(); // position -> "accepted" | error text
    async function send(item) {
      try {
        if (item.operation === "insert sets") {
          const p = repaired.get(item.position);
          const cols = SET_COLUMNS.filter((c) => p[c] !== undefined);
          const values = cols.map((c) => (p[c] === null ? null : String(p[c])));
          await asOwner(
            `insert into sets (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) on conflict (id) do nothing`,
            values,
          );
          accepted.add(p.id);
        } else if (item.operation === "insert set_voids") {
          await asOwner(`insert into set_voids (set_id) values ($1) on conflict (set_id) do nothing`, [item.row.set_id]);
        } else if (item.operation === "insert set_notes") {
          await asOwner(
            `insert into set_notes (set_id, note) values ($1, $2)
             on conflict (set_id) do update set note = excluded.note, updated_at = now()`,
            [item.row.set_id, item.row.note],
          );
        } else {
          throw new Error(`unsupported operation ${item.operation}`);
        }
        results.set(item.position, "accepted");
      } catch (e) {
        results.set(item.position, e.message);
      }
    }
    // A void or note is held while its parent set is not yet acknowledged.
    const dependents = items.filter((i) => i.operation !== "insert sets");
    async function replayAll() {
      for (const item of items.filter((i) => i.operation === "insert sets")) await send(item);
      for (const item of dependents) {
        if (!accepted.has(item.row.set_id)) {
          results.set(item.position, "held: parent set not acknowledged");
          continue;
        }
        await send(item);
      }
    }
    const snapshot = async () => {
      const q = async (sql) => (await db.query(sql)).rows;
      return JSON.stringify({
        sets: await q(`select * from sets order by id`),
        voids: await q(`select set_id, user_id from set_voids order by set_id`),
        notes: await q(`select set_id, note from set_notes order by set_id`),
      });
    };

    out("REPLAY as the owner, sets first, then voids/notes behind their parents");
    await replayAll();
    for (const item of items) out(`  #${item.position} ${item.operation}: ${results.get(item.position)}`);
    out();
    const afterFirst = await snapshot();

    // ---- 5. assertions -------------------------------------------------------
    out("ASSERTIONS");
    check("all items accepted", items.every((i) => results.get(i.position) === "accepted"),
      `${items.filter((i) => results.get(i.position) === "accepted").length}/${items.length}`);

    const voidedIds = new Set(voids.map((v) => v.row.set_id));
    const expectedLive = sets.filter((s) => !voidedIds.has(s.row.id));
    const live = (await asOwner(`select * from v_live_sets where session_id = $1 order by performed_at, set_index`, [sessionId])).rows;
    check("v_live_sets shows exactly the un-voided sets", live.length === expectedLive.length &&
      expectedLive.every((s) => live.some((l) => l.id === s.row.id)),
      `${live.length} live, ${expectedLive.length} expected (${sets.length} sets - ${voidedIds.size} voided)`);
    check("incident shape: 5 live sets", live.length === 5, `${live.length}`);

    const hidden = (await asOwner(`select id from v_live_sets where id = any($1)`, [[...voidedIds]])).rows;
    check("voided originals are hidden", hidden.length === 0 &&
      Number((await db.query(`select count(*)::int as n from sets where id = any($1)`, [[...voidedIds]])).rows[0].n) === voidedIds.size,
      `${voidedIds.size} voided, rows still stored (append-only), ${hidden.length} visible`);

    out();
    out("PER-SET (server readback by set UUID)");
    const bySetNote = new Map(notes.map((n) => [n.row.set_id, n.row.note]));
    const stored = (await db.query(`select s.*, n.note from sets s left join set_notes n on n.set_id = s.id order by s.performed_at, s.set_index, s.id`)).rows;
    let perSetOk = true;
    for (const s of sets) {
      const row = stored.find((r) => r.id === s.row.id);
      const isLive = live.some((l) => l.id === s.row.id);
      const wantLb = INCIDENT_LB.get(s.row.load_kg);
      const same = row &&
        Number(row.load_kg) === s.row.load_kg && row.reps === s.row.reps && row.set_index === s.row.set_index &&
        row.performed_at.toISOString() === new Date(s.row.performed_at).toISOString() &&
        (row.rpe == null ? null : Number(row.rpe)) === (s.row.rpe ?? null) && (row.rest_seconds_actual ?? null) === (s.row.rest_seconds_actual ?? null) &&
        row.exercise_id === s.row.exercise_id && (row.prescription_id ?? null) === (s.row.prescription_id ?? null) &&
        row.user_id === owner && row.session_id === s.row.session_id;
      const typedOk = row && row.entered_unit === "lb" && Number(row.entered_load) === wantLb;
      if (!same || !typedOk) {
        perSetOk = false;
        out(`    MISMATCH same=${Boolean(same)} typed=${Boolean(typedOk)} stored=${JSON.stringify(row)}`);
      }
      out(`  ${s.row.id}  ${isLive ? "LIVE  " : "voided"}  ${s.exercise_name ?? s.row.exercise_id} set_index ${s.row.set_index}` +
        ` rpe ${s.row.rpe ?? "-"}  load_kg ${row ? Number(row.load_kg) : "MISSING"}  entered ${row ? `${Number(row.entered_load)} ${row.entered_unit}` : "-"}` +
        `${bySetNote.has(s.row.id) ? `  note: ${row?.note === bySetNote.get(s.row.id) ? "present" : "MISSING"}` : ""}`);
    }
    out();
    check("every restored set: entered_unit lb, typed pounds 145/75/100/115, load_kg and all training fields unchanged", perSetOk);
    check("notes landed on their sets", notes.every((n) => stored.find((r) => r.id === n.row.set_id)?.note === n.row.note));

    // idempotent: a second full replay changes nothing
    await replayAll();
    const afterSecond = await snapshot();
    check("replaying everything a second time is a no-op",
      afterFirst === afterSecond && items.every((i) => results.get(i.position) === "accepted"));

    const failed = checks.filter((c) => !c.ok);
    out();
    out(failed.length === 0 ? `RESULT: PASS (${checks.length} assertions)` : `RESULT: FAIL (${failed.length} of ${checks.length} assertions failed)`);
    return { ok: failed.length === 0, report: lines.join("\n") + "\n", checks, live, stored };
  } finally {
    await db.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node scripts/rehearse-queue-repair.mjs <queue-export.json>");
    process.exit(2);
  }
  try {
    const { ok, report } = await rehearse(path);
    process.stdout.write(report);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`rehearsal could not run: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}

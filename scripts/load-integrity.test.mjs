// Property proof that no load built by buildSetLoad can be refused by the
// database, and that the TypeScript mirror of the database rule
// (isAcceptedAuthoredLoad) agrees with the REAL trigger and checks on every
// case, including the ones that must be refused.
//
//   npm --prefix scripts ci && node --test scripts/load-integrity.test.mjs
//   LOAD_PROPERTY_CASES=20000 node --test scripts/load-integrity.test.mjs
//
// The database is PGlite running the full supabase/migrations chain, so the
// validate_entered_load_consistency trigger and every table check are the
// production ones. setLoad.ts is imported as-is (node strips the types).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { bootChain, root } from "./lib/pglite-chain.mjs";
import {
  buildSetLoad,
  isAcceptedAuthoredLoad,
  provenanceForTotal,
  LoadIntegrityError,
} from "../pwa/src/lib/setLoad.ts";

const CASES = Number(process.env.LOAD_PROPERTY_CASES ?? 4000);
const SEED = Number(process.env.LOAD_PROPERTY_SEED ?? 20260930);

const OWNER = "00000000-0000-4000-8000-0000000000a1";
const SESSION = "00000000-0000-4000-8000-0000000000b1";
const WORKOUT = "00000000-0000-4000-8000-0000000000c1";
const EX = "Barbell_Squat";

let db;

before(async () => {
  ({ db } = await bootChain());
  await db.exec(`
    insert into auth.users (id, email) values ('${OWNER}', 'p@example.test');
    insert into exercises (id, name, primary_muscles) values ('${EX}', 'Squat', array['quadriceps']);
    insert into sessions (id, user_id, started_at) values ('${SESSION}', '${OWNER}', now());
    insert into programs (id, user_id, name, confirmed_at) values ('00000000-0000-4000-8000-0000000000d1', '${OWNER}', 'P', now());
    insert into planned_workouts (id, user_id, program_id, day_index, label)
      values ('${WORKOUT}', '${OWNER}', '00000000-0000-4000-8000-0000000000d1', 0, 'A');
  `);
});
after(async () => {
  await db?.close();
});

// mulberry32: deterministic, so a failure reproduces from the printed seed.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(SEED);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const dp = (x, p) => Math.round(x * 10 ** p) / 10 ** p;

const KG_PLATES = [0.25, 0.5, 1.25, 2.5, 5, 10, 15, 20, 25];
const LB_PLATES = [1.25, 2.5, 5, 10, 25, 35, 45];

/** Typed numbers a lifter really produces, plus odd ones. */
function typedCase() {
  const unit = pick(["kg", "lb"]);
  const loadEntry = pick(["total", "total", "per_side"]);
  const kind = int(0, 9);
  let value;
  if (kind <= 2) {
    // a stepper grid
    const step = unit === "kg" ? pick([0.25, 0.5, 1.25, 2.5, 5]) : pick([0.5, 1, 2.5, 5, 10]);
    value = dp(int(0, 400) * step, 3);
  } else if (kind <= 4) {
    // bar + a pair of plate stacks
    const plates = unit === "kg" ? KG_PLATES : LB_PLATES;
    const bar = unit === "kg" ? pick([0, 10, 15, 20]) : pick([0, 35, 45]);
    let w = bar;
    for (let i = int(0, 6); i > 0; i--) w += 2 * pick(plates);
    value = dp(w, 3);
  } else if (kind === 5) {
    // the other unit's value, read the way the screen reads it (1 decimal)
    const kg = dp(rand() * 300, 2);
    value = unit === "lb" ? dp(kg / 0.45359237, 1) : dp(kg, 1);
  } else if (kind === 6) {
    value = dp(rand() * 500, int(1, 3)); // odd 1-3 decimal values
  } else if (kind === 7) {
    value = rand() * 500; // raw float, many decimals
  } else if (kind === 8) {
    // exact rounding ties in the 3rd decimal of the total
    value = int(1, 40000) / 1000 + (unit === "kg" ? 0.005 : 0);
  } else {
    value = pick([0, 0.001, 0.0004, 0.01, 0.1, 1, 999.999, 5000, 9999.99, 10000, 250000]);
  }
  return { typedValue: value, typedUnit: unit, loadEntry };
}

let setIndex = 0;
async function insertSet(row) {
  setIndex += 1;
  try {
    await db.query(
      `insert into sets (id, user_id, session_id, exercise_id, set_index, set_type, load_kg, reps,
                         load_entry, entered_load, entered_unit)
       values ($1, $2, $3, $4, $5, 'working', $6, 5, $7::load_entry_mode, $8, $9::load_unit)`,
      [randomUUID(), OWNER, SESSION, EX, setIndex, str(row.load_kg), row.load_entry ?? null,
        str(row.entered_load), row.entered_unit ?? null],
    );
    return null;
  } catch (e) {
    return e.message;
  }
}
let rxPos = 0;
async function insertRx(row) {
  rxPos += 1;
  try {
    await db.query(
      `insert into prescriptions (id, user_id, planned_workout_id, exercise_id, position, sets, reps_min, reps_max,
                                  load_kg, load_pct_tm, load_entry, entered_load, entered_unit)
       values ($1, $2, $3, $4, $5, 3, 5, 5, $6, $7, $8::load_entry_mode, $9, $10::load_unit)`,
      [randomUUID(), OWNER, WORKOUT, EX, rxPos, str(row.load_kg), row.load_pct_tm ?? null,
        row.load_entry ?? null, str(row.entered_load), row.entered_unit ?? null],
    );
    return null;
  } catch (e) {
    return e.message;
  }
}
// numbers travel as the decimal text a JSON body would carry
const str = (v) => (v === null || v === undefined ? null : String(v));

test("buildSetLoad output is never refused by the database (sets and prescriptions)", async () => {
  let built = 0;
  let refusedByBuilder = 0;
  const refusals = [];
  for (let i = 0; i < CASES; i++) {
    const input = typedCase();
    let load;
    try {
      load = buildSetLoad(input);
    } catch (e) {
      assert.ok(e instanceof LoadIntegrityError, `unexpected ${e}`);
      refusedByBuilder++;
      continue;
    }
    built++;
    const err = await insertSet(load);
    if (err !== null) refusals.push({ input, load, err });
    assert.equal(isAcceptedAuthoredLoad(load, "sets").ok, true, JSON.stringify({ input, load }));
    if (load.load_kg > 0) {
      const rxErr = await insertRx(load);
      if (rxErr !== null) refusals.push({ input, load, rxErr });
      assert.equal(isAcceptedAuthoredLoad(load, "prescriptions").ok, true, JSON.stringify({ input, load }));
    }
  }
  assert.deepEqual(refusals.slice(0, 3), [], `${refusals.length} database refusals (seed ${SEED})`);
  assert.ok(built > CASES * 0.8, `only ${built} of ${CASES} cases built (${refusedByBuilder} refused by the builder)`);
  console.log(`  property: ${built} built loads inserted, ${refusedByBuilder} refused by the builder, 0 database refusals (seed ${SEED})`);
});

test("the TS mirror agrees with the database on arbitrary rows, accepted and refused", async () => {
  let agreeOk = 0;
  let agreeRefused = 0;
  const disagreements = [];
  const maybe = (p, v) => (rand() < p ? null : v);
  for (let i = 0; i < CASES; i++) {
    // Start from a consistent load half the time so the accepted side is
    // exercised hard, then corrupt one field the way a stale draft would.
    let base;
    try {
      base = buildSetLoad(typedCase());
    } catch {
      base = { load_kg: dp(rand() * 300, 2), load_entry: "total", entered_load: null, entered_unit: null };
    }
    let row = { ...base };
    switch (int(0, 11)) {
      case 0: row.load_kg = dp(row.load_kg + pick([0.01, -0.01, 0.05, 2.27, -2.5]), 2); break; // stale kg
      case 1: row.entered_load = dp((row.entered_load ?? 100) + pick([0.1, -0.1, 5, 0.001]), 3); break; // stale typed
      case 2: row.entered_unit = row.entered_unit === "lb" ? "kg" : "lb"; break; // unit flipped
      case 3: row.load_entry = row.load_entry === "per_side" ? "total" : "per_side"; break; // toggle flipped
      case 4: row.entered_load = null; break; // half a pair
      case 5: row.entered_unit = null; break; // other half
      case 6: row.load_entry = null; break; // authored without an entry
      case 7: row.load_kg = pick([0, -1, 9999.99, 10000, 99999, null]); break;
      case 8: row.entered_load = pick([0, -5, 0.0004, 999999.999, 1000000, 5e9]); break;
      case 9: row = { load_kg: maybe(0.2, dp(rand() * 400, 2)), load_entry: maybe(0.3, pick(["total", "per_side"])),
        entered_load: maybe(0.4, dp(rand() * 800, int(0, 4))), entered_unit: maybe(0.4, pick(["kg", "lb"])) }; break;
      default: break; // untouched, consistent
    }
    const table = rand() < 0.5 ? "sets" : "prescriptions";
    const pct = table === "prescriptions" && rand() < 0.1 ? 80 : null;
    if (pct !== null) row = { ...row, load_pct_tm: pct, load_kg: null };
    const mirror = isAcceptedAuthoredLoad(row, table).ok;
    const err = table === "sets" ? await insertSet(row) : await insertRx(row);
    const real = err === null;
    if (mirror === real) real ? agreeOk++ : agreeRefused++;
    else disagreements.push({ table, row, mirror, real, err });
  }
  assert.deepEqual(disagreements.slice(0, 3), [], `${disagreements.length} disagreements (seed ${SEED})`);
  assert.ok(agreeOk > CASES * 0.15 && agreeRefused > CASES * 0.15,
    `weak coverage: ${agreeOk} accepted / ${agreeRefused} refused`);
  console.log(`  mirror: ${agreeOk} accepted + ${agreeRefused} refused, all identical to the database (seed ${SEED})`);
});

test("regression: the derivations that failed in production are refused by the database and rejected by the mirror", async () => {
  // A kg-authored 100 kg plan, edited in lb: the editor showed 220.5 lb
  // (1 decimal) and wrote that beside the untouched 100 kg total.
  const staleStep = { load_kg: 100, load_entry: "total", entered_load: 220.5, entered_unit: "lb" };
  // A focus load step: the total moved, the old typed number stayed.
  const staleFocus = { load_kg: 102.27, load_entry: "total", entered_load: 225, entered_unit: "lb" };
  // 1.25 kg steps read at one decimal beside the exact per-side total.
  const roundedPlate = { load_kg: 22.5, load_entry: "per_side", entered_load: 11.3, entered_unit: "kg" };
  // JS Math.round(1.005 * 100) is 100; Postgres rounds the tie to 1.01.
  const floatTie = { load_kg: Math.round(1.005 * 100) / 100, load_entry: "total", entered_load: 1.005, entered_unit: "kg" };
  for (const bad of [staleStep, staleFocus, roundedPlate, floatTie]) {
    assert.match(await insertSet(bad) ?? "", /load_kg must match/, JSON.stringify(bad));
    assert.equal(isAcceptedAuthoredLoad(bad).ok, false, JSON.stringify(bad));
  }
  // and the same typed numbers through the one derivation are accepted
  for (const input of [
    { typedValue: 220.5, typedUnit: "lb", loadEntry: "total" },
    { typedValue: 225, typedUnit: "lb", loadEntry: "total" },
    { typedValue: 11.25, typedUnit: "kg", loadEntry: "per_side" },
    { typedValue: 1.005, typedUnit: "kg", loadEntry: "total" },
  ]) {
    const load = buildSetLoad(input);
    assert.equal(await insertSet(load), null, JSON.stringify({ input, load }));
  }
});

test("provenanceForTotal only claims a typed number that reproduces the total", async () => {
  for (let i = 0; i < CASES / 4; i++) {
    const unit = pick(["kg", "lb"]);
    const entry = pick(["total", "per_side"]);
    const total = dp(0.01 + rand() * 400, 2);
    const p = provenanceForTotal(total, unit, entry);
    const row = { load_kg: total, load_entry: entry, ...p };
    assert.equal(isAcceptedAuthoredLoad(row).ok, true, JSON.stringify(row));
    assert.equal(await insertSet(row), null, JSON.stringify(row));
  }
});

test("the MCP copy of setLoad.ts is byte-identical to the PWA module", async () => {
  const pwa = await readFile(join(root, "pwa/src/lib/setLoad.ts"), "utf8");
  const mcp = await readFile(join(root, "supabase/functions/mcp-server/lib/setLoad.ts"), "utf8");
  assert.equal(mcp, pwa, "copy pwa/src/lib/setLoad.ts over supabase/functions/mcp-server/lib/setLoad.ts");
});

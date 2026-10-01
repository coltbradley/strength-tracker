// THE ONLY derivation of a set's (or prescription's) load fields.
//
//   load_kg      total system kg, numeric(6,2)
//   load_entry   'total' | 'per_side' (how the number was expressed)
//   entered_load exactly what the lifter typed, numeric(9,3)
//   entered_unit the unit it was typed in
//
// The database refuses any row where those four disagree
// (validate_entered_load_consistency, 20260924003054_native_load_units.sql):
//
//   round(entered_load * (lb ? 0.45359237 : 1) * (per_side ? 2 : 1), 2)
//     must equal load_kg
//
// Every bug of the "lb/kg load error / failed sync" class had one shape: a
// writer held kg AND a typed number as two independent facts, changed one of
// them (a stepper, a unit switch, a display rounding to 1 decimal, a JS float
// rounding that Postgres numeric does not share) and wrote both. This module
// removes the second fact. Callers hand over what was TYPED and its unit;
// `buildSetLoad` derives load_kg with exact decimal arithmetic that is
// bit-for-bit the database's, so the four fields agree by construction.
// `isAcceptedAuthoredLoad` is the TS mirror of the database rule, used as an
// assertion before anything is queued or sent.
//
// This file must stay dependency-free: scripts/load-integrity.test.mjs
// imports it directly under node against a PGlite database that runs the real
// migration chain, and supabase/functions/mcp-server/lib/setLoad.ts is a
// byte-identical copy (the same test pins that).

export type LoadUnit = "kg" | "lb";
export type LoadEntryMode = "total" | "per_side";

/** Exact: 1 lb = 0.45359237 kg by definition. */
export const KG_PER_LB = 0.45359237;

/** numeric(6,2): the largest total a column can hold. */
export const MAX_LOAD_KG_COLUMN = 9999.99;
/** numeric(9,3) with the check `<= 999999.999`. */
export const MAX_ENTERED_LOAD = 999999.999;

export class LoadIntegrityError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LoadIntegrityError";
    this.code = code;
  }
}

// ---- exact decimals ---------------------------------------------------------
// value = n / 10^s. Postgres parses a JSON number as the decimal text it was
// written with, which for a JS number is its shortest round-trip repr, so
// parsing that same text gives the exact value the database will see.

interface Dec {
  n: bigint;
  s: number;
}

const TEN = 10n;
const pow10 = (k: number): bigint => TEN ** BigInt(k);

function toDec(x: number): Dec {
  if (!Number.isFinite(x)) {
    throw new LoadIntegrityError("not_finite", `load value ${String(x)} is not a number`);
  }
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(x));
  if (!m) throw new LoadIntegrityError("not_finite", `cannot read load value ${String(x)}`);
  const [, sign, int, frac = "", exp = "0"] = m;
  let n = BigInt(int + frac);
  if (sign === "-") n = -n;
  const e = Number(exp) - frac.length;
  return e >= 0 ? { n: n * pow10(e), s: 0 } : { n, s: -e };
}

/** Postgres numeric rounding: half away from zero, exact. */
function roundDec(d: Dec, places: number): Dec {
  if (d.s <= places) return { n: d.n * pow10(places - d.s), s: places };
  const p = pow10(d.s - places);
  let q = d.n / p; // truncates toward zero
  const r = d.n % p;
  const twice = (r < 0n ? -r : r) * 2n;
  if (twice >= p) q += d.n < 0n ? -1n : 1n;
  return { n: q, s: places };
}

function decToNumber(d: Dec): number {
  return Number(`${d.n}e-${d.s}`);
}

const LB_FACTOR: Dec = { n: 45359237n, s: 8 };

/** round(entered * unitFactor * sides, 2), the trigger's expected total. */
function expectedTotal(entered: Dec, unit: LoadUnit, entry: LoadEntryMode): Dec {
  let v = entered;
  if (unit === "lb") v = { n: v.n * LB_FACTOR.n, s: v.s + LB_FACTOR.s };
  if (entry === "per_side") v = { n: v.n * 2n, s: v.s };
  return roundDec(v, 2);
}

// ---- the mirror of the database rule ----------------------------------------

export interface AuthoredLoadFields {
  load_kg?: number | string | null;
  load_entry?: string | null;
  entered_load?: number | string | null;
  entered_unit?: string | null;
  load_pct_tm?: number | null;
}

export type LoadVerdict =
  | { ok: true }
  | { ok: false; code: string; message: string };

/** The database's own wording, so a client verdict and a server error match. */
export const LOAD_MISMATCH_MESSAGE =
  "load_kg must match entered_load, entered_unit, and load_entry";

const reject = (code: string, message: string): LoadVerdict => ({ ok: false, code, message });

function decOf(v: number | string): Dec {
  return typeof v === "number" ? toDec(v) : toDec(Number(v));
}

/**
 * Would the database accept this row's load fields?
 *
 * Mirrors, in the order Postgres applies them: column coercion
 * (load_kg numeric(6,2), entered_load numeric(9,3) -- the trigger sees the
 * ROUNDED values), enum input, the BEFORE trigger, then the table checks.
 * `table: 'sets'` also requires load_kg (not null, >= 0, per_side > 0);
 * `'prescriptions'` allows a null load_kg (by feel / %TM) and requires > 0.
 */
export function isAcceptedAuthoredLoad(
  row: AuthoredLoadFields,
  table: "sets" | "prescriptions" = "sets",
): LoadVerdict {
  const entry = row.load_entry ?? null;
  const unit = row.entered_unit ?? null;
  if (entry !== null && entry !== "total" && entry !== "per_side")
    return reject("enum", `invalid load_entry ${JSON.stringify(entry)}`);
  if (unit !== null && unit !== "kg" && unit !== "lb")
    return reject("enum", `invalid entered_unit ${JSON.stringify(unit)}`);

  let load: Dec | null = null;
  if (row.load_kg !== null && row.load_kg !== undefined) {
    let raw: Dec;
    try {
      raw = decOf(row.load_kg);
    } catch (e) {
      return reject("not_finite", (e as Error).message);
    }
    load = roundDec(raw, 2);
    if (load.n >= 1000000n || load.n <= -1000000n)
      return reject("overflow", "load_kg exceeds numeric(6,2)");
  } else if (table === "sets") {
    return reject("load_null", "sets.load_kg is required");
  }

  let entered: Dec | null = null;
  if (row.entered_load !== null && row.entered_load !== undefined) {
    let raw: Dec;
    try {
      raw = decOf(row.entered_load);
    } catch (e) {
      return reject("not_finite", (e as Error).message);
    }
    entered = roundDec(raw, 3);
    if (entered.n >= 1000000000n || entered.n <= -1000000000n)
      return reject("overflow", "entered_load exceeds numeric(9,3)");
  }

  // BEFORE trigger
  if (entered !== null || unit !== null) {
    if (entered === null || unit === null)
      return reject("pair", "entered_load and entered_unit must be supplied together");
    if (entry === null) return reject("entry_required", "authored loads require load_entry");
    if (row.load_pct_tm !== null && row.load_pct_tm !== undefined)
      return reject("pct", "percentage prescriptions cannot carry an authored direct load");
    const expected = expectedTotal(entered, unit as LoadUnit, entry as LoadEntryMode);
    if (load === null || expected.n !== load.n)
      return reject("mismatch", LOAD_MISMATCH_MESSAGE);
  }

  // table checks
  if (entered !== null && (entered.n <= 0n || entered.n > 999999999n))
    return reject("entered_range", "entered_load must be > 0 and <= 999999.999");
  if (load !== null) {
    if (table === "sets" && load.n < 0n) return reject("load_range", "load_kg must be >= 0");
    if (table === "prescriptions" && load.n <= 0n)
      return reject("load_range", "prescription load_kg must be > 0");
    if (entry === "per_side" && table === "sets" && load.n <= 0n)
      return reject("per_side_zero", "per_side needs a load above zero");
  } else if (entry === "per_side" && row.load_pct_tm == null) {
    return reject("per_side_zero", "per_side needs a load");
  }
  return { ok: true };
}

/** Throw before a violating row can reach the outbox or the network. */
export function assertAcceptedAuthoredLoad(
  row: AuthoredLoadFields,
  table: "sets" | "prescriptions" = "sets",
  what = "set",
): void {
  const v = isAcceptedAuthoredLoad(row, table);
  if (!v.ok) {
    throw new LoadIntegrityError(
      v.code,
      `This ${what}'s load is inconsistent (${v.message}) and was not saved. Re-enter the weight.`,
    );
  }
}

// ---- the one derivation -----------------------------------------------------

export interface BuiltLoad {
  load_kg: number;
  load_entry: LoadEntryMode;
  entered_load: number | null;
  entered_unit: LoadUnit | null;
}

export interface BuildSetLoadInput {
  /** What the lifter typed (one side when loadEntry is 'per_side'). */
  typedValue: number;
  /** The unit it was typed in. */
  typedUnit: LoadUnit;
  loadEntry: LoadEntryMode;
  /** The largest total to accept, kg. Defaults to what the column holds. */
  maxTotalKg?: number;
}

/**
 * typed value + unit -> the four load fields, exactly as the database will
 * recompute them. A typed zero is a bodyweight set: load 0, 'total', no
 * authored pair (the database refuses per_side on nothing, and entered_load
 * must be > 0). Throws LoadIntegrityError for a value that cannot be stored
 * as typed (negative, not a number, rounds to nothing, or beyond the column).
 */
export function buildSetLoad(input: BuildSetLoadInput): BuiltLoad {
  const { typedValue, typedUnit, loadEntry } = input;
  if (typedUnit !== "kg" && typedUnit !== "lb")
    throw new LoadIntegrityError("enum", `unknown unit ${String(typedUnit)}`);
  if (loadEntry !== "total" && loadEntry !== "per_side")
    throw new LoadIntegrityError("enum", `unknown load entry ${String(loadEntry)}`);
  const raw = toDec(typedValue);
  if (raw.n < 0n) throw new LoadIntegrityError("negative", "A load cannot be negative.");
  const entered = roundDec(raw, 3);
  if (entered.n === 0n) {
    if (raw.n > 0n)
      throw new LoadIntegrityError("too_small", `${typedValue} ${typedUnit} is too small to store.`);
    return { load_kg: 0, load_entry: "total", entered_load: null, entered_unit: null };
  }
  const total = expectedTotal(entered, typedUnit, loadEntry);
  if (total.n === 0n)
    throw new LoadIntegrityError("too_small", `${typedValue} ${typedUnit} is too small to store.`);
  const limit = Math.min(input.maxTotalKg ?? MAX_LOAD_KG_COLUMN, MAX_LOAD_KG_COLUMN);
  const totalKg = decToNumber(total);
  if (totalKg > limit || entered.n > 999999999n)
    throw new LoadIntegrityError("too_large", `${typedValue} ${typedUnit} is more than a load can hold.`);
  const built: BuiltLoad = {
    load_kg: totalKg,
    load_entry: loadEntry,
    entered_load: decToNumber(entered),
    entered_unit: typedUnit,
  };
  // Belt and braces: the construction above IS the rule; this proves it.
  assertAcceptedAuthoredLoad(built, "sets", "load");
  return built;
}

/**
 * A kg TOTAL that already exists (a refreshed template, a copied day) ->
 * its authored pair in `unit`, or null provenance when no honest typed number
 * reproduces the total. Honest means: at most 3 decimals in kg, 1 in lb --
 * the precision a lifter could have typed and read back.
 */
export function provenanceForTotal(
  totalKg: number,
  unit: LoadUnit,
  loadEntry: LoadEntryMode,
): Pick<BuiltLoad, "entered_load" | "entered_unit"> {
  const total = roundDec(toDec(totalKg), 2);
  if (total.n <= 0n) return { entered_load: null, entered_unit: null };
  const places = unit === "lb" ? [1] : [0, 1, 2, 3];
  const totalNumber = decToNumber(total);
  const side = loadEntry === "per_side" ? totalNumber / 2 : totalNumber;
  const typed = unit === "lb" ? side / KG_PER_LB : side;
  for (const p of places) {
    const candidate = decToNumber(roundDec(toDec(typed), p));
    if (candidate <= 0) continue;
    const back = expectedTotal(toDec(candidate), unit, loadEntry);
    if (back.n === total.n) return { entered_load: candidate, entered_unit: unit };
  }
  return { entered_load: null, entered_unit: null };
}

// ---- drafts -----------------------------------------------------------------

export interface TypedLoad {
  value: number;
  unit: LoadUnit;
}

/**
 * The typed number a draft stands for. A draft that carries an authored pair
 * (typed in some unit) is that pair, whatever unit the screen shows now; a
 * draft that does not is the kg value read in the screen's unit at the one
 * decimal (lb) or two (kg) the steppers display. Display and write both call
 * this, so what the lifter sees on the stepper is what is saved.
 */
export function typedFromDraft(
  draft: { entryKg: number; enteredLoad?: number; enteredUnit?: LoadUnit },
  displayUnit: LoadUnit,
): TypedLoad {
  if (draft.enteredLoad !== undefined && draft.enteredUnit)
    return { value: draft.enteredLoad, unit: draft.enteredUnit };
  // kg keeps the two decimals the stepper lands on (1.25 kg steps: 21.25);
  // lb is a conversion of a 2-decimal kg total, so it reads at one decimal.
  const value = displayUnit === "kg"
    ? Math.round(draft.entryKg * 100) / 100
    : Math.round((draft.entryKg / KG_PER_LB) * 10) / 10;
  return { value, unit: displayUnit };
}

// ---- display ----------------------------------------------------------------

export interface DisplayableLoad {
  load_kg: number;
  load_entry?: LoadEntryMode | null;
  entered_load?: number | null;
  entered_unit?: LoadUnit | null;
}

/**
 * The number to SHOW for a stored load in `unit`: exactly what was typed when
 * it was typed in this unit, otherwise the conversion at one decimal. For a
 * per-side set it is one side. This is the reader's half of the round-trip
 * guarantee; every surface that prints a set's load goes through it.
 */
export function shownLoadValue(row: DisplayableLoad, unit: LoadUnit): number {
  if (row.entered_load != null && row.entered_unit === unit && row.load_entry != null)
    return row.entered_load;
  const side = row.load_entry === "per_side" ? row.load_kg / 2 : row.load_kg;
  const v = unit === "kg" ? side : side / KG_PER_LB;
  return Math.round(v * 10) / 10;
}

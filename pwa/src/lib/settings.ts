// Preference registry: global settings are device-local, per-exercise prefs sync.
//
// Every preference is ONE declaration in `SETTINGS` below carrying its group,
// label, help text, control kind, default and validator. The store, the hooks
// (hooks/useSettings.ts) and the whole settings sheet render from that
// declaration — adding a preference is one entry here and nothing else.
//
// STORAGE: a single versioned envelope in localStorage,
//   strength-log.settings = { "v": 1, "values": { … } }
// with a migration table (`MIGRATIONS`) applied on load. The envelope exists so
// a future shape change has somewhere to live instead of silently resetting
// somebody's configuration. v0 (no envelope) folds in the five pre-registry
// keys; those keys are deliberately NOT deleted, so a rollback to the previous
// release still finds them.
//
// SCOPE: device-local, with ONE exception: the per-exercise record syncs.
// Global preferences (plates, bars,
// unit, steps, rest defaults, display) never sync — there is no user_settings
// table (owner decision, 2026-08-27). The per-exercise record `exercisePrefs`
// DOES sync, per user, through the `exercise_prefs` table (owner decision,
// 2026-10-01, docs/decisions.md): this module stays the store every reader
// uses, stamps each per-exercise write with a time, and tells a subscriber;
// lib/exercisePrefsSync.ts owns the network half (outbox write, fetch, merge).
//
// UNIT DECISION (unchanged, and load-bearing): everything is stored in kg —
// the codebase's canonical unit — but the app maintains TWO inventories, one
// per display unit system, rather than converting a single list:
//   kg mode: 25/20/15/10/5/2.5/1.25 kg plates, 20/15/10 kg bars
//   lb mode: the classic 45/35/25/10/5/2.5 lb set and 45/35/15 lb bars,
//            stored as their exact kg equivalents (45 lb = 20.4116… kg)
// This keeps chip labels clean in both modes and keeps plate math exact. The
// same reasoning applies to the load-step settings: they are per display unit,
// stored in kg, so "2.5 kg" and "5 lb" are both exactly representable.
//
// MODULE CYCLE: units.ts imports `getLoadStepKg` from here, and this module
// imports `lbToKg` from units.ts. That cycle is safe ONLY because neither
// module evaluates anything from the other at module-init time — every default
// here is a thunk and the store loads lazily on first read. Do not introduce a
// top-level call to `lbToKg` (or any other units.ts value) in this file.

import { reportError } from "./errors";
import type { LoadEntry, LoadUnit } from "./types";
import type { LoadStyle } from "./loadStyle";
import { plateDisplayValue } from "./plates";
import { lbToKg, type Unit } from "./units";

// ---- shape -----------------------------------------------------------------

export type Group = "units" | "gym" | "logging" | "timing" | "display";

export const GROUP_ORDER: readonly Group[] = [
  "units",
  "gym",
  "logging",
  "timing",
  "display",
];

export const GROUP_LABEL: Record<Group, string> = {
  units: "UNITS",
  gym: "GYM",
  logging: "LOGGING",
  timing: "TIMING",
  display: "DISPLAY",
};

/** Colour theme choice. "system" follows prefers-color-scheme (lib/theme.ts). */
export type Appearance = "light" | "dark" | "system";

export type PerUnit<T> = Record<Unit, T>;

/** Per-exercise overrides. Every field is optional; absent = use the global. */
export interface ExercisePref {
  /** kg the bar itself weighs; 0 = no bar (plate-loaded machines) */
  barKg?: number;
  /** rest between sets of this movement, seconds */
  restSeconds?: number;
  /** coarse stepper increment in kg (the fine step stays global) */
  loadStepKg?: number;
  /** RESERVED. The column `exercise_prefs.load_unit` exists and this field is
   *  parsed and round-tripped through sync so a value written elsewhere is
   *  never clobbered, but NOTHING sets or reads it: the unit a lifter sees is
   *  the device default, or this session's own choice (`sessionPrefs`), and a
   *  set's authored unit is the typed pair on the row. Do not read it for
   *  display or authoring without a decision entry (docs/decisions.md,
   *  2026-10-01 "Final fix pass on the integrated branch"); a test pins its readers. */
  loadUnit?: LoadUnit;
  /** whether this movement's load is typed per side or as the whole system;
   *  absent = fall back to the prescription, then to the equipment guess
   *  (lib/loadEntry.ts). Storage stays kg TOTAL either way. */
  loadEntry?: LoadEntry;
  /** which load-mode presentation this movement uses: a bar-and-plates
   *  calculator or a pin stack; absent = fall back to the equipment/name
   *  guess (lib/loadStyle.ts). Orthogonal to `loadEntry` above — that is
   *  per-side vs total, this is what the calculator draws. */
  loadStyle?: LoadStyle;
}

export type ExercisePrefs = Record<string, ExercisePref>;

/**
 * Bookkeeping for syncing `exercisePrefs` (never rendered).
 *
 * `owner` is the account these prefs belong to: null until the first identity
 * claims them (the device-local prefs that predate sync are adopted by the
 * first account seen, which is the person who was already using them). When a
 * DIFFERENT account signs in, the prefs are cleared before anything is sent,
 * so one person's preferences are never uploaded as another's — the same rule
 * as the device cache's owner marker (db.ts `claimCacheFor`).
 *
 * `stamps` is the last-write-wins clock: exercise id -> ISO time of the last
 * change this device knows about, set on a local write and on a merged server
 * row alike. A stamp with NO pref is a tombstone (the pref was cleared), which
 * is what stops a stale server row resurrecting it. Kept beside the prefs
 * rather than inside each ExercisePref so a tombstone never shows up as an
 * empty override in the settings list.
 */
export interface ExercisePrefsSyncState {
  owner: string | null;
  stamps: Record<string, string>;
}

/**
 * Where the floating bug button sits. `side` because it snaps to an edge
 * rather than floating loose in the middle of a set list, and `y` as a
 * FRACTION of the band it may occupy (0 = top, 1 = bottom) so the position
 * survives rotation, a different phone, and the keyboard opening.
 */
export interface BugButtonPos {
  side: "left" | "right";
  y: number;
}

/**
 * How the settings sheet renders a preference. `hidden` means the registry
 * owns the value (validation, migration, reset) but a bespoke section renders
 * it — the bar selection rides along with the bar inventory, and per-exercise
 * overrides get their own list.
 */
export type Control =
  | { kind: "hidden" }
  | { kind: "toggle" }
  | {
      kind: "segment";
      options: readonly { value: string | number; label: string }[];
    }
  /** seconds, typed on the number pad */
  | { kind: "seconds"; min: number; max: number }
  /** one kg scalar, typed and shown in the active display unit */
  | { kind: "load"; min: number; max: number }
  /** one kg value PER display unit; only the active unit's entry is editable */
  | { kind: "loadPerUnit"; min: number; max: number }
  /** plain integer */
  | { kind: "count"; min: number; max: number }
  | { kind: "plateInventory" }
  | { kind: "barInventory" };

export interface Def<T> {
  readonly group: Group;
  readonly label: string;
  readonly help?: string;
  readonly control: Control;
  /**
   * Lazily evaluated — see the MODULE CYCLE note at the top of this file.
   * Must return a fresh value; callers may not mutate it.
   */
  readonly defaults: () => T;
  /** Returns a valid T, or null to fall back to `defaults()`. */
  readonly parse: (raw: unknown) => T | null;
}

/** identity helper so each entry infers its own T instead of collapsing */
function def<T>(d: Def<T>): Def<T> {
  return d;
}

// ---- validation helpers ----------------------------------------------------

const EPS = 1e-6;

export function nearKg(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** finite number inside [min, max], else null */
function num(raw: unknown, min: number, max: number): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return raw >= min && raw <= max ? raw : null;
}

function int(raw: unknown, min: number, max: number): number | null {
  const n = num(raw, min, max);
  return n === null ? null : Math.round(n);
}

/**
 * A per-unit pair. A corrupt half falls back to that half's default rather
 * than discarding the good half — losing an inventory is the failure mode
 * this whole module exists to prevent.
 */
function perUnit<T>(
  raw: unknown,
  one: (v: unknown) => T | null,
  fallback: () => PerUnit<T>,
): PerUnit<T> | null {
  if (!isRecord(raw)) return null;
  const fb = fallback();
  const kg = one(raw.kg);
  const lb = one(raw.lb);
  if (kg === null && lb === null) return null;
  return { kg: kg ?? fb.kg, lb: lb ?? fb.lb };
}

/**
 * A load inventory: kg values, deduped, heaviest first. An EMPTY list is a
 * legitimate answer ("I have a bar and nothing else"), so it is preserved —
 * only a non-array falls back to the default.
 */
function loadList(raw: unknown, max: number): number[] | null {
  if (!Array.isArray(raw)) return null;
  const out: number[] = [];
  for (const v of raw) {
    const n = num(v, EPS, max);
    if (n === null) continue;
    if (out.some((x) => nearKg(x, n))) continue;
    out.push(n);
  }
  return out.sort((a, b) => b - a);
}

export const MAX_PLATE_KG = 100;
export const MAX_BAR_KG = 500;
export const MAX_REST_SECONDS = 3600;
/** cap on stored per-exercise overrides, so a corrupt blob can't grow forever */
const MAX_EXERCISE_PREFS = 1000;

function parseExercisePrefs(raw: unknown): ExercisePrefs | null {
  if (!isRecord(raw)) return null;
  const out: ExercisePrefs = {};
  let n = 0;
  for (const [id, value] of Object.entries(raw)) {
    if (n >= MAX_EXERCISE_PREFS) break;
    if (id.length === 0 || id.length > 128) continue;
    if (!isRecord(value)) continue;
    const pref: ExercisePref = {};
    const bar = num(value.barKg, 0, MAX_BAR_KG);
    if (bar !== null) pref.barKg = bar;
    const rest = int(value.restSeconds, 0, MAX_REST_SECONDS);
    if (rest !== null) pref.restSeconds = rest;
    const step = num(value.loadStepKg, EPS, MAX_PLATE_KG);
    if (step !== null) pref.loadStepKg = step;
    if (value.loadUnit === "kg" || value.loadUnit === "lb")
      pref.loadUnit = value.loadUnit;
    if (value.loadEntry === "total" || value.loadEntry === "per_side")
      pref.loadEntry = value.loadEntry;
    if (value.loadStyle === "plates" || value.loadStyle === "stack")
      pref.loadStyle = value.loadStyle;
    if (Object.keys(pref).length === 0) continue;
    out[id] = pref;
    n += 1;
  }
  return out;
}

function parseExercisePrefsSync(raw: unknown): ExercisePrefsSyncState | null {
  if (!isRecord(raw)) return null;
  const owner =
    typeof raw.owner === "string" && raw.owner.length > 0 && raw.owner.length <= 128
      ? raw.owner
      : null;
  const stamps: Record<string, string> = {};
  if (isRecord(raw.stamps)) {
    let n = 0;
    for (const [id, v] of Object.entries(raw.stamps)) {
      // prefs and tombstones together, so twice the prefs cap
      if (n >= MAX_EXERCISE_PREFS * 2) break;
      if (id.length === 0 || id.length > 128) continue;
      if (typeof v !== "string" || !Number.isFinite(Date.parse(v))) continue;
      stamps[id] = v;
      n += 1;
    }
  }
  return { owner, stamps };
}

// ---- the registry ----------------------------------------------------------

// Defaults live outside the registry object so `parse` can reuse them without
// referencing SETTINGS inside its own initializer (TS cannot infer that).
// All of them are thunks — see the MODULE CYCLE note at the top.
const defaultPlates = (): PerUnit<number[]> => ({
  kg: [25, 20, 15, 10, 5, 2.5, 1.25],
  lb: [45, 35, 25, 10, 5, 2.5].map(lbToKg),
});

const defaultBars = (): PerUnit<number[]> => ({
  kg: [20, 15, 10],
  lb: [45, 35, 15].map(lbToKg),
});

const defaultBar = (): PerUnit<number> => ({ kg: 20, lb: lbToKg(45) });

const defaultStepCoarse = (): PerUnit<number> => ({ kg: 2.5, lb: lbToKg(5) });

const defaultStepFine = (): PerUnit<number> => ({ kg: 0.5, lb: lbToKg(1) });

/** 20 kg and 45 lb: the empty bar in each system, not a conversion of the
 *  other. */
const defaultFallbackLoad = (): PerUnit<number> => ({
  kg: 20,
  lb: lbToKg(45),
});

/** Only the starts people actually use. Tuesday-to-Monday is not a training
 *  week anyone keeps, and offering it made the control a menu of five wrong
 *  answers. Monday (ISO, and what the SQL buckets by), Sunday (US calendars),
 *  Saturday (common for weekend-anchored splits). */
const WEEKDAYS = [
  { value: 1, label: "MON" },
  { value: 6, label: "SAT" },
  { value: 0, label: "SUN" },
] as const;

const SETTINGS = {
  unit: def<Unit>({
    group: "units",
    label: "Display unit",
    help: "Loads are stored in kg either way; this only changes what you read and type.",
    control: {
      kind: "segment",
      options: [
        { value: "kg", label: "kg" },
        { value: "lb", label: "lb" },
      ],
    },
    defaults: () => "kg",
    parse: (raw) => (raw === "kg" || raw === "lb" ? raw : null),
  }),

  plates: def<PerUnit<number[]>>({
    group: "gym",
    label: "Plates on hand",
    // no `help`: the inventory control renders its own live microcopy
    // (smallest achievable jump), and two dim lines under one row read as
    // noise rather than guidance.
    control: { kind: "plateInventory" },
    defaults: defaultPlates,
    parse: (raw) =>
      perUnit(raw, (v) => loadList(v, MAX_PLATE_KG), defaultPlates),
  }),

  bars: def<PerUnit<number[]>>({
    group: "gym",
    label: "Bars",
    help: "Add a trap bar, an EZ bar, or whatever your rack actually holds.",
    control: { kind: "barInventory" },
    defaults: defaultBars,
    // An empty bar list is NOT allowed (unlike plates): the plate calculator
    // and the per-exercise bar fallback both need at least one bar to exist.
    parse: (raw) =>
      perUnit(
        raw,
        (v) => {
          const list = loadList(v, MAX_BAR_KG);
          return list === null || list.length === 0 ? null : list;
        },
        defaultBars,
      ),
  }),

  // Which bar is selected, per display unit. Rendered by the bar inventory
  // control rather than on its own row.
  bar: def<PerUnit<number>>({
    group: "gym",
    label: "Selected bar",
    control: { kind: "hidden" },
    defaults: defaultBar,
    parse: (raw) => perUnit(raw, (v) => num(v, 0, MAX_BAR_KG), defaultBar),
  }),

  // Hardwiring the coarse step to the standard plate is wrong for dumbbells
  // (5 lb per hand), for machines (whatever the stack says) and for anyone
  // with micro-plates. NOTE: v_resolved_prescriptions.plate_load_kg still
  // rounds to the nearest 2.5 kg server-side
  // (supabase/migrations/20260825120003_views.sql) — that is the coach's
  // prescription being made loadable, not this stepper, and the two are
  // deliberately independent.
  loadStepCoarse: def<PerUnit<number>>({
    group: "gym",
    label: "Load step",
    help: "The ± buttons on the load stepper.",
    control: { kind: "loadPerUnit", min: 0.05, max: MAX_PLATE_KG },
    defaults: defaultStepCoarse,
    parse: (raw) =>
      perUnit(raw, (v) => num(v, EPS, MAX_PLATE_KG), defaultStepCoarse),
  }),

  loadStepFine: def<PerUnit<number>>({
    group: "gym",
    label: "Fine load step",
    help: "Micro-plates and dumbbell half-steps.",
    control: { kind: "loadPerUnit", min: 0.05, max: MAX_PLATE_KG },
    defaults: defaultStepFine,
    parse: (raw) =>
      perUnit(raw, (v) => num(v, EPS, MAX_PLATE_KG), defaultStepFine),
  }),

  exercisePrefs: def<ExercisePrefs>({
    group: "gym",
    label: "Exercise overrides",
    control: { kind: "hidden" },
    defaults: () => ({}),
    parse: parseExercisePrefs,
  }),

  // Additive key with a default, so no envelope bump (see firstRunDismissed):
  // an install that predates sync reads { owner: null, stamps: {} }.
  exercisePrefsSync: def<ExercisePrefsSyncState>({
    group: "gym",
    label: "Exercise override sync",
    control: { kind: "hidden" },
    defaults: () => ({ owner: null, stamps: {} }),
    parse: parseExercisePrefsSync,
  }),

  // Per display unit, for the reason the whole file is per display unit: a
  // single kg number is a clean default in kg mode and a conversion artifact
  // in lb mode. 20 kg showed up in Settings, and in every suggested load, as
  // "44.1 lb" — a number nobody has ever put on a bar. Stored kg either way.
  fallbackLoad: def<PerUnit<number>>({
    group: "logging",
    label: "Fallback load",
    help: "Used when a movement has no prescription and no history at all.",
    control: { kind: "loadPerUnit", min: 0, max: 999 },
    defaults: defaultFallbackLoad,
    parse: (raw) => perUnit(raw, (v) => num(v, 0, 999), defaultFallbackLoad),
  }),

  fallbackReps: def<number>({
    group: "logging",
    label: "Fallback reps",
    control: { kind: "count", min: 1, max: 100 },
    defaults: () => 8,
    parse: (raw) => int(raw, 1, 100),
  }),

  defaultRest: def<number>({
    group: "timing",
    label: "Default rest",
    help: "Used when the prescription and the movement both say nothing.",
    control: { kind: "seconds", min: 0, max: MAX_REST_SECONDS },
    defaults: () => 120,
    parse: (raw) => int(raw, 0, MAX_REST_SECONDS),
  }),

  autoStartRest: def<boolean>({
    group: "timing",
    label: "Auto-start rest",
    help: "Start the rest clock the moment a set is logged.",
    control: { kind: "toggle" },
    defaults: () => true,
    parse: (raw) => (typeof raw === "boolean" ? raw : null),
  }),

  // The only end-of-rest cue an installed iOS web app can produce by itself.
  // `new Notification(...)` does not exist there and `navigator.vibrate` does
  // not either, so without this the strip runs out in silence on the one
  // device this app is used on. Defaults ON for that reason: a silent rest
  // timer is the bug, not the preference.
  restSound: def<boolean>({
    group: "timing",
    label: "Rest sound",
    help: "A short tone when the clock runs out. Needs the app open, and the iPhone mute switch silences it.",
    control: { kind: "toggle" },
    defaults: () => true,
    parse: (raw) => (typeof raw === "boolean" ? raw : null),
  }),

  /**
   * Light / Dark / Follow system. Default LIGHT (owner decision, 2026-10-01):
   * "system" is opt-in, so nobody's phone-wide dark mode changes the app under
   * them. Applied by lib/theme.ts. ADDITIVE: an absent key parses to null and
   * takes the default, so no envelope migration or version bump is needed.
   *
   * COUPLING: index.html reads this key out of the stored envelope
   * (`strength-log.settings` -> values.appearance) in a tiny inline script to
   * set data-theme before first paint. Renaming the key, the envelope key or
   * the envelope shape means updating that script too.
   */
  appearance: def<Appearance>({
    group: "display",
    label: "Appearance",
    help: "System follows your phone's light/dark setting.",
    control: {
      kind: "segment",
      options: [
        { value: "light", label: "Light" },
        { value: "dark", label: "Dark" },
        { value: "system", label: "System" },
      ],
    },
    defaults: () => "light",
    parse: (raw) =>
      raw === "light" || raw === "dark" || raw === "system" ? raw : null,
  }),

  /** Moved by long-pressing the button and dragging it; no sheet control. */
  bugButtonPos: def<BugButtonPos>({
    group: "display",
    label: "Report button position",
    control: { kind: "hidden" },
    defaults: () => ({ side: "right" as const, y: 1 }),
    parse: (raw) => {
      if (!isRecord(raw)) return null;
      const side =
        raw.side === "left" || raw.side === "right" ? raw.side : null;
      const y = num(raw.y, 0, 1);
      return side === null || y === null ? null : { side, y };
    },
  }),

  /**
   * Whether the first-run card on an empty Today has been put away.
   *
   * A fact about the app's chrome rather than about the gym, so it sits with
   * the bug button's position in `display`, and hidden for the same reason:
   * the card dismisses itself and there is no sheet row for it. "Reset all
   * settings" brings it back, which is the honest way in.
   *
   * NO MIGRATION IS NEEDED HERE and none should be added. An absent key parses
   * to null and falls back to `defaults()`, so every install that predates this
   * entry reads `false` — and for anyone who already has a program that is a
   * card which never renders anyway. Migrations exist for values that CHANGE
   * SHAPE; a new key with a default is the additive path, and bumping
   * ENVELOPE_VERSION for one would rewrite everybody's envelope to say nothing.
   */
  firstRunDismissed: def<boolean>({
    group: "display",
    label: "First-run card dismissed",
    control: { kind: "hidden" },
    defaults: () => false,
    parse: (raw) => (typeof raw === "boolean" ? raw : null),
  }),

  // `focusDeckPreview` (the early-access rollout switch for session focus
  // mode) lived here through 2026-09-12. Focus is now the default for every
  // eligible session and the switch is gone — see docs/decisions.md. Removed
  // rather than migrated: an envelope that still carries the key just carries
  // an inert boolean nothing reads, exactly like a fresh install's absent
  // key. Do not reuse this comment's key name for an unrelated setting.

  weekStartsOn: def<number>({
    group: "display",
    label: "Week starts on",
    help: "Weekly volume is bucketed Monday-first in SQL, so a different start shifts the calendar strip only.",
    control: { kind: "segment", options: WEEKDAYS },
    defaults: () => 1,
    // Still parses 0-6, not just the three offered. Anyone who picked Wednesday
    // before the list was trimmed keeps it; the control simply stops offering
    // new ones. Narrowing this to the offered set would silently reset them.
    parse: (raw) => int(raw, 0, 6),
  }),
} as const;

type Registry = typeof SETTINGS;
export type SettingKey = keyof Registry;
type ValueOf<D> = D extends Def<infer T> ? T : never;
export type SettingValue<K extends SettingKey> = ValueOf<Registry[K]>;

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export function settingDef(key: SettingKey): Def<unknown> {
  return SETTINGS[key] as Def<unknown>;
}

/** Keys in a group that render themselves (hidden ones have bespoke sections). */
export function settingsInGroup(group: Group): SettingKey[] {
  return SETTING_KEYS.filter(
    (k) => SETTINGS[k].group === group && SETTINGS[k].control.kind !== "hidden",
  );
}

// ---- envelope + migrations -------------------------------------------------

const ENVELOPE_KEY = "strength-log.settings";
const ENVELOPE_VERSION = 2;

type Values = Record<string, unknown>;

/** Pre-registry keys. Left in place on purpose — see the header. */
const LEGACY = {
  unit: "strength-log.unit",
  plates: "strength-log.plates",
  bar: "strength-log.bar",
  defaultRest: "strength-log.defaultRest",
  exerciseBar: "strength-log.exerciseBar",
} as const;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // sandboxed iframe / storage blocked: preferences just won't persist
    return null;
  }
}

function legacyJson(key: string): unknown {
  const s = storage();
  if (s === null) return undefined;
  try {
    const raw = s.getItem(key);
    return raw === null ? undefined : (JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

/**
 * v0 -> v1: fold the five pre-registry localStorage keys into the envelope.
 * Anything already present in `values` wins (the envelope is newer than the
 * loose keys by definition), and the loose keys are left in place so a
 * rollback still reads them.
 */
function migrateV0toV1(values: Values): Values {
  const next: Values = { ...values };
  const put = (key: string, v: unknown): void => {
    if (v !== undefined && next[key] === undefined) next[key] = v;
  };

  // unit was written with setItem, not JSON.stringify
  const s = storage();
  let unitRaw: unknown;
  try {
    unitRaw = s?.getItem(LEGACY.unit) ?? undefined;
  } catch {
    unitRaw = undefined;
  }
  put("unit", unitRaw);

  put("plates", legacyJson(LEGACY.plates));
  put("bar", legacyJson(LEGACY.bar));
  put("defaultRest", legacyJson(LEGACY.defaultRest));

  // Record<exercise_id, kg> becomes the bar field of the per-exercise record.
  const exBar = legacyJson(LEGACY.exerciseBar);
  if (next.exercisePrefs === undefined && isRecord(exBar)) {
    const prefs: ExercisePrefs = {};
    for (const [id, kg] of Object.entries(exBar)) {
      if (typeof kg === "number" && Number.isFinite(kg) && kg >= 0) {
        prefs[id] = { barKg: kg };
      }
    }
    if (Object.keys(prefs).length > 0) next.exercisePrefs = prefs;
  }

  return next;
}

/**
 * v1 -> v2: `fallbackLoadKg` (one kg number) became `fallbackLoad` (one value
 * per display unit), because a single kg default is a conversion artifact in
 * lb mode — 20 kg was shown, and suggested, as "44.1 lb".
 *
 * A stored number is carried onto the unit it was actually chosen in. There is
 * no record of which that was, so the kg slot takes it (the value was typed
 * against a kg-labelled control in the only mode that displayed it honestly)
 * and the lb slot takes the lb default. Someone who set 60 kg keeps 60 kg; a
 * lb user who never touched it gets 45 lb instead of 44.1.
 *
 * The old key is NOT deleted, matching the v0 rule above: a rollback to the
 * previous release must still find its configuration.
 */
function migrateV1toV2(values: Values): Values {
  const next = { ...values };
  const old = values.fallbackLoadKg;
  if (typeof old === "number" && Number.isFinite(old) && old >= 0) {
    const d = defaultFallbackLoad();
    next.fallbackLoad = { kg: old, lb: d.lb };
  }
  return next;
}

const MIGRATIONS: Record<number, (values: Values) => Values> = {
  0: migrateV0toV1,
  1: migrateV1toV2,
};

// ---- store -----------------------------------------------------------------

const listeners = new Set<() => void>();

let values: Values | null = null;
/**
 * Parsed values, memoised. useSyncExternalStore compares snapshots by
 * identity, so a getter that re-parsed on every read would loop forever on
 * array/object settings. Cleared on every write.
 */
const parsed = new Map<SettingKey, unknown>();
let storageWarned = false;

function load(): Values {
  let v = 0;
  let raw: Values = {};
  const s = storage();
  if (s !== null) {
    try {
      const stored = s.getItem(ENVELOPE_KEY);
      if (stored !== null) {
        const env = JSON.parse(stored) as unknown;
        if (
          isRecord(env) &&
          typeof env.v === "number" &&
          Number.isFinite(env.v) &&
          isRecord(env.values)
        ) {
          v = env.v;
          raw = env.values;
        }
      }
    } catch (e) {
      // A corrupt envelope must not brick the app; defaults + the legacy
      // migration below still give the user a working configuration.
      reportError(e, "read settings");
    }
  }

  // A newer envelope (downgrade) is left alone: the parsers drop what they
  // cannot read, and re-saving would truncate the newer keys.
  while (v < ENVELOPE_VERSION) {
    const step = MIGRATIONS[v];
    if (step) raw = step(raw);
    v += 1;
  }
  return raw;
}

function ensure(): Values {
  if (values === null) values = load();
  return values;
}

function persist(): void {
  const s = storage();
  if (s === null) return;
  try {
    s.setItem(
      ENVELOPE_KEY,
      JSON.stringify({ v: ENVELOPE_VERSION, values: ensure() }),
    );
  } catch (e) {
    // Quota / private mode. Report once — a per-keystroke toast would be worse
    // than the failure it describes — but never swallow it silently.
    if (!storageWarned) {
      storageWarned = true;
      reportError(e, "save settings");
    }
  }
}

function notify(): void {
  parsed.clear();
  for (const fn of listeners) fn();
}

export function subscribeSettings(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** kept as an alias so existing call sites read naturally */
export const subscribeUnit = subscribeSettings;

/** Re-read the envelope from storage (another tab wrote it; tests). */
export function reloadSettings(): void {
  values = null;
  notify();
}

export function getSetting<K extends SettingKey>(key: K): SettingValue<K> {
  const hit = parsed.get(key);
  if (hit !== undefined) return hit as SettingValue<K>;
  const d = SETTINGS[key] as unknown as Def<SettingValue<K>>;
  const raw = ensure()[key];
  let value: SettingValue<K> | null = raw === undefined ? null : d.parse(raw);
  if (value === null) value = d.defaults();
  parsed.set(key, value);
  return value;
}

/** false when the value failed validation and nothing was written. */
export function setSetting<K extends SettingKey>(
  key: K,
  value: SettingValue<K>,
): boolean {
  const d = SETTINGS[key] as unknown as Def<SettingValue<K>>;
  const clean = d.parse(value);
  if (clean === null) return false;
  ensure()[key] = clean;
  persist();
  notify();
  return true;
}

/** Untyped pair for the registry-driven renderer. */
export function readSetting(key: SettingKey): unknown {
  return getSetting(key);
}

export function writeSetting(key: SettingKey, value: unknown): boolean {
  return setSetting(key as never, value as never);
}

export function resetSetting(key: SettingKey): void {
  delete ensure()[key];
  persist();
  notify();
}

/** Every preference back to its default. Does not touch logged training data. */
export function resetAllSettings(): void {
  values = {};
  persist();
  notify();
}

/** Plain snapshot of the stored envelope, for the data export. */
export function exportSettings(): { v: number; values: Values } {
  return { v: ENVELOPE_VERSION, values: { ...ensure() } };
}

// ---- unit ------------------------------------------------------------------

export function getUnit(): Unit {
  return getSetting("unit");
}

/**
 * Switching display unit switches inventories (see the UNIT DECISION above),
 * so any bar selection pinned to the other catalogue's numbers is remapped to
 * the nearest bar that actually exists in the new one — globally AND for every
 * per-exercise override. Without this a squat pinned to a 20 kg bar keeps
 * 20 kg while the chip row offers 20.41, so no chip reads as selected and the
 * plate math quietly disagrees with the rack.
 */
export function setUnit(next: Unit): void {
  if (!setSetting("unit", next)) return;
  repairBarsForUnit(next);
}

function nearestIn(list: readonly number[], value: number): number | null {
  if (list.length === 0) return null;
  let best = list[0];
  for (const v of list) {
    if (Math.abs(v - value) < Math.abs(best - value)) best = v;
  }
  return best;
}

/** Same bar, as the lifter reads it in `u` (20.41 kg and 20.4118 kg are both
 *  "45 lb"). Strict kg equality missed a bar typed in lb and stored rounded. */
function sameBar(a: number, b: number, u: Unit): boolean {
  return plateDisplayValue(a, u) === plateDisplayValue(b, u);
}

function repairBarsForUnit(u: Unit): void {
  const inv = getBarInventory(u);
  if (inv.length === 0) return;
  const other = getBarInventory(u === "kg" ? "lb" : "kg");
  const otherUnit: Unit = u === "kg" ? "lb" : "kg";

  const sel = getSetting("bar");
  if (!inv.some((b) => nearKg(b, sel[u]))) {
    const fixed = nearestIn(inv, sel[u]);
    if (fixed !== null) setSetting("bar", { ...sel, [u]: fixed });
  }

  // Only a bar that CAME FROM a bar list is remapped. 0 means "no bar" and is
  // unit-independent. A value in neither catalogue is a base weight the lifter
  // typed (a 34 kg / 75 lb sled is a fact about a machine, not a stand-in for a
  // bar) and is left exactly as it is; so is one the new catalogue already
  // holds. Compared as the lifter reads it, so 20.41 kg and 20.4118 kg are both
  // "45 lb". A remap IS a change to a synced record, so it goes through
  // commitExercisePref: stamped, and queued for the server, or this device
  // would disagree with every other one and equal stamps would never
  // reconcile it.
  for (const [id, pref] of Object.entries(getSetting("exercisePrefs"))) {
    const bar = pref.barKg;
    if (
      bar === undefined ||
      bar === 0 ||
      inv.some((b) => sameBar(b, bar, u)) ||
      !other.some((b) => sameBar(b, bar, otherUnit))
    ) {
      continue;
    }
    const fixed = nearestIn(inv, bar);
    if (fixed !== null) commitExercisePref(id, { ...pref, barKg: fixed });
  }
}

// ---- plates ----------------------------------------------------------------

/** enabled plates for a unit system, kg values, heaviest first */
export function getPlatesOnHand(u: Unit): number[] {
  return getSetting("plates")[u];
}

/** kg value; false when it is out of range or already on the list */
export function addPlate(u: Unit, plateKg: number): boolean {
  const cur = getPlatesOnHand(u);
  if (!Number.isFinite(plateKg) || plateKg <= 0 || plateKg > MAX_PLATE_KG) {
    return false;
  }
  if (cur.some((p) => nearKg(p, plateKg))) return false;
  const all = getSetting("plates");
  return setSetting("plates", {
    ...all,
    [u]: [...cur, plateKg].sort((a, b) => b - a),
  });
}

export function removePlate(u: Unit, plateKg: number): void {
  const all = getSetting("plates");
  setSetting("plates", {
    ...all,
    [u]: all[u].filter((p) => !nearKg(p, plateKg)),
  });
}

// ---- bars ------------------------------------------------------------------

export function getBarInventory(u: Unit): number[] {
  return getSetting("bars")[u];
}

/**
 * Live view of the bar inventory, keyed by display unit. Getter-backed rather
 * than a plain const so it stays current after an edit AND so this module has
 * no top-level evaluation (see the MODULE CYCLE note).
 */
export const BAR_CATALOG: Record<Unit, number[]> = {
  get kg() {
    return getBarInventory("kg");
  },
  get lb() {
    return getBarInventory("lb");
  },
};

/** The selected bar, repaired against the inventory on read. */
export function getBarKg(u: Unit): number {
  const inv = getBarInventory(u);
  const sel = getSetting("bar")[u];
  if (inv.some((b) => nearKg(b, sel))) return sel;
  return nearestIn(inv, sel) ?? 0;
}

export function setBarKg(u: Unit, kg: number): void {
  setSetting("bar", { ...getSetting("bar"), [u]: kg });
}

/** false when out of range or already present */
export function addBar(u: Unit, barKg: number): boolean {
  if (!Number.isFinite(barKg) || barKg <= 0 || barKg > MAX_BAR_KG) return false;
  const cur = getBarInventory(u);
  if (cur.some((b) => nearKg(b, barKg))) return false;
  const all = getSetting("bars");
  const ok = setSetting("bars", {
    ...all,
    [u]: [...cur, barKg].sort((a, b) => b - a),
  });
  if (ok) setBarKg(u, barKg);
  return ok;
}

/** The last bar cannot be removed — the plate calculator needs one to exist. */
export function removeBar(u: Unit, barKg: number): boolean {
  const all = getSetting("bars");
  const next = all[u].filter((b) => !nearKg(b, barKg));
  if (next.length === 0) return false;
  const ok = setSetting("bars", { ...all, [u]: next });
  if (ok && nearKg(getSetting("bar")[u], barKg)) {
    setBarKg(u, next[0]);
  }
  return ok;
}

// ---- rest ------------------------------------------------------------------

export function getDefaultRestSeconds(): number {
  return getSetting("defaultRest");
}

/** Granular control (typed via the number pad); clamped to the DB's cap. */
export function setDefaultRestSeconds(seconds: number): void {
  setSetting(
    "defaultRest",
    Math.min(MAX_REST_SECONDS, Math.max(0, Math.round(seconds))),
  );
}

export function getAutoStartRest(): boolean {
  return getSetting("autoStartRest");
}

/**
 * Whether the rest strip should sound a tone when the clock runs out.
 *
 * Read at the moment the cue fires rather than subscribed to: the tone is a
 * one-shot side effect, not rendered state, so a hook here would only cost the
 * strip a re-render on every toggle without changing what anybody hears.
 */
export function getRestSound(): boolean {
  return getSetting("restSound");
}

// ---- load steps ------------------------------------------------------------

/** Stepper increment in kg for the active display unit. */
export function getLoadStepKg(u: Unit, fine: boolean): number {
  return getSetting(fine ? "loadStepFine" : "loadStepCoarse")[u];
}

export function setLoadStepKg(u: Unit, fine: boolean, kg: number): boolean {
  const key = fine ? "loadStepFine" : "loadStepCoarse";
  return setSetting(key, { ...getSetting(key), [u]: kg });
}

// ---- per-exercise preferences ----------------------------------------------

/**
 * Stable "no overrides" value. `?? {}` here allocated a fresh object on every
 * read, and useSyncExternalStore compares snapshots with Object.is — so
 * `useExercisePref` on an exercise with no overrides re-rendered forever
 * ("The result of getSnapshot should be cached"). Frozen because callers
 * share it.
 */
const NO_PREF: ExercisePref = Object.freeze({});

export function getExercisePref(exerciseId: string): ExercisePref {
  return getSetting("exercisePrefs")[exerciseId] ?? NO_PREF;
}

export function listExercisePrefs(): {
  exerciseId: string;
  pref: ExercisePref;
}[] {
  return Object.entries(getSetting("exercisePrefs")).map(
    ([exerciseId, pref]) => ({ exerciseId, pref }),
  );
}

/**
 * Merge a patch into one exercise's record. An explicit `undefined` clears
 * that field; an emptied record drops out of storage entirely, which is what
 * keeps this map from accumulating no-op entries.
 */
/**
 * A local per-exercise change, as the sync layer hears about it: the record
 * after the change (null = cleared) and the time it was stamped with.
 */
export type ExercisePrefWriteListener = (
  exerciseId: string,
  pref: ExercisePref | null,
  updatedAt: string,
) => void;

const prefWriteListeners = new Set<ExercisePrefWriteListener>();

/** Told about every LOCAL per-exercise change (set or clear). Not told about
 *  merges from the server, a unit-switch bar repair or a prune — those are
 *  not choices the person made on this device. */
export function subscribeExercisePrefWrites(
  fn: ExercisePrefWriteListener,
): () => void {
  prefWriteListeners.add(fn);
  return () => prefWriteListeners.delete(fn);
}

export function getExercisePrefsSyncState(): ExercisePrefsSyncState {
  return getSetting("exercisePrefsSync");
}

/**
 * A stamp strictly after this device's previous one for the exercise, so a
 * second change always beats the first here even if the clock stepped back.
 */
function nextStamp(previous: string | undefined): string {
  const now = Date.now();
  let prev = previous === undefined ? NaN : Date.parse(previous);
  // A previous stamp beyond the server's bound is ignored, not built on: the
  // server refuses anything past now() + MAX_STAMP_SKEW_MS, so +1 on it would
  // queue a write that can never land.
  if (prev > now + MAX_STAMP_SKEW_MS) prev = NaN;
  return new Date(Number.isFinite(prev) && prev >= now ? prev + 1 : now).toISOString();
}

/** How far ahead of the server's clock a stamp may be. Mirrors the bound in
 *  20261001000000_exercise_prefs.sql (`interval '1 day'`). */
export const MAX_STAMP_SKEW_MS = 24 * 60 * 60 * 1000;

function samePref(a: ExercisePref | undefined, b: ExercisePref): boolean {
  if (a === undefined) return Object.keys(b).length === 0;
  const ka = Object.keys(a) as (keyof ExercisePref)[];
  const kb = Object.keys(b) as (keyof ExercisePref)[];
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

/** Write one exercise's record (null = clear), stamp it, tell subscribers. */
function commitExercisePref(exerciseId: string, pref: ExercisePref | null): void {
  const next: ExercisePrefs = { ...getSetting("exercisePrefs") };
  if (pref === null) delete next[exerciseId];
  else next[exerciseId] = pref;
  if (!setSetting("exercisePrefs", next)) return;
  const sync = getSetting("exercisePrefsSync");
  const stamp = nextStamp(sync.stamps[exerciseId]);
  setSetting("exercisePrefsSync", {
    ...sync,
    stamps: { ...sync.stamps, [exerciseId]: stamp },
  });
  // The stored value, after parse, is what syncs: never a field the
  // validator dropped.
  const stored = getSetting("exercisePrefs")[exerciseId] ?? null;
  for (const fn of prefWriteListeners) {
    try {
      fn(exerciseId, stored, stamp);
    } catch (e) {
      // A sync bug must never undo or block the local choice.
      reportError(e, "queue exercise setting");
    }
  }
}

export function setExercisePref(
  exerciseId: string,
  patch: Partial<ExercisePref>,
): void {
  const all = getSetting("exercisePrefs");
  const merged: ExercisePref = { ...all[exerciseId] };
  for (const [k, v] of Object.entries(patch)) {
    const key = k as keyof ExercisePref;
    if (v === undefined) delete merged[key];
    // Object.entries has already erased which value type belongs to which
    // key, and ExercisePref's fields are no longer all numbers; the patch
    // parameter is what keeps this honest at every call site.
    else (merged as Record<string, unknown>)[key] = v;
  }
  // Re-choosing what is already chosen is not a change: no stamp, and no
  // queued write for every tap on an already-selected chip.
  if (samePref(all[exerciseId], merged)) return;
  commitExercisePref(
    exerciseId,
    Object.keys(merged).length === 0 ? null : merged,
  );
}

export function clearExercisePref(exerciseId: string): void {
  if (getSetting("exercisePrefs")[exerciseId] === undefined) return;
  commitExercisePref(exerciseId, null);
}

/**
 * Replace the whole per-exercise state at once: the sync layer's merge result
 * or an ownership change. Deliberately NOT a local write — no stamps are
 * invented and no subscriber is told, so a merge can never echo back to the
 * server as a fresh choice. A merged `barKg` is taken as stored and NOT
 * snapped to this device's bar inventory: it is a base weight, and a sled's
 * 34 kg is a legitimate value no bar list contains.
 */
export function replaceExercisePrefsState(
  prefs: ExercisePrefs,
  sync: ExercisePrefsSyncState,
): void {
  setSetting("exercisePrefs", prefs);
  setSetting("exercisePrefsSync", sync);
}

/**
 * Forget one override whose upload the server refused for good (the exercise is
 * gone or not visible to this person). Only if the device still holds the very
 * stamp that was refused: a newer local choice is a different write and stays.
 * Local only, no subscriber told.
 */
export function dropRefusedExercisePref(
  exerciseId: string,
  updatedAt: string,
): boolean {
  const sync = getSetting("exercisePrefsSync");
  const held = sync.stamps[exerciseId];
  if (held === undefined || Date.parse(held) !== Date.parse(updatedAt)) return false;
  const prefs = { ...getSetting("exercisePrefs") };
  delete prefs[exerciseId];
  const stamps = { ...sync.stamps };
  delete stamps[exerciseId];
  setSetting("exercisePrefs", prefs);
  setSetting("exercisePrefsSync", { ...sync, stamps });
  return true;
}

/**
 * Drop overrides for exercises that no longer exist. The map used to grow
 * forever; call this once the exercise library is loaded. Returns how many
 * entries went. Local only: the server row went with the exercise (its
 * foreign key cascades), and the stamp goes too so a row that does come back
 * is simply taken.
 */
export function pruneExercisePrefs(knownIds: readonly string[]): number {
  const known = new Set(knownIds);
  const all = getSetting("exercisePrefs");
  const next: ExercisePrefs = {};
  let dropped = 0;
  for (const [id, pref] of Object.entries(all)) {
    if (known.has(id)) next[id] = pref;
    else dropped += 1;
  }
  if (dropped > 0) {
    setSetting("exercisePrefs", next);
    const sync = getSetting("exercisePrefsSync");
    const stamps: Record<string, string> = {};
    for (const [id, s] of Object.entries(sync.stamps)) {
      if (known.has(id)) stamps[id] = s;
    }
    setSetting("exercisePrefsSync", { ...sync, stamps });
  }
  return dropped;
}

/**
 * The bar this exercise loads onto (kg; 0 = no bar). Falls back to the unit's
 * chosen bar for barbell movements and to "no bar" for everything else.
 */
export function getExerciseBarKg(
  exerciseId: string,
  u: Unit,
  equipment: string | null,
): number {
  const override = getExercisePref(exerciseId).barKg;
  if (override !== undefined) return override;
  return equipment === "barbell" ? getBarKg(u) : 0;
}

/**
 * Whether the base weight is a FACT rather than a guess. A barbell's bar comes
 * from the shared bar inventory, so it is always known; a machine's sled has
 * no default worth trusting (a leg press sled is not zero), so until somebody
 * sets one the picture asks instead of drawing an empty sled as truth.
 */
export function hasExerciseBase(
  exerciseId: string,
  equipment: string | null,
): boolean {
  return equipment === "barbell" || getExercisePref(exerciseId).barKg !== undefined;
}

/** kg value, or 0 for no bar; null clears the override */
export function setExerciseBarKg(exerciseId: string, kg: number | null): void {
  setExercisePref(exerciseId, { barKg: kg ?? undefined });
}

/**
 * Rest before the next set: the coach's bracket wins, then this movement's own
 * preference (a heavy squat wants four minutes, a lateral raise forty-five
 * seconds), then the global default.
 */
export function getExerciseRestSeconds(
  exerciseId: string | null,
  bracketRestSeconds: number | null,
): number {
  if (bracketRestSeconds !== null) return bracketRestSeconds;
  const own =
    exerciseId === null ? undefined : getExercisePref(exerciseId).restSeconds;
  return own ?? getDefaultRestSeconds();
}

/**
 * Coarse stepper increment for one movement. A per-exercise override replaces
 * the coarse step only — the fine step stays global, because it exists to nudge
 * whatever the coarse step landed on.
 */
export function getExerciseStepKg(
  exerciseId: string | null,
  u: Unit,
  fine: boolean,
): number {
  if (!fine && exerciseId !== null) {
    const own = getExercisePref(exerciseId).loadStepKg;
    if (own !== undefined) return own;
  }
  return getLoadStepKg(u, fine);
}

/**
 * How this movement's load is typed (per side vs the whole system). Only the
 * user's OWN choice lives here; the prescription and the equipment default are
 * resolved in lib/loadEntry.ts, which is the one place that chain exists.
 * null clears the override.
 */
export function setExerciseLoadEntry(
  exerciseId: string,
  entry: LoadEntry | null,
): void {
  setExercisePref(exerciseId, { loadEntry: entry ?? undefined });
}

/**
 * How this movement's load is PRESENTED: a bar-and-plates calculator or a
 * pin stack. Only the user's own choice lives here; the equipment/name
 * default is resolved in lib/loadStyle.ts, the one place that chain exists.
 */
export function getExerciseLoadStyle(
  exerciseId: string,
): LoadStyle | undefined {
  return getExercisePref(exerciseId).loadStyle;
}

/** undefined clears the override. */
export function setExerciseLoadStyle(
  exerciseId: string,
  style: LoadStyle | undefined,
): void {
  setExercisePref(exerciseId, { loadStyle: style });
}

// ---- display ---------------------------------------------------------------

/** 0 = Sunday … 6 = Saturday. Read this in format.ts's getWeekDates. */
export function getWeekStartsOn(): number {
  return getSetting("weekStartsOn");
}

// ---- first run -------------------------------------------------------------

/**
 * Whether the one-time card on an empty Today has been put away.
 *
 * Named rather than left to `getSetting("firstRunDismissed")` at the call
 * site so the pair below reads as one small API: the screen asks a question
 * and states a fact, and never has to know the key's spelling.
 */
export function getFirstRunDismissed(): boolean {
  return getSetting("firstRunDismissed");
}

/** One-way on purpose: nothing in the app un-dismisses it except a full
 *  settings reset. */
export function dismissFirstRun(): void {
  setSetting("firstRunDismissed", true);
}

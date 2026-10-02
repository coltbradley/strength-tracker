// The one shape every provider is flattened into before it reaches Postgres.
//
// Adapters do NOT write rows. They return this, and one place turns it into an
// insert. That is what keeps "add a third provider" from meaning "reread the
// dedup rule, the null handling and the column list and hope you matched them".

/** A row as `activities` wants it, minus the user and the bookkeeping. */
export interface NormalizedActivity {
  source: "intervals_icu" | "strava";
  external_id: string;
  sport: string;
  /** ISO 8601 with an offset. */
  started_at: string;
  elapsed_s: number;
  moving_s: number | null;
  distance_m: number | null;
  /** Null means the provider did not say, which is not the same as flat. */
  ascent_m: number | null;
  descent_m: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_power_w: number | null;
  avg_cadence: number | null;
  name: string | null;
}

/**
 * A number, or null.
 *
 * Providers are inconsistent about absent values: some omit the key, some send
 * null, some send 0, and some send a string. Only the first two are "unknown".
 * A 0 is kept as 0 because zero ascent on a track session is a real
 * measurement -- guessing that 0 means "unset" is how a flat week becomes an
 * unknown one, and this schema draws that distinction on purpose.
 */
export function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return n;
}

/** A non-negative number, or null. Negatives are provider noise, not data. */
export function nonNeg(v: unknown): number | null {
  const n = num(v);
  return n === null || n < 0 ? null : n;
}

/** An integer count of seconds, or null. */
export function secs(v: unknown): number | null {
  const n = nonNeg(v);
  return n === null ? null : Math.round(n);
}

/**
 * A heart rate the column will accept (20-250), or null.
 *
 * Clamping would be worse than dropping: a 300 bpm reading is a broken strap,
 * and recording it as 250 turns a sensor fault into a training fact.
 */
export function bpm(v: unknown): number | null {
  const n = num(v);
  if (n === null) return null;
  const r = Math.round(n);
  return r >= 20 && r <= 250 ? r : null;
}

/** Trimmed, length-capped, or null. The column allows 200. */
export function name(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 ? null : t.slice(0, 200);
}

/**
 * An ISO timestamp Postgres will accept, or null (which drops the activity:
 * an effort with no start time cannot be placed on a calendar or deduped).
 */
export function when(v: unknown): string | null {
  if (typeof v === "number") {
    const d = new Date(v * 1000);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Like `when`, but a string with no zone designator is read as UTC rather than
 * in whatever zone the runtime has, so the result never depends on the host.
 */
export function whenUtc(v: unknown): string | null {
  if (typeof v === "string" && !HAS_ZONE.test(v.trim())) {
    return when(`${v.trim()}Z`);
  }
  return when(v);
}

/**
 * intervals.icu start time (EDGE-2). `start_date_local` is the athlete's wall
 * clock with no zone, so reading it as UTC shifts the row by their offset and
 * the two-minute cross-source dedup never matches Strava's true-UTC
 * `start_date`. Prefer `start_date` (UTC, sent without a designator). Only when
 * it is absent do we fall back to the local string, stored as if UTC: the
 * athlete's zone is not in this payload, so that row stays offset until it is.
 */
export function intervalsStartedAt(a: Record<string, unknown>): string | null {
  return whenUtc(a.start_date) ?? whenUtc(a.start_date_local);
}

/**
 * The columns a re-read may refresh on a row already held (EDGE-4): every
 * measurement, and not `name`, which the owner may have edited (annotations
 * belong to the owner, measurements to the sync).
 */
export function measurementsOnly(
  r: NormalizedActivity,
): Omit<NormalizedActivity, "name"> {
  // deno-lint-ignore no-unused-vars
  const { name: _name, ...rest } = r;
  return rest;
}

/**
 * Where one provider's poll starts (EDGE-5): its OWN newest row minus the
 * overlap, so a newly connected or long-failing provider is not judged by
 * another source's progress. No rows of its own means a full backfill window.
 * Clamped to now so a future-dated row cannot halt polling.
 */
export function pollSince(
  newestIso: string | null,
  nowMs: number,
  overlapMs: number,
  backfillDays: number,
): Date {
  const newest = newestIso ? Date.parse(newestIso) : NaN;
  if (Number.isNaN(newest)) return new Date(nowMs - backfillDays * 86_400_000);
  return new Date(Math.min(newest, nowMs) - overlapMs);
}

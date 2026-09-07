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

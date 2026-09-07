// The two adapters. Each one fetches a page of activities and returns
// NormalizedActivity[]; neither knows that Postgres exists.
import {
  bpm,
  name,
  nonNeg,
  num,
  NormalizedActivity,
  secs,
  when,
} from "./normalize.ts";

export interface Fetched {
  activities: NormalizedActivity[];
  /** Provider-side identifier worth remembering (athlete id), or null. */
  externalId: string | null;
}

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** Everything after `since`, capped, oldest-first is not guaranteed. */
export interface FetchOpts {
  since: Date;
  limit: number;
}

// ---- intervals.icu ---------------------------------------------------------
//
// Chosen as the programmatic path over Strava's own API: one free instant key,
// activities plus streams plus a wellness endpoint, terms that explicitly allow
// commercial use, and it already carries whatever watch the athlete owns
// (Garmin, Polar, Suunto, Coros, Oura, Whoop). Garmin's own developer program
// is closed to new applicants as of 2026, so this is also the only practical
// route to a Garmin watch.
//
// Auth is HTTP Basic with the literal username "API_KEY" and the key as the
// password, which is unusual enough to be worth stating rather than looking
// like a typo.
export async function fetchIntervals(
  secret: Record<string, unknown>,
  opts: FetchOpts,
): Promise<Fetched> {
  const key = typeof secret.api_key === "string" ? secret.api_key : null;
  const athlete =
    typeof secret.athlete_id === "string" ? secret.athlete_id : "0";
  if (!key) {
    throw new ProviderError("intervals_icu", "no api_key in credentials", false);
  }
  const url =
    `https://intervals.icu/api/v1/athlete/${encodeURIComponent(athlete)}/activities` +
    `?oldest=${opts.since.toISOString().slice(0, 10)}&limit=${opts.limit}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Basic ${btoa(`API_KEY:${key}`)}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new ProviderError(
      "intervals_icu",
      `HTTP ${res.status}`,
      res.status === 429 || res.status >= 500,
    );
  }
  const body = (await res.json()) as unknown;
  const rows = Array.isArray(body) ? body : [];
  const activities: NormalizedActivity[] = [];
  for (const r of rows) {
    if (typeof r !== "object" || r === null) continue;
    const a = r as Record<string, unknown>;
    const startedAt = when(a.start_date_local ?? a.start_date);
    const elapsed = secs(a.elapsed_time);
    const id = a.id;
    if (!startedAt || elapsed === null || (typeof id !== "string" && typeof id !== "number")) {
      continue; // no start, no duration, or no id: not placeable, so not stored
    }
    activities.push({
      source: "intervals_icu",
      external_id: String(id),
      sport: typeof a.type === "string" ? a.type : "Workout",
      started_at: startedAt,
      elapsed_s: elapsed,
      moving_s: secs(a.moving_time),
      distance_m: nonNeg(a.distance),
      ascent_m: nonNeg(a.total_elevation_gain),
      // The field this whole table exists for. intervals.icu carries it;
      // if this comes back null across a whole backfill, say so loudly rather
      // than letting the descent rules quietly gate on nothing.
      descent_m: nonNeg(a.total_elevation_loss),
      avg_hr: bpm(a.average_heartrate),
      max_hr: bpm(a.max_heartrate),
      avg_power_w: nonNeg(a.icu_average_watts ?? a.average_watts),
      avg_cadence: nonNeg(a.average_cadence),
      name: name(a.name),
    });
  }
  return { activities, externalId: athlete === "0" ? null : athlete };
}

// ---- Strava ----------------------------------------------------------------
//
// Supported, and deliberately not the default. Read docs/endurance-research.md
// before enabling it: the 2026 Standard tier caps at about ten users, requires
// the DEVELOPER to hold a paid Strava subscription, allows roughly 100 reads
// per 15 minutes, bars use of the data in AI models, and belongs to the company
// that acquired Runna. None of that stops a personal deployment; all of it is
// the operator's call rather than this file's.
//
// Note what Strava's activity LIST does not include: heart rate. avg_hr comes
// back null here on purpose rather than costing one extra request per activity
// against a 100-per-15-minutes budget. The detail endpoint is E2's problem,
// when there is a reason to spend the call.
export async function fetchStrava(
  secret: Record<string, unknown>,
  opts: FetchOpts,
): Promise<Fetched> {
  const token = typeof secret.access_token === "string" ? secret.access_token : null;
  if (!token) {
    throw new ProviderError("strava", "no access_token in credentials", false);
  }
  const after = Math.floor(opts.since.getTime() / 1000);
  const url =
    `https://www.strava.com/api/v3/athlete/activities` +
    `?after=${after}&per_page=${Math.min(opts.limit, 200)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    // The refresh flow is not built: a 401 here means the operator must
    // re-authorise. Reported as non-retryable so the sweep does not spin.
    throw new ProviderError("strava", "token rejected; re-authorise", false);
  }
  if (!res.ok) {
    throw new ProviderError(
      "strava",
      `HTTP ${res.status}`,
      res.status === 429 || res.status >= 500,
    );
  }
  const body = (await res.json()) as unknown;
  const rows = Array.isArray(body) ? body : [];
  const activities: NormalizedActivity[] = [];
  for (const r of rows) {
    if (typeof r !== "object" || r === null) continue;
    const a = r as Record<string, unknown>;
    const startedAt = when(a.start_date);
    const elapsed = secs(a.elapsed_time);
    const id = a.id;
    if (!startedAt || elapsed === null || (typeof id !== "string" && typeof id !== "number")) {
      continue;
    }
    activities.push({
      source: "strava",
      external_id: String(id),
      sport: typeof a.sport_type === "string"
        ? a.sport_type
        : typeof a.type === "string"
          ? a.type
          : "Workout",
      started_at: startedAt,
      elapsed_s: elapsed,
      moving_s: secs(a.moving_time),
      distance_m: nonNeg(a.distance),
      ascent_m: nonNeg(a.total_elevation_gain),
      // Strava's list carries GAIN only. Descent is left unknown rather than
      // inferred from gain, which would be a fabricated number in the one
      // column this layer is built around. A Strava-only deployment therefore
      // cannot dose the eccentric block, and that is a real limitation to know
      // about rather than paper over.
      descent_m: null,
      avg_hr: bpm(a.average_heartrate),
      max_hr: bpm(a.max_heartrate),
      avg_power_w: nonNeg(a.average_watts),
      avg_cadence: nonNeg(a.average_cadence),
      name: name(a.name),
    });
  }
  return { activities, externalId: null };
}

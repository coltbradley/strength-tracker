// Reads for check-ins and injuries, online first with a device cache.
//
// Same conventions as sessionHistory.ts, for the same reason: literal cache
// keys in no invalidation family. `fetchWithCache` is online-first, so a stale
// entry is only read when the network is unreachable, and at that moment the
// writes that would stale it are still in the outbox, which the callers merge
// in (checkins.ts `mergeCheckins`, `withPending`).
import { supabase } from "./supabase";
import { cacheGet, cacheSet } from "./db";
import { parseLocalDate, todayLocalIso } from "./format";
import type { CheckinRow, InjuryState } from "./types";

const KEY_INJURIES = "injuries";
const keyWeekCheckins = (weekStart: string) => `checkinWeek:${weekStart}`;
const keyWeekBuckets = (weekStart: string) => `checkinBuckets:${weekStart}`;

async function fetchWithCache<T>(
  key: string,
  fetcher: () => Promise<T>,
): Promise<{ data: T; fromCache: boolean }> {
  try {
    const data = await fetcher();
    await cacheSet(key, data);
    return { data, fromCache: false };
  } catch (e) {
    const cached = await cacheGet<T>(key);
    if (cached !== undefined) return { data: cached, fromCache: true };
    throw e;
  }
}

function throwIf(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

export function addDaysIso(iso: string, n: number): string {
  const d = parseLocalDate(iso);
  return todayLocalIso(
    new Date(d.getFullYear(), d.getMonth(), d.getDate() + n),
  );
}

/** The device-local calendar date of an instant. */
export function localDateOf(iso: string): string {
  return todayLocalIso(new Date(iso));
}

/** Every injury episode with its check-in history summary, all states. */
export async function getInjuries(): Promise<{
  data: InjuryState[];
  fromCache: boolean;
}> {
  return fetchWithCache(KEY_INJURIES, async () => {
    const { data, error } = await supabase
      .from("v_injury_state")
      .select(
        "episode_id, body_region, side, opened_on, closed_on, last_reported_at, last_reported_on, reports, state",
      )
      .order("opened_on", { ascending: false });
    throwIf(error);
    return ((data ?? []) as InjuryState[]).map((r) => ({
      ...r,
      reports: Number(r.reports),
    }));
  });
}

/** Check-ins from device-local Monday 00:00 to the next Monday, oldest first. */
export async function getWeekCheckins(
  weekStart: string,
): Promise<{ data: CheckinRow[]; fromCache: boolean }> {
  return fetchWithCache(keyWeekCheckins(weekStart), async () => {
    const from = parseLocalDate(weekStart).toISOString();
    const to = parseLocalDate(addDaysIso(weekStart, 7)).toISOString();
    const { data, error } = await supabase
      .from("checkins")
      .select(
        "id, recorded_at, note, energy, tags, training_impact, episode_id",
      )
      .gte("recorded_at", from)
      .lt("recorded_at", to)
      .order("recorded_at", { ascending: true });
    throwIf(error);
    return (data ?? []) as CheckinRow[];
  });
}

export interface BucketRow {
  local_date: string;
  bucket: "morning" | "midday" | "evening";
  checkins: number;
  energy_n: number;
  energy_mean: number | null;
}

/** v_checkin_buckets for the seven days from weekStart. */
export async function getWeekBuckets(
  weekStart: string,
): Promise<{ data: BucketRow[]; fromCache: boolean }> {
  return fetchWithCache(keyWeekBuckets(weekStart), async () => {
    const { data, error } = await supabase
      .from("v_checkin_buckets")
      .select("local_date, bucket, checkins, energy_n, energy_mean")
      .gte("local_date", weekStart)
      .lte("local_date", addDaysIso(weekStart, 6));
    throwIf(error);
    // numerics arrive as strings over PostgREST often enough to coerce them
    return ((data ?? []) as BucketRow[]).map((r) => ({
      ...r,
      checkins: Number(r.checkins),
      energy_n: Number(r.energy_n),
      energy_mean: r.energy_mean === null ? null : Number(r.energy_mean),
    }));
  });
}

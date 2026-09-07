// Reading and writing the subjective layer (E1).
//
// Everything here is OPTIONAL by construction. `saveReadiness` accepts a panel
// with one field answered or none, because a panel somebody must complete is a
// panel somebody stops opening -- and the views carry per-item counts so a
// half-filled row is never mistaken for a full one.
//
// Writes go through the outbox, like sets: a morning panel answered on a train
// should not be lost. They ride the same queue, which is safe in the one
// direction that matters -- the flusher dead-letters a failing item and keeps
// going, so a broken check-in cannot hold up somebody's sets.
import { supabase } from "./supabase";
import { throwIf } from "./data";
import type {
  CheckinInsert,
  DailyReadinessUpsert,
  PainCheckInsert,
} from "./types";

/** The six items the daily panel trends. All optional. */
export interface ReadinessPanel {
  sleep_hours?: number | null;
  sleep_quality?: number | null;
  fatigue?: number | null;
  soreness?: number | null;
  stress?: number | null;
  mood?: number | null;
  bodyweight_kg?: number | null;
  resting_hr?: number | null;
  illness?: boolean | null;
  alcohol_units?: number | null;
  travel?: boolean | null;
  note?: string | null;
  custom?: Record<string, unknown>;
}

export interface ReadinessRow extends ReadinessPanel {
  id: string;
  local_date: string;
  recorded_at: string;
}

/**
 * How many of the six core items this panel answered.
 *
 * Zero is a legal and meaningful answer: somebody opened the sheet and had
 * nothing to say, which is not the same as never opening it, and only one of
 * those is a gap in the series.
 */
export function answeredItems(p: ReadinessPanel): number {
  const core: (keyof ReadinessPanel)[] = [
    "sleep_hours",
    "sleep_quality",
    "fatigue",
    "soreness",
    "stress",
    "mood",
  ];
  return core.filter((k) => p[k] !== null && p[k] !== undefined).length;
}

/**
 * Today's panel, if one exists.
 *
 * Read FIRST so a correction reuses the row's id and merges onto it rather
 * than colliding with `unique (user_id, local_date)`. Returns null when there
 * is none and when the read fails: the sheet opens blank either way, and an
 * unanswered panel is the safe thing to show. A failed read that silently
 * became "no panel today" would at worst re-ask a question, which is a much
 * smaller cost than refusing to open.
 */
export async function getReadinessFor(
  userId: string,
  localDate: string,
): Promise<ReadinessRow | null> {
  const { data, error } = await supabase
    .from("daily_readiness")
    .select(
      "id, local_date, recorded_at, sleep_hours, sleep_quality, fatigue, soreness, stress, mood, bodyweight_kg, resting_hr, illness, alcohol_units, travel, note, custom",
    )
    .eq("user_id", userId)
    .eq("local_date", localDate)
    .maybeSingle();
  if (error) return null;
  return (data as ReadinessRow | null) ?? null;
}

/**
 * Build the row to queue for a panel.
 *
 * Split out from the enqueue so it can be tested without a database: the part
 * worth pinning is that an absent field stays absent rather than becoming 0,
 * and that `id` is whatever the caller found, so a correction merges.
 */
export function readinessRow(
  id: string,
  userId: string,
  localDate: string,
  panel: ReadinessPanel,
  now: string,
): DailyReadinessUpsert {
  const row: DailyReadinessUpsert = {
    id,
    user_id: userId,
    local_date: localDate,
    recorded_at: now,
  };
  // Only what was actually answered. Writing `sleep_hours: 0` for an unanswered
  // question is the exact confusion the schema draws a line through: null is
  // unknown and zero is a measurement.
  for (const [k, v] of Object.entries(panel)) {
    if (v === undefined) continue;
    (row as unknown as Record<string, unknown>)[k] = v;
  }
  return row;
}

/**
 * A recorded SKIP.
 *
 * "Not today" has to leave a trace or the button is decoration: duePrompts
 * honours a skip and stops asking, and report_prompts is the denominator that
 * says whether prompting is working at all. Written as an in_app prompt that
 * was offered and declined, which is exactly what happened.
 *
 * Distinct from an unanswered panel. That is silence; this is an answer to the
 * question "shall I ask you this now", and only one of them should stop the
 * asking.
 */
export function skipRow(
  id: string,
  userId: string,
  kind: "daily_readiness" | "ostrc_weekly" | "next_morning_pain",
  now: string,
): {
  id: string;
  user_id: string;
  kind: string;
  scheduled_for: string;
  channel: string;
  skipped: boolean;
} {
  return {
    id,
    user_id: userId,
    kind,
    scheduled_for: now,
    channel: "in_app",
    skipped: true,
  };
}

export function checkinRow(
  id: string,
  userId: string,
  kind: CheckinInsert["kind"],
  fields: Omit<CheckinInsert, "id" | "user_id" | "kind">,
  now: string,
): CheckinInsert {
  return { id, user_id: userId, kind, recorded_at: now, ...fields };
}

export function painCheckRow(
  id: string,
  userId: string,
  phase: PainCheckInsert["phase"],
  nrs: number,
  fields: Partial<Pick<PainCheckInsert, "episode_id" | "session_id" | "activity_id">>,
  now: string,
): PainCheckInsert {
  return {
    id,
    user_id: userId,
    phase,
    nrs_0_10: nrs,
    captured_at: now,
    ...fields,
  };
}

export interface EpisodeState {
  episode_id: string;
  body_region: string;
  side: string | null;
  latest_severity: number | null;
  consecutive_weeks: number;
  persistent: boolean;
  latest_is_substantial: boolean | null;
}

/** Open symptom episodes, for the context block and the check-in sheet. */
export async function getOpenEpisodes(userId: string): Promise<EpisodeState[]> {
  const { data, error } = await supabase
    .from("v_symptom_episode_state")
    .select(
      "episode_id, body_region, side, latest_severity, consecutive_weeks, persistent, latest_is_substantial",
    )
    .eq("user_id", userId)
    .eq("is_open", true)
    .order("consecutive_weeks", { ascending: false });
  throwIf(error);
  return (data ?? []) as EpisodeState[];
}

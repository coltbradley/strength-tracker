// Check-ins: what someone says about how they feel, whenever they want to.
//
// Pure. No network, no IndexedDB, no clock: the caller passes `now`, `today`
// and the outbox entries, so every rule here is testable on its own. Reads
// with a cache live in checkinHistory.ts; the sheet wires the two together.
//
// Three inputs, all optional: a note, tags, energy 1-5. Every check-in is its
// own timestamped row and nothing overwrites. A pain check-in files against an
// injury episode so "the same knee, three weeks running" is answerable.
import type { OutboxEntry } from "./outbox";
import type { OutboxOp } from "./db";
import type {
  CheckinInsert,
  CheckinRow,
  CheckinTag,
  EpisodeSide,
  InjuryState,
  SymptomEpisodeInsert,
  TrainingImpact,
} from "./types";

/** The database CHECK decides what is legal; this list decides the order and
 *  the words. "Great" exists so a good day is visible, not only a bad one.
 *  "Unusually sore" so normal soreness after lifting doesn't mark a good
 *  training day as a bad one. */
export const CHECKIN_TAGS: readonly { value: CheckinTag; label: string }[] = [
  { value: "great", label: "Great" },
  { value: "slept_badly", label: "Slept badly" },
  { value: "unusually_sore", label: "Unusually sore" },
  { value: "stressed", label: "Stressed" },
  { value: "sick", label: "Sick" },
  { value: "pain", label: "Pain" },
];

/** A short fixed list so an episode can be MATCHED: free text would turn
 *  "left knee" and "L knee" into two injuries. */
export const BODY_REGIONS = [
  "Knee",
  "Ankle",
  "Shin",
  "Foot",
  "Hip",
  "Thigh",
  "Lower back",
  "Upper back",
  "Shoulder",
  "Elbow",
  "Wrist/hand",
  "Neck",
  "Other",
] as const;

export const SIDE_CHOICES: readonly {
  value: Exclude<EpisodeSide, "n/a">;
  label: string;
}[] = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "bilateral", label: "Both" },
];

export const IMPACT_CHOICES: readonly {
  value: TrainingImpact;
  label: string;
}[] = [
  { value: "none", label: "No" },
  { value: "modified", label: "Modified" },
  { value: "stopped", label: "Stopped" },
];

export interface PainAnswer {
  /** A BODY_REGIONS entry, or an older episode's own region text. */
  region: string | null;
  side: Exclude<EpisodeSide, "n/a"> | null;
  impact: TrainingImpact | null;
}

export const EMPTY_PAIN: PainAnswer = {
  region: null,
  side: null,
  impact: null,
};

export interface CheckinDraft {
  note: string;
  tags: CheckinTag[];
  energy: number | null;
  pain: PainAnswer;
}

export function tagLabel(tag: CheckinTag): string {
  return CHECKIN_TAGS.find((t) => t.value === tag)?.label ?? tag;
}

export function impactLabel(impact: TrainingImpact): string {
  return IMPACT_CHOICES.find((c) => c.value === impact)?.label ?? impact;
}

/** Nothing is required; a check-in with nothing in it records nothing. */
export function canSubmit(d: CheckinDraft): boolean {
  return d.note.trim().length > 0 || d.tags.length > 0 || d.energy !== null;
}

/** Toggle one tag, keeping CHECKIN_TAGS order so rows compare cleanly. */
export function toggleTag(
  tags: readonly CheckinTag[],
  tag: CheckinTag,
): CheckinTag[] {
  const on = new Set(tags);
  if (on.has(tag)) on.delete(tag);
  else on.add(tag);
  return CHECKIN_TAGS.map((t) => t.value).filter((v) => on.has(v));
}

export function episodeSide(side: PainAnswer["side"]): EpisodeSide {
  return side ?? "n/a";
}

/** "left knee", "knee (both sides)", "knee". */
export function injuryLabel(
  e: Pick<InjuryState, "body_region" | "side">,
): string {
  const region = e.body_region.toLowerCase();
  if (e.side === "left" || e.side === "right") return `${e.side} ${region}`;
  if (e.side === "bilateral") return `${region} (both sides)`;
  return region;
}

/** The open episode a pain answer belongs to: exact region and side, the most
 *  recently opened when several match. */
export function matchEpisode(
  injuries: readonly InjuryState[],
  region: string,
  side: EpisodeSide,
): InjuryState | null {
  const hits = injuries
    .filter(
      (e) =>
        e.closed_on === null &&
        e.body_region === region &&
        (e.side ?? "n/a") === side,
    )
    .sort((a, b) => b.opened_on.localeCompare(a.opened_on));
  return hits[0] ?? null;
}

/** Open episodes worth asking "still there?" about today: last reported (or,
 *  never reported, opened) on an earlier day. At most three, most recent
 *  first. */
export function stillThere(
  injuries: readonly InjuryState[],
  today: string,
): InjuryState[] {
  const lastDay = (e: InjuryState) => e.last_reported_on ?? e.opened_on;
  return injuries
    .filter((e) => e.closed_on === null && lastDay(e) < today)
    .sort((a, b) => lastDay(b).localeCompare(lastDay(a)))
    .slice(0, 3);
}

export interface CheckinContext {
  userId: string;
  /** ISO instant, the check-in's recorded_at */
  now: string;
  /** device-local YYYY-MM-DD, a new episode's opened_on */
  today: string;
  injuries: readonly InjuryState[];
  newId: () => string;
}

/** The queued writes for one check-in, in replay order. */
export function buildCheckinOps(
  d: CheckinDraft,
  ctx: CheckinContext,
): OutboxOp[] {
  const ops: OutboxOp[] = [];
  const painOn = d.tags.includes("pain");
  let episodeId: string | null = null;

  if (painOn && d.pain.region !== null) {
    const side = episodeSide(d.pain.side);
    const match = matchEpisode(ctx.injuries, d.pain.region, side);
    if (match) {
      episodeId = match.episode_id;
    } else {
      const payload: SymptomEpisodeInsert = {
        id: ctx.newId(),
        user_id: ctx.userId,
        body_region: d.pain.region,
        side,
        opened_on: ctx.today,
      };
      ops.push({ kind: "insert", table: "symptom_episodes", payload });
      episodeId = payload.id;
    }
  }

  const note = d.note.trim();
  // Every column on every row: a bulk insert fills a missing key with NULL.
  const payload: CheckinInsert = {
    id: ctx.newId(),
    user_id: ctx.userId,
    kind: "spontaneous",
    recorded_at: ctx.now,
    note: note.length > 0 ? note : null,
    energy: d.energy,
    feeling: null,
    tags: [...d.tags],
    episode_id: painOn ? episodeId : null,
    training_impact: painOn ? d.pain.impact : null,
    session_id: null,
    activity_id: null,
  };
  ops.push({ kind: "insert", table: "checkins", payload });
  return ops;
}

export function closeEpisodeOp(episodeId: string, today: string): OutboxOp {
  return {
    kind: "update",
    table: "symptom_episodes",
    id: episodeId,
    patch: { closed_on: today },
  };
}

/** This user's queued check-ins. Another account's items are held by the
 *  outbox and must not appear on this person's screen either. */
export function pendingCheckins(
  entries: readonly OutboxEntry[],
  userId: string,
): CheckinRow[] {
  const out: CheckinRow[] = [];
  for (const e of entries) {
    if (e.user_id !== userId) continue;
    if (e.op.kind !== "insert" || e.op.table !== "checkins") continue;
    const p = e.op.payload;
    out.push({
      id: p.id,
      recorded_at: p.recorded_at,
      note: p.note ?? null,
      energy: p.energy ?? null,
      tags: p.tags ?? [],
      training_impact: p.training_impact ?? null,
      episode_id: p.episode_id ?? null,
    });
  }
  return out;
}

/** Server rows plus queued rows, one per id, oldest first. */
export function mergeCheckins(
  server: readonly CheckinRow[],
  pending: readonly CheckinRow[],
): CheckinRow[] {
  const byId = new Map<string, CheckinRow>();
  for (const r of [...server, ...pending]) {
    if (!byId.has(r.id)) byId.set(r.id, r);
  }
  return [...byId.values()].sort((a, b) =>
    a.recorded_at.localeCompare(b.recorded_at),
  );
}

/** The server's injuries as this device will see them once its queue lands:
 *  queued episodes added, queued pain reports moving last_reported_on, queued
 *  closes applied. Keeps "still there?" from re-asking about a knee someone
 *  answered offline an hour ago. */
export function withPending(
  injuries: readonly InjuryState[],
  entries: readonly OutboxEntry[],
  userId: string,
  localDateOf: (iso: string) => string,
): InjuryState[] {
  const byId = new Map(injuries.map((e) => [e.episode_id, { ...e }]));
  for (const e of entries) {
    if (e.user_id !== userId) continue;
    const op = e.op;
    if (op.kind === "insert" && op.table === "symptom_episodes") {
      if (!byId.has(op.payload.id)) {
        byId.set(op.payload.id, {
          episode_id: op.payload.id,
          body_region: op.payload.body_region,
          side: op.payload.side,
          opened_on: op.payload.opened_on,
          closed_on: null,
          last_reported_at: null,
          last_reported_on: null,
          reports: 0,
          state: "active",
        });
      }
    }
  }
  for (const e of entries) {
    if (e.user_id !== userId) continue;
    const op = e.op;
    if (
      op.kind === "insert" &&
      op.table === "checkins" &&
      op.payload.episode_id
    ) {
      const ep = byId.get(op.payload.episode_id);
      if (
        ep &&
        (ep.last_reported_at === null ||
          ep.last_reported_at < op.payload.recorded_at)
      ) {
        ep.last_reported_at = op.payload.recorded_at;
        ep.last_reported_on = localDateOf(op.payload.recorded_at);
        ep.reports += 1;
      }
    }
    if (op.kind === "update" && op.table === "symptom_episodes") {
      const ep = byId.get(op.id);
      if (ep) {
        ep.closed_on = op.patch.closed_on;
        ep.state = "closed";
      }
    }
  }
  return [...byId.values()];
}

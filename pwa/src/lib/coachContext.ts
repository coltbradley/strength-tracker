// What the coach knows before it asks anything.
//
// Without this, every question costs a tool round trip before the model can
// say a word — and mid-set, that round trip is the whole latency budget. Worse,
// "should I drop the last set?" is unanswerable without knowing which set they
// are on, and a model that has to go looking may just answer generically
// instead.
//
// So the app hands over the state it already has in memory: what is scheduled,
// what is running, what has been logged so far today. The tools remain the way
// to reach anything deeper (history, trends, other weeks) — this is the
// equivalent of glancing at their phone screen before answering.
//
// Sent with EVERY turn rather than once, because it goes stale the moment they
// log another set, which is exactly when they are most likely to ask.
//
// THE WEEK IS HERE TOO, one line per day. Today alone was not enough: in a
// real user's 13-turn transcript every single turn opened with get_program,
// because on a rest day the block said almost nothing and the model's only
// move was a lookup. The week lines answer "what's on Thursday" outright and
// carry each day's id, which is the one thing update_planned_workout needs and
// the only reason left to call get_program before editing a day.

import { cacheGet, cacheKeys } from "./db";
import { supabase } from "./supabase";
import { getUnit, getWeekStartsOn } from "./settings";
import { toDisplay, type Unit } from "./units";
import { parseLocalDate, todayLocalIso, workoutName } from "./format";
import { weekDates } from "./calendar";
import type {
  ActiveSession,
  PlannedWorkoutRow,
  ResolvedPrescriptionRow,
  SetInsert,
} from "./types";

function load(kg: number | null, unit: Unit): string {
  if (kg === null) return "by feel";
  return `${toDisplay(kg, unit)} ${unit}`;
}

/** The plan as the app caches it. Only the program ids are needed here. */
interface CachedPlan {
  programs: { id: string }[];
  workouts: PlannedWorkoutRow[];
}

/** How many of a day's exercises a week line names before it stops counting. */
const WEEK_NAME_CAP = 10;

/** "Mon", for the week lines. A date alone makes the reader do arithmetic. */
function weekdayShort(iso: string): string {
  return parseLocalDate(iso).toLocaleDateString("en-GB", { weekday: "short" });
}

/**
 * What a planned day IS, in one word.
 *
 * Same order of branches as the Today screen's `workoutStates`, deliberately:
 * this block's whole claim is that it says what is on their screen. DONE and
 * SKIPPED first because they are facts about what happened; DRAFT ahead of
 * every date check because a day with nothing programmed into it was never a
 * workout anyone missed, and calling it MISSED accuses them of skipping a
 * session nobody ever wrote (CLAUDE.md). It is not shared code with Today.tsx.
 * (Today.tsx also resolves undated DAY 1..N programs, which cannot reach here
 * because every row on these lines was selected BY its date.)
 *
 * `done` is null when this device could not find out. A past day is then PAST
 * rather than MISSED: "you skipped this" is not a thing to guess at.
 */
export function weekDayState(
  w: PlannedWorkoutRow,
  done: Set<string> | null,
  today: string,
): string {
  if (done?.has(w.id)) return "DONE";
  if (w.skipped_at !== null) return "SKIPPED";
  if (w.exercise_count === 0) return "DRAFT";
  if (w.scheduled_date === today) return "TODAY";
  if ((w.scheduled_date ?? "") < today)
    return done === null ? "PAST" : "MISSED";
  return "UPCOMING";
}

/**
 * The week, one dense line per day.
 *
 * WHAT THIS TRADES. Every turn pays for these lines, so they carry names and
 * nothing else: no sets, reps, loads, supersets or sections, which is what
 * today's own detail block above already spends its tokens on. Restating a
 * whole week of prescriptions would cost four or five times as much on every
 * turn to answer a question asked once, so "what's on Thursday" is free and a
 * faithful rewrite of Thursday still reads the day first. The day's id rides
 * along because it is cheap, unguessable, and the only thing that forced a
 * get_program before an edit.
 *
 * Fields are separated by "|", which is NOT a delimiter an exercise name can
 * close from the inside. Names are cross-user input (whoever added the
 * movement wrote it), but exercises.name is bounded to single-line printable
 * text by a CHECK, so no name can break the one-line-per-day shape; the worst
 * a hostile one manages is a stray "|" inside its own field.
 */
export function formatWeek(a: {
  days: string[];
  workouts: PlannedWorkoutRow[];
  names: Map<string, string[]>;
  done: Set<string> | null;
  today: string;
}): string[] {
  const span = `${a.days[0]} to ${a.days[a.days.length - 1]}`;
  if (a.workouts.length === 0) {
    return [`\nTHIS WEEK (${span}): nothing is planned on any day.`];
  }
  const lines = [`\nTHIS WEEK (${span}), one line per day:`];
  for (const iso of a.days) {
    const onDay = a.workouts.filter((w) => w.scheduled_date === iso);
    if (onDay.length === 0) {
      lines.push(`  ${weekdayShort(iso)} ${iso} | nothing scheduled`);
      continue;
    }
    for (const w of onDay) {
      const names = a.names.get(w.id) ?? [];
      const shown = names.slice(0, WEEK_NAME_CAP).join(", ");
      const more =
        names.length > WEEK_NAME_CAP
          ? `, +${names.length - WEEK_NAME_CAP} more`
          : "";
      // Three different ways a day can have no names, and they mean different
      // things: nothing is programmed yet (a draft), or the count says there
      // is something but this device could not read what.
      const body =
        w.exercise_count === 0
          ? "no exercises yet"
          : names.length === 0
            ? `${w.exercise_count} exercises (names unread)`
            : shown + more;
      lines.push(
        `  ${weekdayShort(iso)} ${iso} | ${weekDayState(w, a.done, a.today)} | ` +
          `${workoutName(w)} | ${body} | id ${w.id}`,
      );
    }
  }
  if (a.done === null) {
    lines.push(
      "  (Could not check which days are finished, so none is marked DONE " +
        "or MISSED.)",
    );
  }
  return lines;
}

/**
 * Exercise names for the week's days, in the order they are performed.
 *
 * A read rather than a cache hit: Today loads prescriptions lazily, so the
 * only day reliably cached is the one they last opened. One query for the
 * whole week is the cheap shape, and it runs alongside the memory read above.
 *
 * Consecutive repeats collapse. Three rows of Barbell Squat in a row are a
 * ramp, which the plan renders as one entry, and listing it three times spends
 * tokens saying less.
 */
async function weekExerciseNames(
  ids: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (ids.length === 0) return map;
  const add = (id: string, name: string) => {
    const list = map.get(id) ?? [];
    if (list[list.length - 1] !== name) list.push(name);
    map.set(id, list);
  };
  try {
    const { data, error } = await supabase
      .from("v_resolved_prescriptions")
      .select("planned_workout_id,exercise_name,position")
      .in("planned_workout_id", ids)
      .order("position");
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as {
      planned_workout_id: string;
      exercise_name: string;
    }[]) {
      add(r.planned_workout_id, r.exercise_name);
    }
  } catch {
    // Offline: whatever days this device has actually opened are still here,
    // and a week with three days named beats a week with none.
    for (const id of ids) {
      const rx = await cacheGet<ResolvedPrescriptionRow[]>(
        cacheKeys.prescriptions(id),
      );
      for (const r of rx ?? []) add(id, r.exercise_name);
    }
  }
  return map;
}

/**
 * Which of the week's days have a FINISHED session against them.
 *
 * `ended_at is not null` is load-bearing and matches getDoneWorkoutIds: an
 * open session must never mark its day done, or the week reads as finished
 * while they are still lifting.
 *
 * Returns null when it could not be answered at all, which the week lines
 * render as PAST rather than inventing a verdict.
 */
async function finishedWorkoutIds(
  ids: string[],
  programIds: string[],
): Promise<Set<string> | null> {
  if (ids.length === 0) return new Set();
  try {
    const { data, error } = await supabase
      .from("sessions")
      .select("planned_workout_id")
      .is("discarded_at", null)
      .not("ended_at", "is", null)
      .in("planned_workout_id", ids);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { planned_workout_id: string | null }[];
    return new Set(
      rows
        .map((r) => r.planned_workout_id)
        .filter((id): id is string => id !== null),
    );
  } catch {
    // The Today screen caches exactly this, per program, and it is warm
    // whenever the week strip has rendered.
    const cached = new Set<string>();
    let answered = false;
    for (const p of programIds) {
      const list = await cacheGet<string[]>(cacheKeys.doneWorkouts(p));
      if (list === undefined) continue;
      answered = true;
      for (const id of list) cached.add(id);
    }
    return answered ? cached : null;
  }
}

/**
 * Standing facts about this lifter. Empty rather than throwing: answering with
 * less beats not answering.
 */
async function standingFacts(): Promise<{ kind: string; fact: string }[]> {
  try {
    const { data } = await supabase
      .from("coach_memory")
      .select("kind, fact")
      .order("kind");
    return (data ?? []) as { kind: string; fact: string }[];
  } catch {
    return [];
  }
}

/**
 * A compact, human-readable snapshot. Deliberately prose-ish rather than JSON:
 * it is read by a model, and the tool results it will fetch are already JSON,
 * so this reads as "what the screen says" instead of a second data format.
 */
export async function buildCoachContext(): Promise<string> {
  const unit = getUnit();
  const lines: string[] = [];
  const today = todayLocalIso();

  lines.push(`Today is ${today}. Weights below are shown in ${unit}.`);

  // Standing facts, first, before anything about today. They arrive here
  // rather than through a tool because memory that has to be fetched is memory
  // that gets forgotten — and the whole point is that the lifter stops having
  // to re-explain their shoulder.
  //
  // Started before the plan is read and awaited after, so the week's two
  // queries overlap it rather than queueing behind it. Nothing in this block
  // depends on another part of it, and the person is waiting.
  const memory = standingFacts();

  // The plan comes from the device cache (instant, and correct offline); the
  // week's names and completions are reads, kicked off here for the same
  // reason as the memory query.
  let plan: CachedPlan | null = null;
  let planFailed = false;
  try {
    plan = (await cacheGet<CachedPlan>(cacheKeys.plannedWorkouts)) ?? null;
  } catch {
    planFailed = true;
  }
  const days = weekDates(today, getWeekStartsOn());
  const thisWeek = (plan?.workouts ?? []).filter(
    (w) => w.scheduled_date !== null && days.includes(w.scheduled_date),
  );
  const weekIds = thisWeek.map((w) => w.id);
  const weekFacts = Promise.all([
    weekExerciseNames(weekIds),
    finishedWorkoutIds(
      weekIds,
      (plan?.programs ?? []).map((p) => p.id),
    ),
  ]);

  const facts = await memory;
  if (facts.length > 0) {
    lines.push("\nWHAT YOU ALREADY KNOW ABOUT THEM:");
    for (const m of facts) lines.push(`  - [${m.kind}] ${m.fact}`);
    lines.push(
      "  (Use `remember` when they tell you something standing and new, " +
        "and `forget` when one of these stops being true.)",
    );
  }

  try {
    const active = await cacheGet<ActiveSession>(cacheKeys.activeSession);
    if (active?.id) {
      const sets =
        (await cacheGet<SetInsert[]>(cacheKeys.sessionSets(active.id))) ?? [];
      lines.push(
        `\nA SESSION IS IN PROGRESS (${active.workout_label ?? "unplanned"}), ` +
          `started ${active.started_at}.`,
      );
      if (active.coach_note) lines.push(`Coach's note: ${active.coach_note}`);
      if (active.plan_note) lines.push(`Their own note: ${active.plan_note}`);
      if (sets.length === 0) {
        lines.push("No sets logged in it yet.");
      } else {
        lines.push(`${sets.length} sets logged so far, most recent last:`);
        for (const s of sets.slice(-12)) {
          lines.push(
            `  - ${s.exercise_id}: ${load(s.load_kg ?? null, unit)} x ${s.reps} (${s.set_type})`,
          );
        }
      }
    } else {
      lines.push("\nNo session is running right now.");
    }
  } catch {
    lines.push("\n(Could not read the current session from this device.)");
  }

  if (planFailed) {
    lines.push("\n(Could not read the plan from this device.)");
  } else {
    try {
      const todays = thisWeek.filter(
        (w) => w.scheduled_date === today && w.skipped_at === null,
      );
      if (todays.length === 0) {
        lines.push("\nNothing is scheduled for today.");
      } else {
        for (const w of todays) {
          lines.push(`\nSCHEDULED TODAY: ${workoutName(w)}`);
          if (w.notes) lines.push(`Coach's note: ${w.notes}`);
          if (w.plan_note) lines.push(`Their own note: ${w.plan_note}`);
          const rx =
            (await cacheGet<ResolvedPrescriptionRow[]>(
              cacheKeys.prescriptions(w.id),
            )) ?? [];
          for (const r of rx) {
            const target =
              r.load_pct_tm !== null
                ? `${r.load_pct_tm}% TM`
                : load(r.load_kg ?? r.resolved_load_kg ?? null, unit);
            lines.push(
              `  - ${r.exercise_name}: ${r.sets}x${r.reps_min === r.reps_max ? r.reps_min : `${r.reps_min}-${r.reps_max}`} @ ${target}` +
                `${r.set_type && r.set_type !== "working" ? ` [${r.set_type}]` : ""}` +
                `${r.superset_group !== null ? ` [superset ${String.fromCharCode(64 + r.superset_group)}]` : ""}` +
                `${r.notes ? ` — ${r.notes}` : ""}`,
            );
          }
        }
      }
    } catch {
      lines.push("\n(Could not read today's plan from this device.)");
    }

    // Today's day appears on its own line here as well as in full above. The
    // duplication is a few tokens; a gap in the week would read as a rest day.
    const [names, done] = await weekFacts;
    for (const line of formatWeek({
      days,
      workouts: thisWeek,
      names,
      done,
      today,
    })) {
      lines.push(line);
    }
  }

  lines.push(
    "\nThis is what the app has on their phone right now: today in full, and " +
      "this week a line at a time. Use your tools for history, trends, days " +
      "outside this week, or anything you are unsure of.",
  );
  return lines.join("\n");
}

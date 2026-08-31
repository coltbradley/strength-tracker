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
// to reach anything deeper (history, trends, other days) — this is the
// equivalent of glancing at their phone screen before answering.
//
// Sent with EVERY turn rather than once, because it goes stale the moment they
// log another set, which is exactly when they are most likely to ask.

import { cacheGet, cacheKeys } from "./db";
import { getUnit } from "./settings";
import { toDisplay, type Unit } from "./units";
import { todayLocalIso, workoutName } from "./format";
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

  try {
    const plan = await cacheGet<{
      programs: unknown[];
      workouts: PlannedWorkoutRow[];
    }>(cacheKeys.plannedWorkouts);
    const todays = (plan?.workouts ?? []).filter(
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

  lines.push(
    "\nThis is what the app has cached on their phone right now. It covers " +
      "today only — use your tools for history, trends, other days, or " +
      "anything you are unsure of.",
  );
  return lines.join("\n");
}

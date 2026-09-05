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
import { getTrainingPlan, type TrainingPlanRead } from "./data";
import { supabase } from "./supabase";
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
 * The plan paragraph: the strategy above programs, in about 80 words, ALWAYS
 * present. This is what makes the plan something the coach builds AGAINST
 * rather than a document it could look up — the design doc's phrase, and the
 * reason the current phase's focus, progression and id all ride along: the
 * coach checks each day it writes against the first two and files programs
 * under the third without a round trip.
 *
 *   PLAN: Squat 200 kg by spring. Phase 1 of 3, "Accumulation" (2026-09-01 to
 *   2026-10-12): hypertrophy on the squat pattern. Progression: add 2.5 kg when
 *   every working set hits the top of the range. Next: "Intensification" from
 *   2026-10-13. [phase_id 7777…]
 *
 * "None" and "drafted but unconfirmed" are said in so many words, because the
 * phone checklist asks the coach "show me my plan" before one exists and the
 * honest answer is how to make one, not a shrug. Pure, and exported for the
 * test.
 */
export function formatPlanLine(
  read: TrainingPlanRead | null,
  today: string,
): string {
  if (read === null) {
    return (
      "PLAN: none is set. A plan is written from Claude Desktop with " +
      "set_training_plan; it cannot be written from here."
    );
  }
  const { plan, phases } = read;
  if (plan.confirmed_at === null) {
    return (
      "PLAN: one is drafted but not confirmed yet (confirm_training_plan, " +
      "from Claude Desktop); until then there is no plan to build against."
    );
  }
  const head = `PLAN: ${plan.objective.trim().replace(/\.$/, "")}.`;
  const idx = phases.findIndex(
    (p) => p.starts_on <= today && today <= p.ends_on,
  );
  if (idx === -1) {
    const next = phases.find((p) => p.starts_on > today);
    if (next !== undefined) {
      return (
        `${head} No phase covers today; next is "${next.name}" from ` +
        `${next.starts_on} to ${next.ends_on}` +
        `${next.focus ? `: ${next.focus}` : ""}. [phase_id ${next.id}]`
      );
    }
    const last = phases[phases.length - 1];
    if (last === undefined) {
      return `${head} It has no phases yet; it needs revising from Claude Desktop.`;
    }
    return (
      `${head} Its last phase, "${last.name}", ended ${last.ends_on}; the ` +
      "plan needs revising from Claude Desktop."
    );
  }
  const cur = phases[idx];
  const next = phases[idx + 1];
  const parts = [
    `${head} Phase ${idx + 1} of ${phases.length}, "${cur.name}" ` +
      `(${cur.starts_on} to ${cur.ends_on})` +
      `${cur.focus ? `: ${cur.focus}` : ""}.`,
  ];
  if (cur.progression) parts.push(`Progression: ${cur.progression}.`);
  parts.push(
    next === undefined
      ? `Last phase; the plan ends ${plan.ends_on}.`
      : `Next: "${next.name}" from ${next.starts_on}.`,
  );
  parts.push(`[phase_id ${cur.id}]`);
  return parts.join(" ");
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
  try {
    const { data } = await supabase
      .from("coach_memory")
      .select("kind, fact")
      .order("kind");
    const memory = (data ?? []) as { kind: string; fact: string }[];
    if (memory.length > 0) {
      lines.push("\nWHAT YOU ALREADY KNOW ABOUT THEM:");
      for (const m of memory) lines.push(`  - [${m.kind}] ${m.fact}`);
      lines.push(
        "  (Use `remember` when they tell you something standing and new, " +
          "and `forget` when one of these stops being true.)",
      );
    }
  } catch {
    // Offline or unreachable: answering with less beats not answering.
  }

  // The plan, before today: it is the frame every day is written inside.
  // Cached, so a basement still knows which phase this is; a read that has
  // never succeeded on this device says so rather than claiming there is none.
  try {
    const plan = await getTrainingPlan();
    lines.push("", formatPlanLine(plan.data, today));
  } catch {
    lines.push("\n(Could not read the training plan from this device.)");
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

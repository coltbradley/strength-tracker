// DEV-ONLY demo fixtures. Not product code — see mockSupabase.ts for how this
// module stays out of the production bundle. No top-level side effects.
//
// Everything is dated relative to `new Date()` at call time, so the demo is
// always "this week" no matter when it runs.

import type { ActiveSession, ResolvedPrescriptionRow } from "../lib/types";

export type Row = Record<string, unknown>;

export interface DemoStore {
  exercises: Row[];
  training_maxes: Row[];
  goals: Row[];
  programs: Row[];
  planned_workouts: Row[];
  prescriptions: Row[];
  sessions: Row[];
  sets: Row[];
  set_voids: Row[];
  set_notes: Row[];
}

export type DemoScenario =
  "default" | "empty" | "orphan" | "active" | "undated" | "offline";

export const DEMO_USER_ID = "00000000-0000-4000-8000-000000000001";

// ---- date helpers ----------------------------------------------------------

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function dayIso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return dayIso(new Date(y, m - 1, d + n));
}

/** timestamptz for a local wall-clock time on a calendar date */
function at(iso: string, hour: number, minute = 0): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d, hour, minute, 0, 0).toISOString();
}

/** Mon–Sun ISO dates for the week containing `d` (matches lib/format). */
function weekDates(d: Date): string[] {
  const dow = d.getDay();
  const monday = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + (dow === 0 ? -6 : 1 - dow),
  );
  return Array.from({ length: 7 }, (_, i) =>
    dayIso(
      new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i),
    ),
  );
}

// Stable ids: readable in the console, and deterministic across reloads.
function id(prefix: string, n: number | string): string {
  return `${prefix}-${String(n)}`;
}

// ---- exercise library ------------------------------------------------------
// Ids and naming follow the real seed (free-exercise-db slugs + curated).

const EXERCISES: Array<[string, string, string | null, string[]]> = [
  ["Barbell_Squat", "Barbell Squat", "barbell", ["quadriceps"]],
  ["Front_Barbell_Squat", "Front Barbell Squat", "barbell", ["quadriceps"]],
  ["Safety_Bar_Squat", "Safety Bar Squat", "barbell", ["quadriceps"]],
  ["Barbell_Bench_Press", "Barbell Bench Press", "barbell", ["chest"]],
  [
    "Barbell_Incline_Bench_Press",
    "Barbell Incline Bench Press",
    "barbell",
    ["chest"],
  ],
  ["Barbell_Deadlift", "Barbell Deadlift", "barbell", ["lower back"]],
  ["Romanian_Deadlift", "Romanian Deadlift", "barbell", ["hamstrings"]],
  ["Trap_Bar_Deadlift", "Trap Bar Deadlift", "barbell", ["glutes"]],
  [
    "Standing_Military_Press",
    "Standing Military Press",
    "barbell",
    ["shoulders"],
  ],
  ["Seated_Dumbbell_Press", "Seated Dumbbell Press", "dumbbell", ["shoulders"]],
  ["Pullups", "Pullups", "body only", ["lats"]],
  ["Chin-Up", "Chin-Up", "body only", ["lats"]],
  ["Seated_Cable_Rows", "Seated Cable Rows", "cable", ["middle back"]],
  [
    "Bent_Over_Barbell_Row",
    "Bent Over Barbell Row",
    "barbell",
    ["middle back"],
  ],
  ["Face_Pull", "Face Pull", "cable", ["shoulders"]],
  ["Lat_Pulldown", "Lat Pulldown", "cable", ["lats"]],
  [
    "Bulgarian_Split_Squat",
    "Bulgarian Split Squat",
    "dumbbell",
    ["quadriceps"],
  ],
  ["Leg_Press", "Leg Press", "machine", ["quadriceps"]],
  ["Lying_Leg_Curls", "Lying Leg Curls", "machine", ["hamstrings"]],
  ["Standing_Calf_Raises", "Standing Calf Raises", "machine", ["calves"]],
  ["Hanging_Leg_Raise", "Hanging Leg Raise", "body only", ["abdominals"]],
  ["Ab_Roller", "Ab Roller", "other", ["abdominals"]],
  ["Plank", "Plank", "body only", ["abdominals"]],
  ["Dumbbell_Bicep_Curl", "Dumbbell Bicep Curl", "dumbbell", ["biceps"]],
  ["Hammer_Curls", "Hammer Curls", "dumbbell", ["biceps"]],
  ["Triceps_Pushdown", "Triceps Pushdown", "cable", ["triceps"]],
  [
    "Close-Grip_Barbell_Bench_Press",
    "Close-Grip Barbell Bench Press",
    "barbell",
    ["triceps"],
  ],
  ["Dips_-_Chest_Version", "Dips - Chest Version", "body only", ["chest"]],
  ["Cable_Crossover", "Cable Crossover", "cable", ["chest"]],
  ["Dumbbell_Flyes", "Dumbbell Flyes", "dumbbell", ["chest"]],
  ["Hip_Thrust", "Hip Thrust", "barbell", ["glutes"]],
  ["Back_Extensions", "Back Extensions", "body only", ["lower back"]],
  ["Farmers_Walk", "Farmers Walk", "dumbbell", ["forearms"]],
  ["Pallof_Press", "Pallof Press", "cable", ["abdominals"]],
  ["Copenhagen_Plank", "Copenhagen Plank", "body only", ["adductors"]],
  ["Reverse_Nordic_Curl", "Reverse Nordic Curl", "body only", ["quadriceps"]],
  // deliberately long name — tests wrapping in the session header + rx rows
  [
    "Single_Arm_Half_Kneeling_Landmine_Press",
    "Single-Arm Half-Kneeling Landmine Press (Deficit)",
    "barbell",
    ["shoulders"],
  ],
];

function exerciseRows(): Row[] {
  return EXERCISES.map(([exId, name, equipment, primary]) => ({
    id: exId,
    name,
    primary_muscles: primary,
    secondary_muscles: [],
    equipment,
    mechanic: null,
    force: null,
    category: "strength",
    level: "intermediate",
    source: "free-exercise-db",
    created_at: at(addDays(dayIso(new Date()), -365), 9),
  }));
}

// ---- prescription helper ---------------------------------------------------

interface RxSpec {
  exercise_id: string;
  sets: number;
  reps_min: number;
  reps_max: number;
  load_kg?: number | null;
  load_pct_tm?: number | null;
  rest_seconds?: number | null;
  notes?: string | null;
  superset_group?: number | null;
}

function rxRows(workoutId: string, specs: RxSpec[]): Row[] {
  return specs.map((s, i) => ({
    id: id(`rx-${workoutId}`, i),
    user_id: DEMO_USER_ID,
    planned_workout_id: workoutId,
    exercise_id: s.exercise_id,
    position: i,
    sets: s.sets,
    reps_min: s.reps_min,
    reps_max: s.reps_max,
    load_kg: s.load_kg ?? null,
    load_pct_tm: s.load_pct_tm ?? null,
    rest_seconds: s.rest_seconds ?? null,
    notes: s.notes ?? null,
    superset_group: s.superset_group ?? null,
    created_at: at(dayIso(new Date()), 8),
  }));
}

// ---- prescription content --------------------------------------------------

const LONG_COACH_NOTE =
  "Half-kneeling, ribs down, and do not let the front hip drift open at " +
  "lockout. Deficit means the landmine sleeve starts below the shoulder — " +
  "if you cannot own that range without leaning back, drop the deficit and " +
  "keep the rep quality. Same load both sides even if the right feels " +
  "stronger; we are chasing symmetry this block, not a PR.";

/** TODAY's workout: the render torture test — a 3-bracket ramp, a %TM
 *  prescription, a superset pair, a long name + long coach note, an
 *  unloaded ("by feel") entry, an unresolvable %TM, and rest_seconds. */
function todayRx(workoutId: string): Row[] {
  return rxRows(workoutId, [
    // ramp bracket: three consecutive prescriptions, same exercise
    {
      exercise_id: "Barbell_Squat",
      sets: 1,
      reps_min: 8,
      reps_max: 15,
      load_kg: 60,
      rest_seconds: 90,
    },
    {
      exercise_id: "Barbell_Squat",
      sets: 1,
      reps_min: 6,
      reps_max: 8,
      load_kg: 85,
      rest_seconds: 120,
    },
    {
      exercise_id: "Barbell_Squat",
      sets: 3,
      reps_min: 3,
      reps_max: 5,
      load_kg: 112.5,
      rest_seconds: 210,
      notes: "Top set is the session. Stop at a hard 3 if speed drops.",
    },
    // percentage of training max (a TM row exists, so it resolves)
    {
      exercise_id: "Barbell_Bench_Press",
      sets: 4,
      reps_min: 5,
      reps_max: 5,
      load_pct_tm: 82.5,
      rest_seconds: 150,
    },
    // superset A
    {
      exercise_id: "Romanian_Deadlift",
      sets: 3,
      reps_min: 8,
      reps_max: 10,
      load_kg: 100,
      rest_seconds: 60,
      superset_group: 1,
    },
    {
      exercise_id: "Face_Pull",
      sets: 3,
      reps_min: 12,
      reps_max: 15,
      load_kg: 25,
      rest_seconds: 60,
      superset_group: 1,
    },
    // long name + long coach note
    {
      exercise_id: "Single_Arm_Half_Kneeling_Landmine_Press",
      sets: 3,
      reps_min: 10,
      reps_max: 12,
      load_kg: 25,
      rest_seconds: 75,
      notes: LONG_COACH_NOTE,
    },
    // no load at all — coach said "by feel"
    { exercise_id: "Hanging_Leg_Raise", sets: 3, reps_min: 10, reps_max: 15 },
    // %TM with NO training max -> "no TM set" warning
    {
      exercise_id: "Standing_Military_Press",
      sets: 3,
      reps_min: 6,
      reps_max: 8,
      load_pct_tm: 70,
    },
  ]);
}

function pullRx(workoutId: string): Row[] {
  return rxRows(workoutId, [
    {
      exercise_id: "Barbell_Deadlift",
      sets: 3,
      reps_min: 3,
      reps_max: 5,
      load_pct_tm: 80,
      rest_seconds: 240,
    },
    {
      exercise_id: "Pullups",
      sets: 4,
      reps_min: 6,
      reps_max: 10,
      rest_seconds: 120,
    },
    {
      exercise_id: "Seated_Cable_Rows",
      sets: 3,
      reps_min: 10,
      reps_max: 12,
      load_kg: 65,
      rest_seconds: 90,
    },
    {
      exercise_id: "Hammer_Curls",
      sets: 3,
      reps_min: 10,
      reps_max: 12,
      load_kg: 16,
      superset_group: 1,
    },
    {
      exercise_id: "Triceps_Pushdown",
      sets: 3,
      reps_min: 12,
      reps_max: 15,
      load_kg: 30,
      superset_group: 1,
    },
  ]);
}

function pushRx(workoutId: string): Row[] {
  return rxRows(workoutId, [
    {
      exercise_id: "Barbell_Bench_Press",
      sets: 1,
      reps_min: 8,
      reps_max: 10,
      load_kg: 60,
    },
    {
      exercise_id: "Barbell_Bench_Press",
      sets: 4,
      reps_min: 4,
      reps_max: 6,
      load_pct_tm: 85,
      rest_seconds: 180,
    },
    {
      exercise_id: "Barbell_Incline_Bench_Press",
      sets: 3,
      reps_min: 8,
      reps_max: 10,
      load_kg: 55,
      rest_seconds: 120,
    },
    {
      exercise_id: "Cable_Crossover",
      sets: 3,
      reps_min: 12,
      reps_max: 15,
      load_kg: 20,
    },
    {
      exercise_id: "Plank",
      sets: 3,
      reps_min: 1,
      reps_max: 1,
      notes: "45s holds.",
    },
  ]);
}

function legsRx(workoutId: string): Row[] {
  return rxRows(workoutId, [
    {
      exercise_id: "Front_Barbell_Squat",
      sets: 4,
      reps_min: 5,
      reps_max: 5,
      load_kg: 90,
      rest_seconds: 180,
    },
    {
      exercise_id: "Bulgarian_Split_Squat",
      sets: 3,
      reps_min: 8,
      reps_max: 10,
      load_kg: 22.5,
      rest_seconds: 90,
    },
    {
      exercise_id: "Lying_Leg_Curls",
      sets: 3,
      reps_min: 10,
      reps_max: 12,
      load_kg: 45,
    },
    {
      exercise_id: "Standing_Calf_Raises",
      sets: 4,
      reps_min: 12,
      reps_max: 15,
      load_kg: 70,
    },
  ]);
}

function accessoryRx(workoutId: string): Row[] {
  return rxRows(workoutId, [
    {
      exercise_id: "Lat_Pulldown",
      sets: 4,
      reps_min: 10,
      reps_max: 12,
      load_kg: 60,
    },
    {
      exercise_id: "Seated_Dumbbell_Press",
      sets: 3,
      reps_min: 8,
      reps_max: 10,
      load_kg: 22.5,
    },
    {
      exercise_id: "Dumbbell_Bicep_Curl",
      sets: 3,
      reps_min: 10,
      reps_max: 12,
      load_kg: 14,
    },
    {
      exercise_id: "Pallof_Press",
      sets: 3,
      reps_min: 10,
      reps_max: 10,
      load_kg: 20,
    },
  ]);
}

// ---- logged history --------------------------------------------------------

interface SetSpec {
  exercise_id: string;
  set_type: "warmup" | "working" | "backoff";
  load_kg: number;
  reps: number;
  rest?: number | null;
}

function makeSession(
  sessionId: string,
  dateIso: string,
  hour: number,
  specs: SetSpec[],
  extra: Row = {},
): { session: Row; sets: Row[] } {
  const startedAt = at(dateIso, hour);
  const sets = specs.map((s, i) => ({
    id: id(sessionId, i),
    user_id: DEMO_USER_ID,
    session_id: sessionId,
    exercise_id: s.exercise_id,
    prescription_id: null,
    set_index: i,
    set_type: s.set_type,
    load_kg: s.load_kg,
    reps: s.reps,
    rest_seconds_actual: s.rest ?? null,
    performed_at: at(dateIso, hour, 6 + i * 4),
    created_at: at(dateIso, hour, 6 + i * 4),
  }));
  return {
    session: {
      id: sessionId,
      user_id: DEMO_USER_ID,
      planned_workout_id: null,
      started_at: startedAt,
      ended_at: at(dateIso, hour, 10 + specs.length * 4),
      session_rpe: null,
      bodyweight_kg: null,
      notes: null,
      discarded_at: null,
      created_at: startedAt,
      ...extra,
    },
    sets,
  };
}

/** Eight weeks of real-looking training for squat / bench / deadlift, two
 *  sessions a week, so the e1RM line, the weekly bars and the goal line all
 *  have something to draw. */
function history(thisMonday: string): { sessions: Row[]; sets: Row[] } {
  const sessions: Row[] = [];
  const sets: Row[] = [];
  for (let w = 8; w >= 1; w--) {
    const monday = addDays(thisMonday, -7 * w);
    const thursday = addDays(monday, 3);
    const step = 8 - w; // 0..7
    const wobble = (n: number) => (n % 3 === 0 ? -2.5 : 0);

    const squatTop = 92.5 + step * 2.5 + wobble(w);
    const a = makeSession(id("sess-a", w), monday, 18, [
      {
        exercise_id: "Barbell_Squat",
        set_type: "warmup",
        load_kg: 40,
        reps: 8,
      },
      {
        exercise_id: "Barbell_Squat",
        set_type: "warmup",
        load_kg: 60,
        reps: 5,
        rest: 95,
      },
      {
        exercise_id: "Barbell_Squat",
        set_type: "working",
        load_kg: squatTop - 15,
        reps: 5,
        rest: 150,
      },
      {
        exercise_id: "Barbell_Squat",
        set_type: "working",
        load_kg: squatTop,
        reps: 5,
        rest: 205,
      },
      {
        exercise_id: "Barbell_Squat",
        set_type: "working",
        load_kg: squatTop,
        reps: 4,
        rest: 220,
      },
      {
        exercise_id: "Romanian_Deadlift",
        set_type: "working",
        load_kg: 80 + step * 2.5,
        reps: 8,
        rest: 120,
      },
      {
        exercise_id: "Romanian_Deadlift",
        set_type: "working",
        load_kg: 80 + step * 2.5,
        reps: 8,
        rest: 118,
      },
    ]);
    sessions.push(a.session);
    sets.push(...a.sets);

    // 2.5 kg steps only — a demo full of 71.3 kg bench presses reads fake
    const benchTop = 70 + Math.floor(step / 2) * 2.5 + wobble(w + 1);
    const dead = w % 2 === 0;
    const b = makeSession(id("sess-b", w), thursday, 18, [
      {
        exercise_id: "Barbell_Bench_Press",
        set_type: "warmup",
        load_kg: 40,
        reps: 8,
      },
      {
        exercise_id: "Barbell_Bench_Press",
        set_type: "working",
        load_kg: benchTop - 10,
        reps: 6,
        rest: 140,
      },
      {
        exercise_id: "Barbell_Bench_Press",
        set_type: "working",
        load_kg: benchTop,
        reps: 5,
        rest: 180,
      },
      {
        exercise_id: "Barbell_Bench_Press",
        set_type: "working",
        load_kg: benchTop,
        reps: 5,
        rest: 190,
      },
      ...(dead
        ? ([
            {
              exercise_id: "Barbell_Deadlift",
              set_type: "working",
              load_kg: 132.5 + step * 2.5,
              reps: 3,
              rest: 240,
            },
            {
              exercise_id: "Barbell_Deadlift",
              set_type: "working",
              load_kg: 132.5 + step * 2.5,
              reps: 3,
              rest: 250,
            },
          ] as SetSpec[])
        : ([
            {
              exercise_id: "Seated_Cable_Rows",
              set_type: "working",
              load_kg: 55 + step * 2.5,
              reps: 10,
              rest: 90,
            },
            {
              exercise_id: "Seated_Cable_Rows",
              set_type: "working",
              load_kg: 55 + step * 2.5,
              reps: 10,
              rest: 92,
            },
          ] as SetSpec[])),
    ]);
    sessions.push(b.session);
    sets.push(...b.sets);
  }
  return { sessions, sets };
}

// ---- scenario assembly -----------------------------------------------------

export interface ScenarioResult {
  store: DemoStore;
  /** local caches to prime (the `active` scenario resumes a live session) */
  activeSessionCache: {
    session: ActiveSession;
    prescriptions: ResolvedPrescriptionRow[];
  } | null;
}

function emptyStore(): DemoStore {
  return {
    exercises: exerciseRows(),
    training_maxes: [],
    goals: [],
    programs: [],
    planned_workouts: [],
    prescriptions: [],
    sessions: [],
    sets: [],
    set_voids: [],
    set_notes: [],
  };
}

interface WeekPlan {
  doneDate: string;
  missedDate: string;
  skippedDate: string;
  todayDate: string;
  upcomingDate: string;
}

/** Spread the five week states over real calendar days. Prefers days inside
 *  the current Mon–Sun week; on a Monday or Tuesday there aren't enough past
 *  days, so the leftovers fall just outside the week and render in LATER —
 *  the states themselves still all appear. */
function planWeek(today: string): WeekPlan {
  const week = weekDates(new Date());
  const ti = week.indexOf(today);
  const past = week.slice(0, Math.max(ti, 0));
  const future = week.slice(ti + 1);
  const nextPast = () => past.shift();
  const nextFuture = () => future.shift();
  return {
    doneDate: nextPast() ?? addDays(today, -3),
    missedDate: nextPast() ?? addDays(today, -1),
    skippedDate: nextPast() ?? nextFuture() ?? addDays(today, 1),
    todayDate: today,
    upcomingDate: nextFuture() ?? addDays(today, 2),
  };
}

/** The full demo: a confirmed program across the week, 8 weeks of history,
 *  a training max, a goal, session + set notes. */
function defaultStore(opts: { dated: boolean }): DemoStore {
  const store = emptyStore();
  const today = dayIso(new Date());
  const thisMonday = weekDates(new Date())[0];
  const plan = planWeek(today);

  store.training_maxes = [
    {
      id: "tm-squat",
      user_id: DEMO_USER_ID,
      exercise_id: "Barbell_Squat",
      value_kg: 137.5,
      effective_date: addDays(today, -21),
      created_at: at(addDays(today, -21), 9),
    },
    {
      id: "tm-bench",
      user_id: DEMO_USER_ID,
      exercise_id: "Barbell_Bench_Press",
      value_kg: 102.5,
      effective_date: addDays(today, -21),
      created_at: at(addDays(today, -21), 9),
    },
    {
      id: "tm-dead",
      user_id: DEMO_USER_ID,
      exercise_id: "Barbell_Deadlift",
      value_kg: 180,
      effective_date: addDays(today, -21),
      created_at: at(addDays(today, -21), 9),
    },
    // a superseded row, so "latest effective_date wins" is actually exercised
    {
      id: "tm-squat-old",
      user_id: DEMO_USER_ID,
      exercise_id: "Barbell_Squat",
      value_kg: 130,
      effective_date: addDays(today, -70),
      created_at: at(addDays(today, -70), 9),
    },
  ];

  store.goals = [
    {
      id: "goal-squat",
      user_id: DEMO_USER_ID,
      exercise_id: "Barbell_Squat",
      target_e1rm_kg: 160,
      target_date: addDays(today, 84),
      created_at: at(addDays(today, -60), 9),
    },
    {
      id: "goal-bench",
      user_id: DEMO_USER_ID,
      exercise_id: "Barbell_Bench_Press",
      target_e1rm_kg: 110,
      target_date: addDays(today, 84),
      created_at: at(addDays(today, -60), 9),
    },
  ];

  store.programs = [
    {
      id: "prog-1",
      user_id: DEMO_USER_ID,
      name: "Off-Season Block 2 · Weeks 5–8",
      source_note: "Parsed from coach screenshot, 4 images",
      created_at: at(addDays(today, -14), 20),
      confirmed_at: at(addDays(today, -14), 20, 5),
    },
    // an unconfirmed program: it must NOT appear anywhere in the app
    {
      id: "prog-draft",
      user_id: DEMO_USER_ID,
      name: "Deload week (draft, awaiting confirm)",
      source_note: "Parsed but unconfirmed",
      created_at: at(addDays(today, -1), 21),
      confirmed_at: null,
    },
  ];

  const days: Array<{
    key: keyof WeekPlan;
    label: string;
    notes: string | null;
    plan_note: string | null;
    rx: (wid: string) => Row[];
  }> = [
    {
      key: "doneDate",
      label: "Pull · Deadlift",
      notes: "Deadlifts off the floor, no touch-and-go.",
      plan_note: null,
      rx: pullRx,
    },
    {
      key: "missedDate",
      label: "Push · Bench",
      notes: null,
      plan_note: "Try the new bench, the old one wobbles.",
      rx: pushRx,
    },
    {
      key: "skippedDate",
      label: "Accessories · Arms + Core",
      notes: null,
      plan_note: null,
      rx: accessoryRx,
    },
    {
      key: "todayDate",
      label: "Full Body · Squat Focus",
      notes:
        "Bar speed is the readout today. If the top set grinds, cut the last one.",
      plan_note: "Bring the belt and the knee sleeves.",
      rx: todayRx,
    },
    {
      key: "upcomingDate",
      label: "Legs · Front Squat",
      notes: null,
      plan_note: null,
      rx: legsRx,
    },
  ];

  const ordered = [...days].sort((a, b) =>
    plan[a.key].localeCompare(plan[b.key]),
  );
  ordered.forEach((d, i) => {
    const wid = id("pw", d.key);
    store.planned_workouts.push({
      id: wid,
      user_id: DEMO_USER_ID,
      program_id: "prog-1",
      day_index: i,
      label: d.label,
      notes: d.notes,
      scheduled_date: opts.dated ? plan[d.key] : null,
      plan_note: d.plan_note,
      skipped_at: d.key === "skippedDate" ? at(plan[d.key], 7, 30) : null,
      created_at: at(addDays(today, -14), 20),
    });
    store.prescriptions.push(...d.rx(wid));
  });

  // ---- eight weeks of logged history ----
  const past = history(thisMonday);
  store.sessions.push(...past.sessions);
  store.sets.push(...past.sets);

  // one voided set, so v_live_sets actually has something to exclude
  store.set_voids.push({
    set_id: id(id("sess-a", 3), 4),
    user_id: DEMO_USER_ID,
    created_at: at(addDays(today, -20), 20),
  });

  // ---- this week's DONE workout: a real completed session ----
  const doneWorkoutId = id("pw", "doneDate");
  const doneSession = makeSession(
    "sess-done",
    plan.doneDate,
    18,
    [
      {
        exercise_id: "Barbell_Deadlift",
        set_type: "warmup",
        load_kg: 60,
        reps: 5,
      },
      {
        exercise_id: "Barbell_Deadlift",
        set_type: "warmup",
        load_kg: 100,
        reps: 3,
        rest: 120,
      },
      {
        exercise_id: "Barbell_Deadlift",
        set_type: "working",
        load_kg: 145,
        reps: 5,
        rest: 245,
      },
      {
        exercise_id: "Barbell_Deadlift",
        set_type: "working",
        load_kg: 145,
        reps: 4,
        rest: 260,
      },
      {
        exercise_id: "Pullups",
        set_type: "working",
        load_kg: 0,
        reps: 9,
        rest: 130,
      },
      {
        exercise_id: "Pullups",
        set_type: "working",
        load_kg: 0,
        reps: 7,
        rest: 135,
      },
      {
        exercise_id: "Seated_Cable_Rows",
        set_type: "working",
        load_kg: 72.5,
        reps: 11,
        rest: 95,
      },
      {
        exercise_id: "Seated_Cable_Rows",
        set_type: "working",
        load_kg: 72.5,
        reps: 10,
        rest: 98,
      },
    ],
    {
      planned_workout_id: doneWorkoutId,
      session_rpe: 8,
      bodyweight_kg: 84.2,
      notes:
        "Pulls felt heavy off the floor but lockout was fine. Grip went before the back did on the second set.",
    },
  );
  store.sessions.push(doneSession.session);
  store.sets.push(...doneSession.sets);

  store.set_notes = [
    {
      set_id: id("sess-done", 3),
      user_id: DEMO_USER_ID,
      note: "Hitched the last rep — count it as 4.",
      updated_at: at(plan.doneDate, 19),
    },
    {
      set_id: id("sess-done", 6),
      user_id: DEMO_USER_ID,
      note: "New handle, felt narrower.",
      updated_at: at(plan.doneDate, 19, 20),
    },
  ];

  return store;
}

/** The prescriptions of a planned workout, as v_resolved_prescriptions would
 *  return them — used to prime the in-flight session cache. */
function resolvedFor(
  store: DemoStore,
  workoutId: string,
): ResolvedPrescriptionRow[] {
  const names = new Map(
    store.exercises.map((e) => [e.id as string, e.name as string]),
  );
  const today = dayIso(new Date());
  const tmFor = (exerciseId: string): number | null => {
    const rows = store.training_maxes
      .filter(
        (t) =>
          t.exercise_id === exerciseId && (t.effective_date as string) <= today,
      )
      .sort((a, b) =>
        (a.effective_date as string).localeCompare(b.effective_date as string),
      );
    const last = rows[rows.length - 1];
    return last ? (last.value_kg as number) : null;
  };
  return store.prescriptions
    .filter((p) => p.planned_workout_id === workoutId)
    .sort((a, b) => (a.position as number) - (b.position as number))
    .map((p) => {
      const tm = tmFor(p.exercise_id as string);
      const pct = p.load_pct_tm as number | null;
      const resolved =
        p.load_kg !== null
          ? (p.load_kg as number)
          : pct !== null && tm !== null
            ? Math.round((pct / 100) * tm * 10) / 10
            : null;
      return {
        id: p.id as string,
        planned_workout_id: workoutId,
        exercise_id: p.exercise_id as string,
        exercise_name:
          names.get(p.exercise_id as string) ?? (p.exercise_id as string),
        position: p.position as number,
        sets: p.sets as number,
        reps_min: p.reps_min as number,
        reps_max: p.reps_max as number,
        rest_seconds: p.rest_seconds as number | null,
        notes: p.notes as string | null,
        load_kg: p.load_kg as number | null,
        load_pct_tm: pct,
        tm_kg: tm,
        resolved_load_kg: resolved,
        plate_load_kg:
          resolved === null ? null : Math.round(resolved / 2.5) * 2.5,
        superset_group: p.superset_group as number | null,
      };
    });
}

export function buildScenario(scenario: DemoScenario): ScenarioResult {
  const today = dayIso(new Date());

  if (scenario === "empty") {
    return { store: emptyStore(), activeSessionCache: null };
  }

  if (scenario === "undated") {
    return { store: defaultStore({ dated: false }), activeSessionCache: null };
  }

  const store = defaultStore({ dated: true });

  if (scenario === "orphan") {
    // an open session started earlier today that this device knows nothing
    // about (started on another phone) — Today offers resume/finish/discard
    store.sessions.push({
      id: "sess-orphan",
      user_id: DEMO_USER_ID,
      planned_workout_id: id("pw", "todayDate"),
      started_at: new Date(Date.now() - 95 * 60_000).toISOString(),
      ended_at: null,
      session_rpe: null,
      bodyweight_kg: null,
      notes: null,
      discarded_at: null,
      created_at: new Date(Date.now() - 95 * 60_000).toISOString(),
    });
    store.sets.push(
      {
        id: "sess-orphan-0",
        user_id: DEMO_USER_ID,
        session_id: "sess-orphan",
        exercise_id: "Barbell_Squat",
        prescription_id: null,
        set_index: 0,
        set_type: "warmup",
        load_kg: 60,
        reps: 10,
        rest_seconds_actual: null,
        performed_at: new Date(Date.now() - 90 * 60_000).toISOString(),
        created_at: new Date(Date.now() - 90 * 60_000).toISOString(),
      },
      {
        id: "sess-orphan-1",
        user_id: DEMO_USER_ID,
        session_id: "sess-orphan",
        exercise_id: "Barbell_Squat",
        prescription_id: null,
        set_index: 1,
        set_type: "working",
        load_kg: 85,
        reps: 7,
        rest_seconds_actual: 180,
        performed_at: new Date(Date.now() - 85 * 60_000).toISOString(),
        created_at: new Date(Date.now() - 85 * 60_000).toISOString(),
      },
    );
    return { store, activeSessionCache: null };
  }

  if (scenario === "active") {
    const workoutId = id("pw", "todayDate");
    const workout = store.planned_workouts.find((w) => w.id === workoutId)!;
    const startedAt = new Date(Date.now() - 34 * 60_000).toISOString();
    store.sessions.push({
      id: "sess-active",
      user_id: DEMO_USER_ID,
      planned_workout_id: workoutId,
      started_at: startedAt,
      ended_at: null,
      session_rpe: null,
      bodyweight_kg: null,
      notes: null,
      discarded_at: null,
      created_at: startedAt,
    });
    const rx = resolvedFor(store, workoutId);
    const logged: Array<[string, string, number, number, number | null]> = [
      ["Barbell_Squat", "warmup", 60, 12, null],
      ["Barbell_Squat", "working", 85, 7, 190],
      ["Barbell_Squat", "working", 112.5, 5, 215],
    ];
    logged.forEach(([exercise, type, load, reps, rest], i) => {
      store.sets.push({
        id: `sess-active-${i}`,
        user_id: DEMO_USER_ID,
        session_id: "sess-active",
        exercise_id: exercise,
        prescription_id: rx[i]?.id ?? null,
        set_index: i,
        set_type: type,
        load_kg: load,
        reps,
        rest_seconds_actual: rest,
        performed_at: new Date(
          Date.now() - (30 - i * 8) * 60_000,
        ).toISOString(),
        created_at: new Date(Date.now() - (30 - i * 8) * 60_000).toISOString(),
      });
    });
    return {
      store,
      activeSessionCache: {
        session: {
          id: "sess-active",
          planned_workout_id: workoutId,
          started_at: startedAt,
          workout_label: workout.label as string | null,
          plan_note: workout.plan_note as string | null,
          coach_note: workout.notes as string | null,
        },
        prescriptions: rx,
      },
    };
  }

  // "default" and "offline" both run the full store; offline only differs in
  // that the mock rejects every query (see mockSupabase.ts).
  void today;
  return { store, activeSessionCache: null };
}

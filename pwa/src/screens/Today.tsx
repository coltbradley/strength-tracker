// Today: the week as a calendar. A Mon–Sun strip shows which days carry
// work and their state (done / skipped / missed / today / rest); tapping a
// day previews it inline below without losing the week. Today's workout gets
// the primary Start; a day scheduled elsewhere can still be trained from its
// preview card without the plan being rewritten to match. Everything else is
// editable via the plan editor.
// Anything scheduled outside this week (or undated) lives in a compact
// LATER list. Programs with no dates at all keep the original ruled list —
// a calendar needs dates.

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { discardOutcome } from "../lib/discardOutcome";
import { Note } from "../components/Note";
import { BodyweightRow } from "../components/BodyweightRow";
import { RateSessionCard } from "../components/RateSessionCard";
import { CalendarSheet, type CalendarDay } from "../components/CalendarSheet";
import { TemplateSheet } from "../components/TemplateSheet";
import { CheckInSheet } from "../components/CheckInSheet";
import { TrainHome, type TrainWeekDay } from "../components/TrainHome";
import { useOutboxStatus } from "../hooks/useOutboxStatus";
import {
  proofForSession,
  readFinishedSessionProof,
  type TaggedFinishedProof,
} from "../lib/finishedProof";
import {
  applyTemplate,
  createPlannedWorkout,
  deleteTemplate,
  ensureConfirmedProgramId,
  getDoneWorkoutIds,
  getExercises,
  getLastActuals,
  getPlannedWorkouts,
  getResolvedPrescriptions,
  getServerSessionSets,
  invalidateForSessionClose,
  mergeSets,
  staleReason,
  syncOpenSessions,
  updatePlannedWorkout,
  weekOrder,
  type OpenSessionRow,
  type StaleReason,
  type WorkoutList,
} from "../lib/data";
import { doneSummaryKey, formatDuration, type DoneSummary } from "./End";
import { groupRamps } from "../lib/entries";
import { nextActionableWorkout } from "../lib/trainingScene";
import { openCoach } from "../lib/coachOpen";
import { onPlanChanged } from "../lib/planChanges";
import {
  getRecentlyEndedSessions,
  reviewableByDay,
  reviewPrompt,
  type EndedSession,
} from "../lib/review";
import { useOnline } from "../hooks/useFabDrag";
import {
  addDays,
  startOfWeek,
  weekDates,
  weekDates as calendarWeek,
} from "../lib/calendar";
import { cacheGet, cacheSet, cacheKeys } from "../lib/db";
import { outbox } from "../lib/sync";
import type { OutboxEntry } from "../lib/outbox";
import { uuid } from "../lib/uuid";
import { useArmed } from "../hooks/useArmed";
import { useLocalToday } from "../hooks/useLocalToday";
import { reportError, toast } from "../lib/errors";
import {
  formatPlannedDate,
  formatRxTarget,
  formatTodayHeading,
  formatWeekdayLetter,
  parseLocalDate,
  rxHasNoTm,
  todayLocalIso,
  workoutName,
} from "../lib/format";
import { useUnit } from "../hooks/useUnit";
import { useSetting, useWeekStartsOn } from "../hooks/useSettings";
import { dismissFirstRun, setUnit } from "../lib/settings";
import type {
  ActiveSession,
  PlannedWorkoutRow,
  ResolvedPrescriptionRow,
} from "../lib/types";

/** How long the Start buttons wait on the open-session check (see below). */
const GATE_TIMEOUT_MS = 2500;

export type WorkoutState =
  | "DONE"
  | "SKIPPED"
  | "TODAY"
  | "MISSED"
  /** a past, non-empty, not-done day whose completion this device could not
   *  check (the done-state read failed and nothing is cached). Not knowing is
   *  not failing, so it must never be worded as MISSED. */
  | "PAST"
  | "UPCOMING"
  | "NO DATE"
  /** dated, but nothing programmed into it yet. "Plan a workout" creates the
   *  day before its contents, so an abandoned one used to turn into a MISSED
   *  workout the day after — a session someone failed to do, that never
   *  existed. */
  | "DRAFT";

type PrescriptionLoadState =
  "loading" | "loaded" | StaleReason | `cached-${StaleReason}`;

/**
 * A session insert can be durable in the outbox while its small active-session
 * cache pointer failed to write. On reload, recover that local truth before
 * offering Start again. Only a `waiting` row belongs to the current identity;
 * held rows may belong to somebody else. A queued finish or discard wins.
 */
function queuedSessionRecovery(
  entries: readonly OutboxEntry[],
): ActiveSession | null {
  const closed = new Set(
    entries.flatMap((entry) => {
      const { op } = entry;
      return op.kind === "update" &&
        op.table === "sessions" &&
        ("ended_at" in op.patch || "discarded_at" in op.patch)
        ? [op.id]
        : [];
    }),
  );
  for (const entry of [...entries].reverse()) {
    const { op } = entry;
    if (
      entry.state !== "waiting" ||
      op.kind !== "insert" ||
      op.table !== "sessions" ||
      closed.has(op.payload.id)
    )
      continue;
    return {
      id: op.payload.id,
      planned_workout_id: op.payload.planned_workout_id,
      started_at: op.payload.started_at,
      workout_label: null,
      plan_note: null,
      coach_note: null,
    };
  }
  return null;
}

/** How long the swipe track must sit still before we call it settled. */
const SETTLE_MS = 120;

/** How long after re-parking the track a settle is treated as our own doing
 *  rather than a swipe. Belt and braces around the snap-off jump below. */
const PARK_GUARD_MS = 250;

/**
 * The three weeks the strip renders: last, the selected one, next.
 *
 * A track of real weeks rather than a swipe gesture. The strip sits directly
 * above a vertically scrolling list, and deciding whether a drag belongs to
 * the strip or to the page is exactly what a hand-rolled pointer handler gets
 * wrong; a native scroll container hands that decision to the browser's own
 * direction locking, which already gets it right on every phone.
 */
export function weekPages(selected: string, weekStart: number): string[][] {
  return [-7, 0, 7].map((n) => weekDates(addDays(selected, n), weekStart));
}

/**
 * The day a link asked Program to open on (`/program?date=2026-09-30`), or
 * null. Train's week strip used to send all seven days to the same bare
 * `/program`, so tapping Wednesday landed on today (UI-02). Only a real
 * calendar date is honoured: a malformed or impossible one is ignored rather
 * than selecting a day nobody can reach.
 */
export function requestedDateFrom(search: string): string | null {
  const raw = new URLSearchParams(search).get("date");
  if (raw === null || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return todayLocalIso(parseLocalDate(raw)) === raw ? raw : null;
}

/**
 * The strip's one-line tally, for the days SHOWN. It used to count every day
 * of the program, so a header over this week read "3 to go" when those three
 * were missed days from August and nothing was ahead (UI-08). Words follow the
 * states: upcoming work is TO GO, a past undone day is MISSED (or NOT CHECKED
 * when completion could not be read). Counts, never a ratio.
 */
export function weekTally(
  workouts: readonly PlannedWorkoutRow[],
  states: ReadonlyMap<string, WorkoutState>,
  weekDates: readonly string[],
): string {
  const n = { done: 0, ahead: 0, missed: 0, past: 0, skipped: 0 };
  for (const w of workouts) {
    if (!w.scheduled_date || !weekDates.includes(w.scheduled_date)) continue;
    switch (states.get(w.id)) {
      case "DONE":
        n.done += 1;
        break;
      case "SKIPPED":
        n.skipped += 1;
        break;
      case "MISSED":
        n.missed += 1;
        break;
      case "PAST":
        n.past += 1;
        break;
      case "TODAY":
      case "UPCOMING":
        n.ahead += 1;
        break;
      // DRAFT and NO DATE were never asked of anyone
    }
  }
  return [
    `${n.done} DONE`,
    `${n.ahead} TO GO`,
    n.missed > 0 ? `${n.missed} MISSED` : null,
    n.past > 0 ? `${n.past} NOT CHECKED` : null,
    n.skipped > 0 ? `${n.skipped} SKIPPED` : null,
  ]
    .filter((p): p is string => p !== null)
    .join(" · ");
}

/**
 * Split the days outside the shown week into those BEFORE it and those after
 * it (or undated). One list called LATER held August's finished workouts and
 * next month's together (UI-08).
 */
export function splitOutsideWeek(
  outside: readonly PlannedWorkoutRow[],
  weekDates: readonly string[],
): { earlier: PlannedWorkoutRow[]; later: PlannedWorkoutRow[] } {
  const first = weekDates[0] ?? "";
  const earlier: PlannedWorkoutRow[] = [];
  const later: PlannedWorkoutRow[] = [];
  for (const w of outside)
    (w.scheduled_date && w.scheduled_date < first ? earlier : later).push(w);
  return { earlier, later };
}

/**
 * The day to select when the track settles on `page` (0 = last week,
 * 1 = the one already selected, 2 = next).
 *
 * Swiping moves the SELECTION, not a separate view anchor: the strip is
 * anchored on the selected day, and a second anchor would let the week on
 * screen and the day previewed below it disagree. Same weekday, so a swipe
 * from Wednesday lands on Wednesday.
 */
/**
 * What each planned day IS, right now. Pure so it can be tested: the order of
 * these branches is the whole meaning.
 *
 * DONE and SKIPPED come first because they are facts about what happened.
 * DRAFT comes next, ahead of every date check — a day with nothing programmed
 * into it is a draft whether its date has passed or not, and calling it MISSED
 * accuses someone of skipping a workout that was never written.
 */
export function workoutStates(
  workouts: PlannedWorkoutRow[],
  doneIds: Set<string>,
  anyDates: boolean,
  today: string,
  /** false until the done-state read has answered (or been served from the
   *  device cache). While false, a past day reads PAST, never MISSED. */
  doneKnown = true,
): Map<string, WorkoutState> {
  const map = new Map<string, WorkoutState>();
  let todayAssigned = false;
  for (const w of workouts) {
    if (doneIds.has(w.id)) {
      map.set(w.id, "DONE");
    } else if (w.skipped_at !== null) {
      map.set(w.id, "SKIPPED");
    } else if (w.exercise_count === 0) {
      map.set(w.id, "DRAFT");
    } else if (anyDates) {
      if (w.scheduled_date === null) map.set(w.id, "NO DATE");
      else if (w.scheduled_date === today) map.set(w.id, "TODAY");
      else if (w.scheduled_date < today)
        map.set(w.id, doneKnown ? "MISSED" : "PAST");
      else map.set(w.id, "UPCOMING");
    } else if (!todayAssigned) {
      map.set(w.id, "TODAY");
      todayAssigned = true;
    } else {
      map.set(w.id, "UPCOMING");
    }
  }
  return map;
}

/**
 * One strip cell from EVERY workout on its date (a date can hold more than
 * one: same-day overflow is supported). Today's pending workout beats a done
 * one, because there is still something to do; otherwise anything done reads
 * DONE, since that is what happened. No workouts is a rest day.
 */
export function dayStripState(
  states: readonly WorkoutState[],
): WorkoutState | "REST" {
  if (states.length === 0) return "REST";
  if (states.includes("TODAY")) return "TODAY";
  if (states.includes("DONE")) return "DONE";
  for (const s of [
    "UPCOMING",
    "MISSED",
    "PAST",
    "SKIPPED",
    "DRAFT",
    "NO DATE",
  ] as const)
    if (states.includes(s)) return s;
  return states[0];
}

/**
 * The single workout Train may speak for. Calendar plans keep their day even
 * after completion, so a completed workout scheduled today remains visible as
 * a Record action. Undated plans rely on the same TODAY state as Program.
 */
export function trainWorkoutForToday(
  workouts: PlannedWorkoutRow[],
  states: Map<string, WorkoutState>,
  today: string,
): { workout: PlannedWorkoutRow; state: WorkoutState } | null {
  const dated =
    workouts.find(
      (workout) =>
        workout.scheduled_date === today && states.get(workout.id) === "TODAY",
    ) ?? workouts.find((workout) => workout.scheduled_date === today);
  if (dated) return { workout: dated, state: states.get(dated.id) ?? "TODAY" };

  const undated = workouts.find(
    (workout) => states.get(workout.id) === "TODAY",
  );
  return undated ? { workout: undated, state: "TODAY" } : null;
}

/**
 * Whether a day's preview card offers to be trained RIGHT NOW, on a date the
 * plan does not put it on.
 *
 * A session used to be welded to today's planned day: doing Wednesday's work
 * on Tuesday meant either "Move to today", which rewrites `scheduled_date` and
 * destroys what the coach actually asked for, or an empty session with no
 * targets and no adherence rows. Neither is what happened. The lifter did
 * Wednesday's session, on Tuesday.
 *
 * Nothing about `start()` needs the day to be today. It stamps the session's
 * `planned_workout_id` and DONE-ness is read back from that pointer, not from
 * a date comparison — so a session started this way lights its own day up as
 * done and leaves the calendar untouched. (A planned day is DONE only once its
 * session has `ended_at`; that is unaffected here, and an open session started
 * this way shows the same in-progress microcopy as any other.)
 *
 * What this function is really for is the exclusions, which is why it is a
 * named predicate rather than an inline `||`:
 *
 *  - DONE and SKIPPED are facts about what already happened. Re-running a done
 *    day is "Start again" and belongs to today's card only; offering it from a
 *    day in another week would quietly append a second session to a finished
 *    one from a screen that is not about today.
 *  - DRAFT is a day with nothing programmed into it (`exercise_count === 0`).
 *    Starting one produces exactly the empty, targetless session this feature
 *    exists to avoid; "add exercises in Edit" is the honest answer.
 *  - TODAY already has the primary "Start session". A second start control on
 *    the same card is two buttons that do the same thing.
 *  - NO DATE is an executable day with no calendar slot. It cannot be
 *    rescheduled meaningfully until the person chooses a date, but it can be
 *    trained now without inventing one or losing its targets.
 *
 * It intentionally does not consult `anyDates`: a day is a day. In an undated
 * DAY 1..N program the same gap exists (day 3 before day 2) and the same
 * answer works, whereas rescheduling there is meaningless and is gated off.
 */
export function canDoWorkoutNow(state: WorkoutState): boolean {
  return (
    state === "UPCOMING" ||
    state === "MISSED" ||
    state === "PAST" ||
    state === "NO DATE"
  );
}

/**
 * The one microcopy line explaining the do-now / reschedule buttons, or null
 * when neither is actually on the card.
 *
 * NO DATE gets its own line rather than the generic one below. The generic
 * line's whole claim is "the day keeps its date and still counts as done" —
 * false for a day with no date to keep — and pairing "Do this workout now"
 * with "reschedule it to today" told someone to reschedule in order to do the
 * very thing the button right above it already does.
 */
export function doNowMicrocopy(
  state: WorkoutState,
  canDoNow: boolean,
  canReschedule: boolean,
): string | null {
  if (state === "NO DATE") {
    return canDoNow
      ? "No date set. Do it now, or pick a day in Edit to put it on the calendar."
      : null;
  }
  if (canDoNow && canReschedule) {
    return "Do it now if you’re ahead or behind — the day keeps its date and still counts as done. Reschedule only if the date itself was wrong.";
  }
  return null;
}

/**
 * Whether the first-run card belongs on screen.
 *
 * Three conditions and each one is load-bearing, which is why this is a named
 * predicate rather than a `&&` chain in the JSX:
 *
 *  - LOADED. Every branch of this screen's empty state is a claim about the
 *    data and must wait for it. Rendering "here is how to get started" over a
 *    plan that is still arriving is the same bug as the empty state itself.
 *  - NO PROGRAM. The card is the answer to a blank screen. Once there is a
 *    program the person has already got past the thing it explains, and it
 *    would be sitting on top of the week they came here to read.
 *  - NOT DISMISSED. Device-local, in the settings registry, so it stays gone.
 *
 * Deliberately NOT keyed on "has this person ever logged a set": someone who
 * finished a program and has none right now is back at the same blank screen,
 * and the coach is still the fastest way off it.
 */
export function showFirstRun(a: {
  loaded: boolean;
  hasProgram: boolean;
  dismissed: boolean;
}): boolean {
  return a.loaded && !a.hasProgram && !a.dismissed;
}

export function weekPageDate(selected: string, page: number): string {
  return addDays(selected, (page - 1) * 7);
}

/**
 * "24–30 AUG", or "31 AUG – 6 SEPT" across a month end.
 *
 * The head used to read THIS WEEK unconditionally, which was true while the
 * strip could only show this week. Now that it swipes, a label that says
 * "this week" over next month is worse than no label.
 */
export function weekRangeLabel(dates: string[]): string {
  const a = parseLocalDate(dates[0]);
  const b = parseLocalDate(dates[dates.length - 1]);
  const month = (d: Date) =>
    d.toLocaleDateString("en-GB", { month: "short" }).toUpperCase();
  return a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()
    ? `${a.getDate()}–${b.getDate()} ${month(b)}`
    : `${a.getDate()} ${month(a)} – ${b.getDate()} ${month(b)}`;
}

export function Today({
  userId,
  presentation = "program",
}: {
  userId?: string | null;
  presentation?: "train" | "program";
} = {}) {
  const navigate = useNavigate();
  // The morning panel. Optional prop rather than a context read so the screen
  // stays constructible in a test without an auth provider, and so a signed-out
  // render simply has no check-in rather than throwing.
  const [checkInOpen, setCheckInOpen] = useState(false);
  const unit = useUnit();
  const [list, setList] = useState<WorkoutList | null>(null);
  const [stale, setStale] = useState<StaleReason | null>(null);
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  // false until the done-state read has answered or been served from cache.
  // An empty `doneIds` before that is "not known", not "nothing is done", and
  // would otherwise read every past day as MISSED.
  const [doneKnown, setDoneKnown] = useState(false);
  // Lazily loaded per row, same idea as `rx`/`loadRx` below: a whole
  // week's worth of these costs real reads for a number most days never
  // show. Keyed by workout id; a day with no cached entry (an older DONE
  // day, or one finished on another device) just renders without this
  // line — the app records what it can confirm, never what it guesses.
  const [doneSummary, setDoneSummary] = useState<Record<string, DoneSummary>>(
    {},
  );
  const [active, setActive] = useState<ActiveSession | null>(null);
  const [rx, setRx] = useState<Record<string, ResolvedPrescriptionRow[]>>({});
  // A missing row alone is ambiguous: it can mean a request is still in
  // flight or that it failed. Train needs the difference so it does not leave
  // a failed details request looking like an endless load.
  const [rxLoadState, setRxLoadState] = useState<
    Record<string, PrescriptionLoadState>
  >({});
  // Bumped every time onPlanChanged clears rx below. A getResolvedPrescriptions
  // call already in flight when that happens captures the generation it
  // started on; if the generation has moved by the time it resolves, the plan
  // changed again out from under it and its (now-stale) rows must not be
  // written back in on top of a fresher load.
  const rxGenerationRef = useRef(0);
  // A cached row prevents later reads only after it resolves. Several effects
  // can need the same row in that gap (Program selection, undated auto-open,
  // and Train), so remember the in-flight generation as well. A plan change
  // gets a new generation and deliberately starts a fresh read.
  const rxInFlightRef = useRef(new Map<string, number>());
  // null while loading or loaded; otherwise WHY the load failed, because
  // "offline" and "the server refused" need different words below
  const [loadError, setLoadError] = useState<StaleReason | null>(null);
  // The calendar day, LIVE. An installed PWA is resumed, not reloaded: iOS
  // brings this screen back on Tuesday morning with Monday's render still on
  // it, and a `today` captured once meant Monday's "Start session" was the
  // button under the thumb. `sets` is append-only, so a session started
  // against the wrong planned day is not correctable afterwards.
  const today = useLocalToday();
  // week strip selection + LATER-list accordion
  const requestedDate = requestedDateFrom(useLocation().search);
  const [selectedDate, setSelectedDate] = useState<string>(
    requestedDate ?? today,
  );
  // A link from Train's week strip names the day it means; honour it even
  // when this screen was already mounted on the other route.
  useEffect(() => {
    if (requestedDate !== null) setSelectedDate(requestedDate);
  }, [requestedDate]);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  // A session insert can commit while the separate active-session cache write
  // fails (for example, a large kv store hitting quota). Hold that durable
  // session here rather than offering a second Start or navigating to Session
  // without the pointer it needs to bootstrap.
  const [startRecovery, setStartRecovery] = useState<ActiveSession | null>(
    null,
  );
  const [laterExpanded, setLaterExpanded] = useState<string | null>(null);
  // Mirrors laterExpanded for onPlanChanged, like expandedRef below.
  const laterExpandedRef = useRef<string | null>(null);
  useEffect(() => {
    laterExpandedRef.current = laterExpanded;
  }, [laterExpanded]);
  // undated-program fallback keeps the old expandable ruled list
  const [expanded, setExpanded] = useState<string | null>(null);
  // Mirrors `expanded` for onPlanChanged below, which must read the row
  // someone currently has open without taking it as a dependency (its own
  // effect only needs to (re)subscribe once, on mount).
  const expandedRef = useRef<string | null>(null);
  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);
  // a same-day open session this device has no cache for
  const [orphan, setOrphan] = useState<OpenSessionRow | null>(null);
  const [orphanArm, setOrphanArm] = useArmed();
  // bumped when reconciliation closes sessions, so DONE states refresh
  const [doneTick, setDoneTick] = useState(0);
  // false until we know whether a session is already open (locally or on the
  // server), so no Start button is live while that is still an open question
  const [startGateOpen, setStartGateOpen] = useState(false);
  const firstRunDismissed = useSetting("firstRunDismissed");

  /**
   * Follow the clock — unless the person went somewhere on purpose.
   *
   * `selectedDate` carries two meanings that look identical in the state:
   * "today, because that is where this screen opens" and "this day, because I
   * tapped it". Re-seeding both would yank the strip out from under someone
   * reading next Thursday's plan at midnight; re-seeding neither IS the bug —
   * a screen still sitting on yesterday, still offering yesterday's Start.
   *
   * What tells them apart is what the day USED to be. If the selection was
   * still the old today, this screen was showing "today" and should carry on
   * showing today. Anything else was a deliberate choice and it stands.
   * Tapping today's own cell is deliberate too, but it is a choice of TODAY,
   * so carrying it forward is exactly what that person asked for.
   */
  const prevTodayRef = useRef(today);
  useEffect(() => {
    const was = prevTodayRef.current;
    if (was === today) return;
    prevTodayRef.current = today;
    setSelectedDate((d) => (d === was ? today : d));
  }, [today]);

  // The most recent confirmed program is `program`: it owns new days and is
  // the one named when there is only one. Confirmed programs are not mutually
  // exclusive, though, and showing only programs[0] silently hid a second
  // one's days. When ANY confirmed program has dated days, the week shows the
  // days of ALL of them (they share one calendar, and getDoneWorkoutIds is
  // read per program). Undated DAY 1..N programs have no shared order, so
  // there only programs[0] is shown, and the others are NAMED, never hidden.
  const program = list?.programs[0] ?? null;
  const shownPrograms = useMemo(() => {
    if (!list || !program) return [];
    const ids = new Set(list.programs.map((p) => p.id));
    const dated = list.workouts.some(
      (w) => ids.has(w.program_id) && w.scheduled_date !== null,
    );
    return dated ? list.programs : [program];
  }, [list, program]);
  const otherProgramNames = useMemo(
    () =>
      (list?.programs ?? [])
        .filter((p) => !shownPrograms.some((s) => s.id === p.id))
        .map((p) => p.name),
    [list, shownPrograms],
  );
  const firstRun = showFirstRun({
    loaded: list !== null,
    hasProgram: program !== null,
    dismissed: firstRunDismissed,
  });
  const workouts = useMemo(
    () =>
      shownPrograms.length > 0
        ? (list?.workouts ?? [])
            .filter((w) => shownPrograms.some((p) => p.id === w.program_id))
            .sort(weekOrder)
        : [],
    [list, shownPrograms],
  );

  // Only the newest reload may write state: a slow mount read answering
  // after a coach edit's reload would otherwise put the old plan back (A-13).
  const listGenRef = useRef(0);
  const reload = useCallback(() => {
    const gen = ++listGenRef.current;
    getPlannedWorkouts()
      .then((r) => {
        if (gen !== listGenRef.current) return;
        setList(r.data);
        setStale(r.stale);
        setLoadError(null);
      })
      .catch((e: unknown) => {
        if (gen !== listGenRef.current) return;
        setLoadError(staleReason(e));
        reportError(e, "load workouts");
      });
  }, []);

  /** Mirrors `active` for the reconciliation effect, which must be able to
   *  read it without taking it as a dependency: re-running the whole
   *  reconciliation every time a session starts or ends is not what it is
   *  for. Declared above that effect so the mirror is always the newer
   *  commit. */
  const activeRef = useRef<ActiveSession | null>(null);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  /** False until reconciliation has run once, which is what separates the
   *  mount run from a midnight re-run. */
  const reconciledRef = useRef(false);

  useEffect(() => {
    // Crossing midnight mid-workout is ordinary — a 23:50 start — and this
    // effect now re-runs when it happens. Reconciliation would then see a
    // session "started yesterday", auto-complete it at the last logged set
    // and clear the active pointer out from under someone who is still
    // lifting. So the DAY-CHANGE re-run stands down while this device holds a
    // live session; the mount run never does, because an active pointer at
    // yesterday's session is exactly what a fresh launch has to clear. A
    // genuinely abandoned session is still caught on the next launch, or the
    // next time this screen is opened without one in progress.
    if (reconciledRef.current && activeRef.current !== null) return;
    reconciledRef.current = true;
    let cancelled = false;
    // A slow network must not hold the gym hostage: if reconciliation has
    // not answered by then, starting is allowed again and a double start
    // still lands in the orphan card rather than being lost.
    const gateTimer = window.setTimeout(() => {
      if (!cancelled) setStartGateOpen(true);
    }, GATE_TIMEOUT_MS);
    void (async () => {
      const a =
        (await cacheGet<ActiveSession>(cacheKeys.activeSession)) ?? null;
      const queuedRecovery =
        a === null ? queuedSessionRecovery(await outbox.inspect()) : null;
      if (cancelled) return;
      if (queuedRecovery !== null) {
        setStartRecovery(queuedRecovery);
        window.clearTimeout(gateTimer);
        setStartGateOpen(true);
        return;
      }
      setActive(a);
      reload();
      // Reconcile open sessions with the calendar: yesterday's open session
      // auto-completes (or auto-discards if empty), a stale local pointer is
      // cleared, and a same-day session with no local cache is surfaced.
      // Flush first so a finish/discard queued offline isn't misread as an
      // abandoned open session; anything still queued after the flush is
      // excluded outright.
      try {
        await outbox.flush();
        const pendingUpdates = await outbox.pendingSessionUpdateIds();
        const r = await syncOpenSessions(
          a?.id ?? null,
          (iso) => todayLocalIso(new Date(iso)),
          today,
          pendingUpdates,
        );
        if (cancelled) return;
        if (r.clearedActive) setActive(null);
        if (r.autoCompleted > 0)
          toast(
            r.autoCompleted === 1
              ? "An unfinished session from a past day was auto-completed"
              : `${r.autoCompleted} unfinished sessions were auto-completed`,
          );
        if (r.autoDiscarded > 0)
          toast("An empty unfinished session was cleaned up");
        // Unconditional: the flush above may have just landed a queued
        // end/discard, and the week state read races it otherwise.
        setDoneTick((t) => t + 1);
        setOrphan(r.orphan);
      } catch {
        // offline: reconcile on the next online launch
      } finally {
        window.clearTimeout(gateTimer);
        if (!cancelled) setStartGateOpen(true);
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(gateTimer);
    };
    // `today` is a dependency, not a coincidence: crossing midnight is exactly
    // when yesterday's still-open session has to be auto-completed and the
    // week's DONE states re-read. Without it, reconciliation ran once at
    // mount and a resumed app carried yesterday's answer all day.
    //
    // The re-run deliberately does NOT close the start gate again. The gate
    // exists to stop a start before we know whether a session is already open,
    // and we already know: an open session is held in `active`, which the
    // re-run leaves alone until it has a better answer. Re-closing it would
    // disable every Start button for a couple of seconds at midnight, which is
    // mid-session for anyone training late.
  }, [reload, today]);

  useEffect(() => {
    if (shownPrograms.length === 0 || workouts.length === 0) return;
    // A newer week or plan supersedes this read (A-13).
    let cancelled = false;
    const reads = shownPrograms.map((p) =>
      getDoneWorkoutIds(
        p.id,
        workouts.filter((w) => w.program_id === p.id).map((w) => w.id),
      ).then(
        (r) => ({ ok: true as const, ids: r.data }),
        (e: unknown) => {
          if (!cancelled) reportError(e, "load week state");
          return { ok: false as const, ids: [] as string[] };
        },
      ),
    );
    void Promise.all(reads).then((rs) => {
      if (cancelled) return;
      // A failed read keeps what was known before it; it only ever stops us
      // from CLAIMING to know.
      if (rs.every((r) => r.ok)) {
        setDoneIds(new Set(rs.flatMap((r) => r.ids)));
        setDoneKnown(true);
      } else {
        setDoneIds((prev) => new Set([...prev, ...rs.flatMap((r) => r.ids)]));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [shownPrograms, workouts, doneTick]);

  // Which DONE days get "Review with the coach": the ones whose session ended
  // in the last 24 hours (lib/review.ts). Read only while online — the coach
  // needs a connection, so an offline device has nothing to offer — and re-read
  // whenever the DONE set can have changed. A failed read is reported, not
  // swallowed, and leaves the card without the button rather than blank.
  const online = useOnline();
  const [reviewable, setReviewable] = useState<Map<string, EndedSession>>(
    new Map(),
  );
  useEffect(() => {
    if (!online || doneIds.size === 0) {
      setReviewable(new Map());
      return;
    }
    let cancelled = false;
    getRecentlyEndedSessions()
      .then((rows) => {
        if (!cancelled) setReviewable(reviewableByDay(rows));
      })
      .catch((e: unknown) => reportError(e, "load reviewable sessions"));
    return () => {
      cancelled = true;
    };
  }, [online, doneIds]);

  const anyDates = workouts.some((w) => w.scheduled_date !== null);
  const weekStart = useWeekStartsOn();
  // Anchored on the SELECTED day, not on today, so picking a date in another
  // week from the calendar moves the strip to that week instead of silently
  // showing this one.
  const pages = useMemo(
    () => weekPages(selectedDate, weekStart),
    [selectedDate, weekStart],
  );
  const weekDates = pages[1];
  const weekAnchor = startOfWeek(selectedDate, weekStart);

  const trackRef = useRef<HTMLDivElement | null>(null);
  const settleRef = useRef(0);
  const parkedAtRef = useRef(0);

  /**
   * Put the track back on the middle page, which is always the selected week.
   *
   * Snapping is turned OFF for the jump. A swipe leaves the track resting on
   * page 0 or 2; the week then becomes the selected one and the three pages
   * re-render around it, and the browser's re-snap drags the scroll back to
   * the page the finger left on. That scroll settles as another swipe, and
   * the strip runs away a week at a time — which is exactly what it did.
   */
  const park = useCallback((el: HTMLDivElement | null) => {
    if (el === null || el.clientWidth === 0) return;
    parkedAtRef.current = Date.now();
    window.clearTimeout(settleRef.current);
    el.style.scrollSnapType = "none";
    el.scrollLeft = el.clientWidth;
    // Next frame is the right moment (after layout, before paint), but rAF
    // does not run in a hidden tab and the strip must never come back with
    // snapping left off — so a timer backstops it.
    const restore = () => {
      el.style.scrollSnapType = "";
    };
    requestAnimationFrame(restore);
    window.setTimeout(restore, PARK_GUARD_MS);
  }, []);

  /** A callback ref as well as the effect below, because the strip mounts
   *  late — it waits for the plan list — and a mount after the last week
   *  change would come up showing last week. */
  const centreTrack = useCallback(
    (el: HTMLDivElement | null) => {
      trackRef.current = el;
      park(el);
    },
    [park],
  );

  useLayoutEffect(() => {
    park(trackRef.current);
  }, [weekAnchor, park]);

  useEffect(() => {
    // A rotation changes the page width; the track has to be re-parked or the
    // strip comes back resting between two weeks.
    const onResize = () => park(trackRef.current);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.clearTimeout(settleRef.current);
    };
  }, [park]);

  /** Settling, not `scrollend`: iOS Safari only got that event recently and
   *  this has to work on the phone in the gym. */
  const onTrackScroll = () => {
    const el = trackRef.current;
    if (el === null || el.clientWidth === 0) return;
    window.clearTimeout(settleRef.current);
    settleRef.current = window.setTimeout(() => {
      if (Date.now() - parkedAtRef.current < PARK_GUARD_MS) return;
      const page = Math.round(el.scrollLeft / el.clientWidth);
      if (page === 1) return;
      setSelectedDate((d) => weekPageDate(d, page));
    }, SETTLE_MS);
  };

  const states = useMemo(
    () => workoutStates(workouts, doneIds, anyDates, today, doneKnown),
    [workouts, doneIds, anyDates, today, doneKnown],
  );

  const doneCount = workouts.filter((w) => states.get(w.id) === "DONE").length;
  const skippedCount = workouts.filter(
    (w) => states.get(w.id) === "SKIPPED",
  ).length;

  // calendar derivations
  const byDate = useMemo(() => {
    const m = new Map<string, PlannedWorkoutRow>();
    // weekOrder sorts chronologically; first workout on a date wins the cell
    for (const w of workouts)
      if (w.scheduled_date && !m.has(w.scheduled_date))
        m.set(w.scheduled_date, w);
    return m;
  }, [workouts]);
  /** ISO day -> what the calendar should mark on it. */
  const calendarDays = useMemo(() => {
    const m = new Map<string, CalendarDay>();
    for (const w of workouts) {
      if (w.scheduled_date === null) continue;
      const st = states.get(w.id);
      const prev = m.get(w.scheduled_date);
      m.set(w.scheduled_date, {
        planned: true,
        // A date can hold more than one workout. Done wins over skipped wins
        // over planned, so a day with anything finished on it reads as done.
        done: (prev?.done ?? false) || st === "DONE",
        skipped: (prev?.skipped ?? false) || st === "SKIPPED",
      });
    }
    return m;
  }, [workouts, states]);

  const laterWorkouts = useMemo(
    () =>
      workouts.filter(
        (w) =>
          !w.scheduled_date ||
          !weekDates.includes(w.scheduled_date) ||
          byDate.get(w.scheduled_date)?.id !== w.id, // same-day overflow
      ),
    [workouts, weekDates, byDate],
  );
  const outsideWeek = useMemo(
    () => splitOutsideWeek(laterWorkouts, weekDates),
    [laterWorkouts, weekDates],
  );
  const selectedWorkout = anyDates ? (byDate.get(selectedDate) ?? null) : null;

  // The one DONE day open at a time — the dated week-strip's
  // `selectedWorkout`, or the undated DAY 1..N list's `expanded` row —
  // reads its own summary once we know it's DONE. `dayDetail` is the
  // single function both presentations call, so this covers both.
  useEffect(() => {
    const id = anyDates ? (selectedWorkout?.id ?? null) : expanded;
    if (!id || states.get(id) !== "DONE" || id in doneSummary) return;
    void cacheGet<DoneSummary>(doneSummaryKey(id)).then((s) => {
      if (s) setDoneSummary((prev) => ({ ...prev, [id]: s }));
    });
  }, [anyDates, selectedWorkout, expanded, states, doneSummary]);
  // Mirrors selectedWorkout's id for the same reason expandedRef mirrors
  // expanded: onPlanChanged below needs the currently-visible dated day
  // without resubscribing every time the selection changes.
  const selectedWorkoutIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedWorkoutIdRef.current = selectedWorkout?.id ?? null;
  }, [selectedWorkout]);

  /** Fresh fetch for a caller that knows it needs rows (including
   *  onPlanChanged). Repeats within one generation coalesce; a plan change
   *  advances the generation, so it still starts its own fresh read. */
  const fetchRx = useCallback((workoutId: string) => {
    const generation = rxGenerationRef.current;
    if (rxInFlightRef.current.get(workoutId) === generation) return;
    rxInFlightRef.current.set(workoutId, generation);
    setRxLoadState((prev) => ({ ...prev, [workoutId]: "loading" }));
    getResolvedPrescriptions(workoutId)
      .then((r) => {
        if (rxGenerationRef.current !== generation) return;
        setRx((prev) => ({ ...prev, [workoutId]: r.data }));
        setRxLoadState((prev) => ({
          ...prev,
          [workoutId]: r.stale === null ? "loaded" : `cached-${r.stale}`,
        }));
      })
      .catch((e: unknown) => {
        if (rxGenerationRef.current !== generation) return;
        setRxLoadState((prev) => ({
          ...prev,
          [workoutId]: staleReason(e),
        }));
        reportError(e, "load prescriptions");
      })
      .finally(() => {
        if (rxInFlightRef.current.get(workoutId) === generation)
          rxInFlightRef.current.delete(workoutId);
      });
  }, []);

  const loadRx = useCallback(
    (workoutId: string) => {
      if (workoutId in rx) return;
      fetchRx(workoutId);
    },
    [rx, fetchRx],
  );

  useEffect(() => {
    if (selectedWorkout) loadRx(selectedWorkout.id);
  }, [selectedWorkout, loadRx]);

  // undated fallback: today's row auto-expands once
  const autoExpanded = useRef(false);
  useEffect(() => {
    if (anyDates || autoExpanded.current || expanded !== null) return;
    const todayId = workouts.find((w) => states.get(w.id) === "TODAY")?.id;
    if (!todayId) return;
    autoExpanded.current = true;
    setExpanded(todayId);
    loadRx(todayId);
  }, [anyDates, states, workouts, expanded, loadRx]);

  // Coach plan writes do not pass through the PWA's data helpers, so those
  // helpers cannot invalidate their own cache. Return this screen to today
  // and drop every cached prescription — but a blanket clear with nothing
  // reloaded is exactly the bug: a dated day's card falls out through
  // selectedWorkout's own effect once `list` refreshes, but an undated
  // DAY 1..N program has no selectedWorkout at all, and the row someone
  // tapped open (`expanded`) is the only "currently visible" one. Its
  // auto-expand effect above will not rerun either — autoExpanded.current is
  // already set — so nothing else will ever ask for it again. Reload both
  // directly, bumping the generation first so an in-flight fetchRx from
  // before the change cannot write its stale rows back in afterwards.
  useEffect(
    () =>
      onPlanChanged(() => {
        rxGenerationRef.current += 1;
        setSelectedDate(today);
        setRx({});
        setRxLoadState({});
        reload();
        if (selectedWorkoutIdRef.current) fetchRx(selectedWorkoutIdRef.current);
        if (expandedRef.current) fetchRx(expandedRef.current);
        if (laterExpandedRef.current) fetchRx(laterExpandedRef.current);
      }),
    [reload, today, fetchRx],
  );

  const setSkipped = async (w: PlannedWorkoutRow, skipped: boolean) => {
    try {
      await updatePlannedWorkout(w.id, {
        skipped_at: skipped ? new Date().toISOString() : null,
      });
      toast(skipped ? "Workout skipped" : "Workout back on the plan");
      reload();
    } catch (e) {
      reportError(e, skipped ? "skip workout" : "unskip workout");
    }
  };

  const startingRef = useRef(false);
  /**
   * Create a planned day for `date` and go straight to its editor.
   *
   * Dated by construction: an undated day leaves the calendar entirely (the
   * week strip disappears and the screen falls back to a DAY 1..N list), so
   * planning starts from the day being planned rather than from a form with an
   * optional date field.
   */
  const planDay = (date: string) => {
    if (creating) return;
    setCreating(true);
    createPlannedWorkout(date, "")
      .then((id) => navigate(`/plan/${id}`))
      .catch((e: unknown) => reportError(e, "plan a day"))
      .finally(() => setCreating(false));
  };

  /**
   * Drop a saved workout onto the selected day. The loads are refreshed from
   * the last set actually logged for each exercise, which is the whole point
   * of the feature, so the toast says how many were refreshed rather than
   * leaving the person to spot it.
   */
  const useTemplate = (templateId: string, name: string) => {
    if (creating) return;
    setCreating(true);
    void (async () => {
      try {
        const actuals = (await getLastActuals()).data;
        // A template needs a program to live in. Reuse the confirmed one when
        // there is one; otherwise make only the program, never a throwaway
        // dated day beside the template's own (PLAN-4).
        const pid = program?.id ?? (await ensureConfirmedProgramId());
        const res = await applyTemplate(templateId, pid, selectedDate, actuals);
        setTemplatesOpen(false);
        toast(
          res.refreshed > 0
            ? `${name} added — ${res.refreshed} of ${res.total} weights updated from your last sessions`
            : `${name} added — no logged history yet, so the saved weights were kept`,
        );
        navigate(`/plan/${res.workoutId}`);
      } catch (e) {
        reportError(e, "use template");
      } finally {
        setCreating(false);
      }
    })();
  };

  const start = async (workout: PlannedWorkoutRow | null) => {
    if (startingRef.current) return; // double-tap = one session
    startingRef.current = true;
    try {
      const sessionId = uuid();
      const startedAt = new Date().toISOString();
      let prescriptions: ResolvedPrescriptionRow[] = [];
      if (workout) {
        try {
          // always fetch fresh: in-memory rx can be hours old on a PWA
          // resumed from the background (plan edited elsewhere meanwhile)
          prescriptions = (await getResolvedPrescriptions(workout.id)).data;
        } catch {
          prescriptions = rx[workout.id] ?? [];
          if (prescriptions.length === 0)
            toast(
              "Targets unavailable offline — logging by feel; history still prefills",
            );
        }
      }
      const activeSession: ActiveSession = {
        id: sessionId,
        planned_workout_id: workout?.id ?? null,
        started_at: startedAt,
        workout_label: workout?.label ?? null,
        plan_note: workout?.plan_note ?? null,
        coach_note: workout?.notes ?? null,
      };
      // Queue the parent session before publishing any cache pointer to it.
      // A session screen can recover an orphan whose cache was lost; it
      // cannot recover a cache pointer to a session that never reached the
      // durable local queue.
      await outbox.enqueue({
        kind: "insert",
        table: "sessions",
        payload: {
          id: sessionId,
          planned_workout_id: workout?.id ?? null,
          started_at: startedAt,
        },
      });
      try {
        await cacheSet(cacheKeys.activeSession, activeSession);
      } catch (e) {
        reportError(e, "cache active session for start");
        setStartRecovery(activeSession);
        return;
      }
      setActive(activeSession);
      // Targets make this session better offline, but they are not its
      // identity. Cache the active pointer first so a quota failure while
      // storing a large planned workout still opens a recoverable by-feel
      // session instead of stranding the durable parent row.
      try {
        await cacheSet(cacheKeys.sessionRx(sessionId), prescriptions);
      } catch (e) {
        reportError(e, "cache session targets for start");
      }
      // Best-effort prefetch so the session screen works fully offline.
      // Both read through the IndexedDB cache, so these only reject when
      // there is no cache at all — worth reporting, never worth swallowing.
      void getExercises().catch((e: unknown) =>
        reportError(e, "prefetch exercise list"),
      );
      void getLastActuals(sessionId).catch((e: unknown) =>
        reportError(e, "prefetch last actuals"),
      );
      navigate("/session");
    } catch (e) {
      reportError(e, "start session");
    } finally {
      startingRef.current = false;
    }
  };

  const retryOpenSavedSession = async () => {
    if (!startRecovery) return;
    try {
      await cacheSet(cacheKeys.activeSession, startRecovery);
      setActive(startRecovery);
      setStartRecovery(null);
      navigate("/session");
    } catch (e) {
      reportError(e, "retry active session cache");
    }
  };

  const dayLabel = (w: PlannedWorkoutRow): string =>
    w.scheduled_date
      ? formatPlannedDate(w.scheduled_date)
      : `DAY ${w.day_index + 1}`;

  const stateLabel = (state: WorkoutState): string =>
    state === "UPCOMING" ? "TO COME" : state === "DRAFT" ? "EMPTY" : state;

  const moveToToday = (w: PlannedWorkoutRow) =>
    void (async () => {
      try {
        // One clock read, used twice: two calls a millisecond apart could
        // straddle midnight and select a day the workout was not moved to.
        const iso = todayLocalIso();
        await updatePlannedWorkout(w.id, { scheduled_date: iso });
        toast("Moved to today");
        setSelectedDate(iso);
        reload();
      } catch (e) {
        reportError(e, "move workout to today");
      }
    })();

  /** Rebuild the local caches for a server-side open session (started on
   *  another device or before storage was cleared) and take it over. */
  const adoptOrphan = async (s: OpenSessionRow, dest: "/session" | "/end") => {
    try {
      let label: string | null = null;
      let rxRows: ResolvedPrescriptionRow[] = [];
      const plannedWorkout = s.planned_workout_id
        ? (list?.workouts.find((w) => w.id === s.planned_workout_id) ?? null)
        : null;
      if (s.planned_workout_id) {
        label = plannedWorkout?.label ?? null;
        try {
          rxRows = (await getResolvedPrescriptions(s.planned_workout_id)).data;
        } catch {
          rxRows = [];
        }
      }
      await cacheSet(cacheKeys.sessionRx(s.id), rxRows);
      try {
        // exercises already logged but not prescribed become extras again
        const sets = await getServerSessionSets(s.id);
        const known = new Set(rxRows.map((r) => r.exercise_id));
        const lib = (await getExercises()).data;
        const extras = [...new Set(sets.map((x) => x.exercise_id))]
          .filter((id) => !known.has(id))
          .map((id) => ({
            exercise_id: id,
            name: lib.find((e) => e.id === id)?.name ?? id,
          }));
        await cacheSet(cacheKeys.sessionExtras(s.id), extras);
      } catch {
        // best-effort; the session screen also merges server sets itself
      }
      const adopted: ActiveSession = {
        id: s.id,
        planned_workout_id: s.planned_workout_id,
        started_at: s.started_at,
        workout_label: label,
        plan_note: plannedWorkout?.plan_note ?? null,
        coach_note: plannedWorkout?.notes ?? null,
      };
      await cacheSet(cacheKeys.activeSession, adopted);
      setOrphan(null);
      navigate(dest);
    } catch (e) {
      reportError(e, "recover open session");
    }
  };

  const discardOrphan = async (s: OpenSessionRow) => {
    try {
      await outbox.enqueue({
        kind: "update",
        table: "sessions",
        id: s.id,
        patch: { discarded_at: new Date().toISOString() },
      });
      // Queued is not accepted. Let the queue say which it was before
      // claiming anything about the record (UI-18).
      await outbox.flush();
      const outcome = discardOutcome(await outbox.inspect(), s.id);
      if (outcome === "refused") {
        toast(
          "The server won't discard a session that has sets. Open it to finish it instead.",
          "error",
        );
        return;
      }
      await invalidateForSessionClose();
      setOrphan(null);
      setDoneTick((t) => t + 1);
      toast(
        outcome === "queued"
          ? "Discard saved on this phone. It applies when you're back online."
          : "Session discarded",
      );
    } catch (e) {
      reportError(e, "discard open session");
    }
  };

  /** One preview row per exercise: consecutive same-exercise prescriptions
   *  (a coach's ramp brackets) collapse into a single joined scheme, e.g.
   *  "1×8-15 · 1×6-8 · 3×3-5". Same rule as the session accordion — shared,
   *  because the two screens disagreeing about how many exercises a day has
   *  is not something anything would catch. */
  const groupedRx = (workoutId: string) => groupRamps(rx[workoutId] ?? []);

  /** One day of the strip. `live` is false for the weeks either side of the
   *  selected one: they are drawn but unreachable until swiped to. */
  const weekCell = (iso: string, live: boolean) => {
    const w = byDate.get(iso) ?? null;
    const cellState: WorkoutState | "REST" = w
      ? (states.get(w.id) ?? "UPCOMING")
      : "REST";
    const isToday = iso === today;
    const isSelected = live && iso === selectedDate;
    return (
      <button
        key={iso}
        type="button"
        tabIndex={live ? undefined : -1}
        aria-current={isSelected ? "date" : undefined}
        aria-label={`${parseLocalDate(iso).toLocaleDateString("en-GB", {
          weekday: "long",
        })} ${parseLocalDate(iso).getDate()}${
          w
            ? `, ${
                cellState === "REST"
                  ? "rest day"
                  : stateLabel(cellState as WorkoutState).toLowerCase()
              }`
            : ", rest day"
        }`}
        className={`week-cell ${isToday ? "week-cell-today" : ""} ${isSelected ? "week-cell-selected" : ""}`}
        onClick={() => {
          setSelectedDate(iso);
          if (w) loadRx(w.id);
        }}
      >
        <span className="week-cell-letter">{formatWeekdayLetter(iso)}</span>
        <span
          className={`week-cell-num ${
            cellState === "MISSED"
              ? "week-cell-num-missed"
              : cellState === "SKIPPED"
                ? "week-cell-num-skipped"
                : cellState === "REST"
                  ? "week-cell-num-rest"
                  : cellState === "UPCOMING"
                    ? "week-cell-num-upcoming"
                    : ""
          }`}
        >
          {parseLocalDate(iso).getDate()}
        </span>
        <span className="week-cell-mark">
          {cellState === "DONE" && <span className="week-cell-dot" />}
        </span>
      </button>
    );
  };

  /** Exactly one start affordance may be live at a time. An active session
   *  owns the screen (the RESUME banner is the primary); an unrecovered
   *  orphan owns it next (its card asks resume/finish/discard) — starting a
   *  second concurrent session from underneath either is not recoverable
   *  from the UI. */
  const canStart = startGateOpen && !active && !orphan && !startRecovery;

  const trainWorkoutToday = trainWorkoutForToday(workouts, states, today);
  const nextTrainWorkout = nextActionableWorkout(workouts, states, today);
  const promoteNextWorkout =
    trainWorkoutToday?.state === "DONE" && nextTrainWorkout !== null;
  const trainWorkout = promoteNextWorkout
    ? { workout: nextTrainWorkout, state: "UPCOMING" as const }
    : (trainWorkoutToday ??
      (nextTrainWorkout
        ? { workout: nextTrainWorkout, state: "UPCOMING" as const }
        : null));
  const trainWorkoutId = trainWorkout?.workout.id ?? null;
  const trainPrescriptions = trainWorkout
    ? (rx[trainWorkout.workout.id] ?? null)
    : null;
  const trainPrescriptionLoadState: PrescriptionLoadState =
    trainWorkout === null
      ? "loaded"
      : trainPrescriptions === null
        ? (rxLoadState[trainWorkout.workout.id] ?? "loading")
        : (rxLoadState[trainWorkout.workout.id] ?? "loaded");
  // Program can be left while its calendar is on another day. Train still
  // needs today's shape, so ask the existing prescription loader for today's
  // row rather than inheriting that unrelated selection or creating a second
  // fetch path.
  useEffect(() => {
    if (presentation === "train" && trainWorkoutId) loadRx(trainWorkoutId);
  }, [presentation, trainWorkoutId, loadRx]);
  // The Train strip is THIS week, anchored on today (Program's strip follows
  // its own selection). A program with no dates has no calendar to draw.
  const trainWeek: TrainWeekDay[] | null =
    list !== null && anyDates
      ? calendarWeek(today, weekStart).map((iso) => {
          const d = parseLocalDate(iso);
          // every workout on the date, not the first one (T5)
          const onDay = workouts
            .filter((w) => w.scheduled_date === iso)
            .map((w) => states.get(w.id) ?? "UPCOMING");
          return {
            iso,
            letter: formatWeekdayLetter(iso),
            name: `${d.toLocaleDateString("en-GB", { weekday: "long" })} ${d.getDate()}`,
            state: dayStripState(onDay) as TrainWeekDay["state"],
            isToday: iso === today,
          };
        })
      : null;
  // The outbox, read itself. Its counts are global (every table, every
  // account) and start at zero before the first read, which is exactly the
  // shape that used to say "all sets on the server" on every cold start.
  // `null` = not read yet.
  const outboxStatus = useOutboxStatus();
  const [outboxEntries, setOutboxEntries] = useState<
    readonly OutboxEntry[] | null
  >(null);
  // Only the finished-today confirmation speaks about the server, so only it
  // pays for the read.
  const needsSyncLine =
    presentation === "train" && trainWorkoutToday?.state === "DONE";
  useEffect(() => {
    if (!needsSyncLine) return;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await outbox.inspect();
        if (!cancelled) setOutboxEntries(rows);
      } catch {
        if (!cancelled) setOutboxEntries(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [needsSyncLine, outboxStatus]);
  // Exact-UUID receipts for the session that finished today, the same proof
  // the Session screen shows per set. Only while online and only when the
  // session is known (reviewable lists sessions ended in the last day).
  const finishedSessionId =
    needsSyncLine && trainWorkoutToday
      ? (reviewable.get(trainWorkoutToday.workout.id)?.id ?? null)
      : null;
  // The proof belongs to the session it was read for (F-7): a second finished
  // session the same day must not borrow the first one's "N confirmed" while
  // its own read is in flight (or hangs offline).
  const [finishedProofState, setFinishedProof] =
    useState<TaggedFinishedProof | null>(null);
  const finishedProof = proofForSession(finishedProofState, finishedSessionId);
  useEffect(() => {
    if (!finishedSessionId || !userId || !online) {
      setFinishedProof(null);
      return;
    }
    let cancelled = false;
    void readFinishedSessionProof(finishedSessionId, userId).then((proof) => {
      if (!cancelled) setFinishedProof({ sessionId: finishedSessionId, proof });
    });
    return () => {
      cancelled = true;
    };
  }, [finishedSessionId, userId, online, outboxStatus]);
  const trainSync = (() => {
    const rows = outboxEntries ?? [];
    const setRows = rows.filter((e) => e.table === "sets");
    return {
      checked: outboxEntries !== null,
      identityKnown: Boolean(userId),
      waiting: setRows.filter((e) => e.state === "waiting").length,
      held: setRows.filter((e) => e.state === "held").length,
      dead: setRows.filter((e) => e.state === "dead").length,
      otherPending: rows.length - setRows.length,
      proof: finishedProof,
    };
  })();
  // Sets logged in the open session: what the server has plus what this phone
  // still holds, less corrections still waiting to land. null = not known (a
  // failed read), which renders as nothing, never as 0.
  const [activeSetCount, setActiveSetCount] = useState<number | null>(null);
  const activeId = active?.id ?? null;
  const activePlannedId = active?.planned_workout_id ?? null;
  useEffect(() => {
    if (presentation !== "train" || !activeId) {
      setActiveSetCount(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const [server, pending, voided] = await Promise.all([
          getServerSessionSets(activeId, { orNull: true }),
          outbox.pendingSets(activeId),
          outbox.pendingVoidIds(),
        ]);
        if (cancelled) return;
        setActiveSetCount(
          server === null
            ? null
            : mergeSets(server, pending).filter((r) => !voided.has(r.id))
                .length,
        );
      } catch {
        if (!cancelled) setActiveSetCount(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [presentation, activeId]);
  // The plan's set total is a separate read, so it does not re-run the count.
  useEffect(() => {
    if (presentation === "train" && activePlannedId) loadRx(activePlannedId);
  }, [presentation, activePlannedId, loadRx]);
  const orphanRecovery = orphan ? (
    <div className="orphan-card">
      <div className="orphan-title">
        OPEN SESSION · STARTED{" "}
        {new Date(orphan.started_at)
          .toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
          })
          .toUpperCase()}
      </div>
      <div className="microcopy">
        Started earlier today but this phone lost track of it. Pick it back up,
        finish it, or discard it.
      </div>
      <div className="detail-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void adoptOrphan(orphan, "/session")}
        >
          Resume
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => void adoptOrphan(orphan, "/end")}
        >
          Finish
        </button>
        <button
          type="button"
          className={`btn ${orphanArm === orphan.id ? "btn-danger" : "btn-ghost"}`}
          onClick={() =>
            orphanArm === orphan.id
              ? void discardOrphan(orphan)
              : setOrphanArm(orphan.id)
          }
        >
          {orphanArm === orphan.id ? "Discard?" : "Discard"}
        </button>
      </div>
    </div>
  ) : null;
  const startRecoveryCard = startRecovery ? (
    <div className="train-recovery" role="alert">
      <p>
        Your session was saved locally, but we couldn’t open it because this
        device could not save its session pointer. Do not start another workout.
      </p>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => void retryOpenSavedSession()}
      >
        Retry opening session
      </button>
    </div>
  ) : null;
  const recovery = startRecoveryCard ?? orphanRecovery;

  if (presentation === "train") {
    return (
      <div className="screen" data-presentation={presentation}>
        <TrainHome
          dateContext={formatTodayHeading().replace(/^TODAY · /, "")}
          programName={
            (trainWorkout
              ? list?.programs.find(
                  (p) => p.id === trainWorkout.workout.program_id,
                )?.name
              : undefined) ??
            program?.name ??
            null
          }
          loading={list === null && loadError === null}
          loadIssue={loadError}
          stale={stale}
          workout={trainWorkout}
          prescriptions={trainPrescriptions}
          prescriptionLoadState={trainPrescriptionLoadState}
          active={active}
          recovery={recovery}
          startEnabled={canStart}
          completedToday={promoteNextWorkout}
          finishedToday={
            trainWorkoutToday?.state === "DONE"
              ? trainWorkoutToday.workout
              : null
          }
          sync={trainSync}
          otherPrograms={otherProgramNames}
          week={trainWeek}
          activeProgress={
            active
              ? {
                  setsDone: activeSetCount,
                  setsPlanned: (() => {
                    const rows = active.planned_workout_id
                      ? rx[active.planned_workout_id]
                      : undefined;
                    return rows && rows.length > 0
                      ? rows.reduce((n, r) => n + r.sets, 0)
                      : null;
                  })(),
                }
              : null
          }
          unit={unit}
          onStart={(workout) => void start(workout)}
          onOpenCoach={() => openCoach()}
          onCheckIn={userId ? () => setCheckInOpen(true) : undefined}
        />
        {checkInOpen && userId && (
          <CheckInSheet
            userId={userId}
            localDate={today}
            onClose={() => setCheckInOpen(false)}
          />
        )}
      </div>
    );
  }

  /** shared expanded-day content, hierarchy: primary action → exercises →
   *  collapsed notes → secondary actions */
  const dayDetail = (w: PlannedWorkoutRow) => {
    const state = states.get(w.id) ?? "UPCOMING";
    // undated programs have no calendar gate at all, so any done workout can
    // be re-run there; dated programs restart only from today's card
    const isTodaysCard = w.scheduled_date === today || !anyDates;
    // Named once because three things read it: the button, and the microcopy
    // that only makes sense while the button it contrasts with is on screen.
    // Rescheduling is meaningless in an undated DAY 1..N program, which is
    // exactly the case where "Do this workout now" stands alone.
    const canReschedule =
      canStart &&
      (state === "MISSED" ||
        state === "PAST" ||
        state === "NO DATE" ||
        (state === "UPCOMING" && anyDates));
    const canDoNow = canStart && canDoWorkoutNow(state);
    const doNowLine = doNowMicrocopy(state, canDoNow, canReschedule);
    return (
      <>
        {state === "DONE" && doneSummary[w.id] && (
          <div className="done-summary">
            {doneSummary[w.id].setCount}{" "}
            {doneSummary[w.id].setCount === 1 ? "set" : "sets"} ·{" "}
            {formatDuration(doneSummary[w.id].durationSeconds)}
          </div>
        )}
        {canStart && state === "TODAY" && (
          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={() => void start(w)}
          >
            Start session
          </button>
        )}
        {/* this day IS the session in progress — the banner is its action */}
        {active && active.planned_workout_id === w.id && (
          <div className="microcopy">
            In progress — pick it back up from the RESUME banner above.
          </div>
        )}
        {canStart && state === "DONE" && isTodaysCard && (
          <button
            type="button"
            className="btn btn-outline-ink btn-block"
            onClick={() => void start(w)}
          >
            Start again
          </button>
        )}
        {/* The turn after the session. For a day, while the session that
            finished it is less than 24 hours old: the coach compares what was
            logged to what was planned, proposes a training max where a
            percentage had none, and turns the set notes into cues or next
            time's loads — and writes nothing without a yes. It opens the ONE
            coach sheet (the dock's) with the first turn already sent; the
            offline case is the dock's toast. Not gated on canStart: reviewing
            is not starting, and an open session elsewhere is no reason to
            hide yesterday's review. */}
        {state === "DONE" && reviewable.has(w.id) && (
          <button
            type="button"
            className="btn btn-outline-ink btn-block"
            onClick={() => {
              const s = reviewable.get(w.id);
              if (s) openCoach({ prefill: reviewPrompt(s) });
            }}
          >
            Review with the coach
          </button>
        )}
        {/* Train a day the calendar puts somewhere else, without moving it.
            Gated on `canStart` exactly as today's Start is: while
            reconciliation is still deciding whether a session is already open,
            no start affordance anywhere on this screen is live, and an active
            session or an unrecovered orphan closes all of them — starting a
            second concurrent session from a preview card is no more
            recoverable than starting one from today's.

            Outline, not primary, on purpose. Today's card and an expanded
            LATER row can be on screen together, and today's Start has to stay
            the only primary; this is the deliberate detour, not the default. */}
        {canDoNow && (
          <button
            type="button"
            className="btn btn-outline-ink btn-block"
            onClick={() => void start(w)}
          >
            Do this workout now
          </button>
        )}
        {canReschedule && (
          <button
            type="button"
            className="btn btn-outline-ink btn-block"
            onClick={() => moveToToday(w)}
          >
            Reschedule to today
          </button>
        )}
        {/* The two actions above look alike and mean opposite things, so say
            which is which rather than trusting the labels to carry it.
            Rescheduling asserts the PLAN was wrong and rewrites the date the
            coach wrote; doing it now asserts the plan is right and the lifter
            is off it. Only when BOTH are on offer: naming a control that is
            not on the card (an undated program cannot reschedule) is worse
            than saying nothing. NO DATE offers both controls too but gets its
            own honest line from doNowMicrocopy — it has no date to keep, and
            it is already doable from the button above, so this generic line
            would be both false and redundant with the reschedule option. */}
        {doNowLine && <div className="microcopy">{doNowLine}</div>}
        {state === "DRAFT" && (
          <div className="microcopy">
            Nothing in this day yet — add exercises in Edit.
          </div>
        )}
        {(() => {
          const groups = groupedRx(w.id);
          // a superset letter only means something with a partner
          const ssMembers = new Map<number, number>();
          for (const g of groups) {
            const sg = g[0].superset_group;
            if (sg !== null) ssMembers.set(sg, (ssMembers.get(sg) ?? 0) + 1);
          }
          return groups.map((group) => {
            const first = group[0];
            const letter =
              first.superset_group !== null &&
              (ssMembers.get(first.superset_group) ?? 0) >= 2
                ? String.fromCharCode(64 + first.superset_group)
                : null;
            // coach cues from the program parse — reference text, so the
            // same clamped Note treatment as the plan and coach notes
            const rxNote =
              group.map((r) => r.notes).find((n) => n && n.trim() !== "") ??
              null;
            return (
              <Fragment key={first.id}>
                <div className="rx-row">
                  <span className="rx-name">
                    {letter && <span className="rx-ss">{letter} </span>}
                    {first.exercise_name}
                  </span>
                  <span className="rx-spec">
                    {group.map((r) => formatRxTarget(r, unit)).join(" · ")}
                  </span>
                  {group.some(rxHasNoTm) && (
                    <span className="warn-badge">no TM set</span>
                  )}
                </div>
                {rxNote && <Note label="NOTE" text={rxNote} />}
              </Fragment>
            );
          });
        })()}
        {w.plan_note && <Note label="PLAN NOTE" text={w.plan_note} />}
        {w.notes && <Note label="COACH" text={w.notes} />}
        <div className="detail-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => navigate(`/plan/${w.id}`)}
          >
            Edit
          </button>
          {state !== "DONE" && state !== "SKIPPED" && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void setSkipped(w, true)}
            >
              Skip
            </button>
          )}
          {state === "SKIPPED" && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void setSkipped(w, false)}
            >
              Unskip
            </button>
          )}
        </div>
      </>
    );
  };

  /** A list of days outside the shown week: EARLIER (before it) or LATER
   *  (after it, or undated). Two names because one list called LATER held
   *  August's finished workouts too (UI-08). */
  const outsideSection = (
    title: "EARLIER" | "LATER",
    list: PlannedWorkoutRow[],
  ) => (
    <section className="rule-section" key={title}>
      <div className="section-head">
        <span className="field-label">{title}</span>
        <span className="section-meta">{list.length}</span>
      </div>
      {list.map((w) => {
        const state = states.get(w.id) ?? "UPCOMING";
        const open = laterExpanded === w.id;
        return (
          <div key={w.id} className="week-item">
            <button
              type="button"
              className="week-row"
              onClick={() => {
                setLaterExpanded(open ? null : w.id);
                loadRx(w.id);
              }}
            >
              <span className="week-day">{dayLabel(w)}</span>
              <span className="week-label">
                {workoutName(w)}
                {w.plan_note ? <span className="note-dot"> ·</span> : ""}
              </span>
              <span
                className={`week-state ${state === "MISSED" ? "week-state-missed" : ""} ${state === "NO DATE" ? "week-state-nodate" : ""}`}
              >
                {stateLabel(state)}
              </span>
              <span className="chev">{open ? "▾" : "▸"}</span>
            </button>
            {open && <div className="week-detail">{dayDetail(w)}</div>}
          </div>
        );
      })}
    </section>
  );

  return (
    <div className="screen" data-presentation={presentation}>
      {active && (
        <div className="banner-row">
          <button
            type="button"
            className="resume-banner"
            onClick={() => navigate("/session")}
          >
            RESUME
            {active.workout_label
              ? ` · ${active.workout_label.toUpperCase()}`
              : " SESSION"}
          </button>
          <button
            type="button"
            className="btn btn-outline-ink banner-finish"
            onClick={() => navigate("/end")}
          >
            Finish
          </button>
        </div>
      )}

      {!active && recovery}

      {/* A session that ended without a rating, for a day afterwards. Gated on
          `active` for the same reason the orphan card is: someone mid-workout
          is being asked about a DIFFERENT session, and a RESUME banner with a
          "rate yesterday" card under it reads as one question about one thing.
          It renders nothing at all when there is nothing to ask. */}
      {!active && <RateSessionCard />}

      <div className="date-heading-row">
        <h1 className="today-heading">{formatTodayHeading()}</h1>
        {userId && (
          <button
            type="button"
            className="checkin-link"
            onClick={() => setCheckInOpen(true)}
          >
            Check in <span aria-hidden="true">→</span>
          </button>
        )}
      </div>
      {/* provenance (source_note) deliberately not shown here — the week is
          the subject; where a program came from lives with Claude/the coach */}
      {program && (
        <div className="today-context">
          {shownPrograms.map((p) => p.name).join(" · ")}
        </div>
      )}
      {otherProgramNames.length > 0 && (
        <div className="today-context">
          Also confirmed, not shown here: {otherProgramNames.join(", ")}
        </div>
      )}

      {stale === "offline" && (
        <div className="cache-note">offline — showing cached plan</div>
      )}
      {/* Not offline: the server answered and said no. The error has already
          gone to recentErrors, Sentry and a toast; this line stops the screen
          telling an online person they are offline. */}
      {stale === "error" && (
        <div className="cache-note cache-note-error">
          couldn’t refresh — showing cached plan
        </div>
      )}
      {loadError && !list && (
        <div className="warn-badge">
          {loadError === "offline"
            ? "Couldn’t load workouts (offline, no cache)"
            : "Couldn’t load workouts — the server returned an error (details under Report a problem)"}
        </div>
      )}

      {/* The week strip used to be gated behind `program && anyDates`, so a
          brand new account — no program yet — had no calendar at all, and no
          way to pick the day it wanted to plan on. The strip IS the way in:
          tap a day, plan it. It renders as soon as the plan list has loaded
          and there is nothing dateless to show instead: an empty account gets
          the strip, and a program whose days carry no dates still falls back
          to the DAY 1..N list below, which is the case the strip cannot
          represent. */}
      {list !== null && (workouts.length === 0 || anyDates) && (
        <section className="rule-section">
          <div className="section-head">
            {/* The strip shows seven days and nothing else, so a block written
                three weeks out used to be unreachable from this screen. */}
            <button
              type="button"
              className="field-label cal-open"
              aria-label="open calendar to pick another day"
              onClick={() => setCalendarOpen(true)}
            >
              {weekDates.includes(today)
                ? "THIS WEEK"
                : weekRangeLabel(weekDates)}{" "}
              <span aria-hidden="true">▾</span>
            </button>
            <span className="section-meta">
              {weekTally(workouts, states, weekDates)}
            </span>
          </div>

          {/* a GROUP, not a tablist: these cells select a day, they do not
              switch panels, and the half-built tab pattern that was here
              (no tabpanel, no aria-controls, no roving tabindex, no arrow
              keys) told a screen reader to expect all four. Each cell keeps
              its own spoken label and marks itself with aria-current.

              The neighbouring weeks are rendered but hidden from assistive
              tech and out of the tab order: until you swipe to one it is a
              preview, and twenty-one tab stops for seven visible days is not
              the same screen a sighted person is using. */}
          <div
            className="week-track"
            ref={centreTrack}
            onScroll={onTrackScroll}
          >
            {pages.map((dates, i) => {
              const live = i === 1;
              return (
                <div
                  className="week-page"
                  key={dates[0]}
                  aria-hidden={live ? undefined : true}
                >
                  <div
                    className="week-strip"
                    role={live ? "group" : undefined}
                    aria-label={
                      live
                        ? `week beginning ${parseLocalDate(
                            dates[0],
                          ).toLocaleDateString("en-GB", {
                            day: "numeric",
                            month: "long",
                          })}`
                        : undefined
                    }
                  >
                    {dates.map((iso) => weekCell(iso, live))}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Only when it would do something. A control that is already where
              it takes you is noise, and this one appears exactly when the
              screen stops being about today. */}
          {selectedDate !== today && (
            <div className="week-jump">
              <button
                type="button"
                className="btn btn-secondary week-today"
                onClick={() => {
                  setSelectedDate(today);
                  const w = byDate.get(today);
                  if (w) loadRx(w.id);
                }}
              >
                {selectedDate > today ? "← Today" : "Today →"}
              </button>
            </div>
          )}

          <div className="week-detail">
            {selectedWorkout ? (
              <>
                <div className="selected-day-head">
                  <div className="selected-day-identity">
                    <span className="selected-day-date">
                      {formatPlannedDate(selectedDate)}
                    </span>
                    <h2 className="selected-day-label">
                      {workoutName(selectedWorkout)}
                    </h2>
                  </div>
                  <span className="section-meta">
                    {stateLabel(states.get(selectedWorkout.id) ?? "UPCOMING")}
                  </span>
                </div>
                {dayDetail(selectedWorkout)}
              </>
            ) : (
              <>
                <div className="selected-day-date">
                  {formatPlannedDate(selectedDate)}
                </div>
                <div className="microcopy">
                  {selectedDate === today
                    ? "Nothing scheduled today — rest day."
                    : "Rest day — nothing scheduled."}
                </div>
                {/* The only way to create a planned day used to be duplicating
                    an existing one, which meant no way at all before the first
                    program existed. Planning starts on the calendar, on the
                    day being planned, so the new workout is dated by
                    construction and cannot land off the week strip. */}
                <button
                  type="button"
                  className="btn btn-secondary btn-block"
                  disabled={creating}
                  aria-busy={creating}
                  onClick={() => planDay(selectedDate)}
                >
                  {creating ? "Creating…" : "Plan this day"}
                </button>
                {/* The other way to fill an empty day: one you already built.
                    Sits under "Plan this day" rather than beside it, because
                    from scratch is the answer before any template exists. */}
                <button
                  type="button"
                  className="btn btn-ghost btn-block"
                  /* disabled WHILE creating, but not itself busy: its label
                     never changes, so aria-busy here would be a claim the
                     button does not make. */
                  disabled={creating}
                  onClick={() => setTemplatesOpen(true)}
                >
                  Use a saved workout
                </button>
              </>
            )}
          </div>
        </section>
      )}

      {program && anyDates && (
        <>
          {outsideWeek.earlier.length > 0 &&
            outsideSection("EARLIER", outsideWeek.earlier)}
          {outsideWeek.later.length > 0 &&
            outsideSection("LATER", outsideWeek.later)}
        </>
      )}

      {program && !anyDates && (
        <section className="rule-section">
          <div className="section-head">
            <span className="field-label">THIS WEEK</span>
            <span className="section-meta">
              {doneCount} DONE · {workouts.length - doneCount - skippedCount} TO
              GO
              {skippedCount > 0 ? ` · ${skippedCount} SKIPPED` : ""}
            </span>
          </div>
          {workouts.map((w) => {
            const state = states.get(w.id) ?? "UPCOMING";
            const open = expanded === w.id;
            const muted = state === "DONE" || state === "SKIPPED";
            return (
              <div key={w.id} className="week-item">
                <button
                  type="button"
                  className="week-row"
                  onClick={() => {
                    setExpanded(open ? null : w.id);
                    loadRx(w.id);
                  }}
                >
                  <span
                    className={`week-day ${state === "TODAY" ? "week-day-today" : ""}`}
                  >
                    {dayLabel(w)}
                  </span>
                  <span
                    className={`week-label ${state === "TODAY" ? "week-label-today" : ""} ${muted ? "week-label-done" : ""}`}
                  >
                    {workoutName(w)}
                    {w.plan_note ? <span className="note-dot"> ·</span> : ""}
                  </span>
                  <span
                    className={`week-state ${state === "TODAY" ? "week-state-today" : ""}`}
                  >
                    {stateLabel(state)}
                  </span>
                  <span className="chev">{open ? "▾" : "▸"}</span>
                </button>
                {open && <div className="week-detail">{dayDetail(w)}</div>}
              </div>
            );
          })}
        </section>
      )}

      {/* the empty state is a claim about the data; it must wait for it */}
      {!list && !loadError && <p className="muted">Loading…</p>}
      {list && !program && (
        <>
          {/* The first minute used to be a dead end: "No confirmed programs
              yet" and two buttons that both ask the person to build a plan by
              hand, while the one thing that can write it FOR them — the coach,
              behind a floating button they have no reason to press — went
              unmentioned. The app's second real user described her training to
              the coach and it wrote her days; she found that on her own.

              The unit sits here for the same reason. It defaults to kg and she
              trains in lb, so every number in the app was wrong until she
              found Settings — and by then some of them were logged. Asking
              once, before anything is logged, is cheaper than any conversion
              afterwards. */}
          {firstRun && (
            <section className="first-run">
              <div className="first-run-head">
                <span className="field-label">START HERE</span>
                <button
                  type="button"
                  className="btn btn-ghost first-run-dismiss"
                  onClick={dismissFirstRun}
                >
                  Dismiss
                </button>
              </div>

              <div className="first-run-row">
                <span className="first-run-q">
                  Do you train in kilos or pounds?
                </span>
                {/* setUnit, not setSetting: switching display unit also remaps
                    bar selections onto the other catalogue. */}
                <div className="seg seg-types">
                  <button
                    type="button"
                    className={`seg-btn ${unit === "kg" ? "seg-on" : ""}`}
                    aria-pressed={unit === "kg"}
                    onClick={() => setUnit("kg")}
                  >
                    kg
                  </button>
                  <button
                    type="button"
                    className={`seg-btn ${unit === "lb" ? "seg-on" : ""}`}
                    aria-pressed={unit === "lb"}
                    onClick={() => setUnit("lb")}
                  >
                    lb
                  </button>
                </div>
              </div>
              <div className="microcopy">
                Weights are stored in kilos either way. This changes what you
                read and type, and Settings can change it back.
              </div>

              <p className="first-run-body">
                You don’t have to build a plan by hand. Tap the coach button
                in the header, describe how you train or paste in what your
                coach wrote, and it will write the plan for you.
              </p>
              <div className="microcopy">
                Those conversations are saved, and whoever runs this deployment
                can read them.
              </div>
            </section>
          )}
          <p className="muted">No confirmed programs yet.</p>
          {/* With no program there was previously NO planning affordance
              anywhere in the app — the whole screen was "Start empty
              session". createPlannedWorkout makes the first program itself. */}
          <button
            type="button"
            className="btn btn-secondary btn-block"
            disabled={creating}
            aria-busy={creating}
            onClick={() => planDay(todayLocalIso())}
          >
            {creating ? "Creating…" : "Plan a workout"}
          </button>
        </>
      )}

      {canStart && (
        <button
          type="button"
          className="btn btn-secondary btn-block"
          onClick={() => void start(null)}
        >
          Start empty session
        </button>
      )}

      {/* Bodyweight lives here rather than only on End, because End is reached
          only by tapping Finish and the figure matters most on the days there
          was no session to finish at all. Top level, below the plan: it is a
          standing fact about the person rather than part of today's workout,
          and it must not sit inside the no-program branch — someone WITH a
          program is exactly who has been weighing in before training. */}
      <BodyweightRow />

      {templatesOpen && (
        <TemplateSheet
          dateLabel={formatPlannedDate(selectedDate)}
          busy={creating}
          onApply={(t) => useTemplate(t.id, t.label ?? "Workout")}
          onDelete={(t) => {
            void deleteTemplate(t.id)
              .then(() => {
                setTemplatesOpen(false);
                toast(`Deleted "${t.label ?? "Untitled"}"`);
              })
              .catch((e: unknown) => reportError(e, "delete template"));
          }}
          onClose={() => setTemplatesOpen(false)}
        />
      )}

      {calendarOpen && (
        <CalendarSheet
          selected={selectedDate}
          today={today}
          weekStart={weekStart}
          days={calendarDays}
          onPick={(iso) => {
            setSelectedDate(iso);
            const w = byDate.get(iso);
            if (w) loadRx(w.id);
            setCalendarOpen(false);
          }}
          onClose={() => setCalendarOpen(false)}
        />
      )}
      {checkInOpen && userId && (
        <CheckInSheet
          userId={userId}
          localDate={today}
          onClose={() => setCheckInOpen(false)}
        />
      )}
    </div>
  );
}

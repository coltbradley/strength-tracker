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
import { useNavigate } from "react-router-dom";
import { Note } from "../components/Note";
import { CalendarSheet, type CalendarDay } from "../components/CalendarSheet";
import { TemplateSheet } from "../components/TemplateSheet";
import {
  applyTemplate,
  createPlannedWorkout,
  deleteTemplate,
  getDoneWorkoutIds,
  getExercises,
  getLastActuals,
  getPlannedWorkouts,
  getResolvedPrescriptions,
  getServerSessionSets,
  invalidateForSessionClose,
  staleReason,
  syncOpenSessions,
  updatePlannedWorkout,
  weekOrder,
  type OpenSessionRow,
  type StaleReason,
  type WorkoutList,
} from "../lib/data";
import { groupRamps } from "../lib/entries";
import { openCoach } from "../lib/coachOpen";
import {
  getRecentlyEndedSessions,
  reviewableByDay,
  reviewPrompt,
  type EndedSession,
} from "../lib/review";
import { useOnline } from "../hooks/useFabDrag";
import { addDays, startOfWeek, weekDates } from "../lib/calendar";
import { cacheGet, cacheSet, cacheKeys } from "../lib/db";
import { outbox } from "../lib/sync";
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

type WorkoutState =
  | "DONE"
  | "SKIPPED"
  | "TODAY"
  | "MISSED"
  | "UPCOMING"
  | "NO DATE"
  /** dated, but nothing programmed into it yet. "Plan a workout" creates the
   *  day before its contents, so an abandoned one used to turn into a MISSED
   *  workout the day after — a session someone failed to do, that never
   *  existed. */
  | "DRAFT";

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
      else if (w.scheduled_date < today) map.set(w.id, "MISSED");
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
 *  - NO DATE is deliberately excluded too. This action's whole claim is "the
 *    plan is fine, I am ahead or behind" — a day with no date is not ahead of
 *    or behind anything, and giving it a date IS the fix, so "Reschedule to
 *    today" stays its only offer.
 *
 * It intentionally does not consult `anyDates`: a day is a day. In an undated
 * DAY 1..N program the same gap exists (day 3 before day 2) and the same
 * answer works, whereas rescheduling there is meaningless and is gated off.
 */
export function canDoWorkoutNow(state: WorkoutState): boolean {
  return state === "UPCOMING" || state === "MISSED";
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

export function Today() {
  const navigate = useNavigate();
  const unit = useUnit();
  const [list, setList] = useState<WorkoutList | null>(null);
  const [stale, setStale] = useState<StaleReason | null>(null);
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<ActiveSession | null>(null);
  const [rx, setRx] = useState<Record<string, ResolvedPrescriptionRow[]>>({});
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
  const [selectedDate, setSelectedDate] = useState<string>(today);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [laterExpanded, setLaterExpanded] = useState<string | null>(null);
  // undated-program fallback keeps the old expandable ruled list
  const [expanded, setExpanded] = useState<string | null>(null);
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

  // most recent confirmed program drives the week
  const program = list?.programs[0] ?? null;
  const firstRun = showFirstRun({
    loaded: list !== null,
    hasProgram: program !== null,
    dismissed: firstRunDismissed,
  });
  const workouts = useMemo(
    () =>
      program
        ? (list?.workouts ?? [])
            .filter((w) => w.program_id === program.id)
            .sort(weekOrder)
        : [],
    [list, program],
  );

  const reload = useCallback(() => {
    getPlannedWorkouts()
      .then((r) => {
        setList(r.data);
        setStale(r.stale);
        setLoadError(null);
      })
      .catch((e: unknown) => {
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
      if (cancelled) return;
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
    if (!program || workouts.length === 0) return;
    getDoneWorkoutIds(
      program.id,
      workouts.map((w) => w.id),
    )
      .then((r) => setDoneIds(new Set(r.data)))
      .catch((e: unknown) => reportError(e, "load week state"));
  }, [program, workouts, doneTick]);

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
    () => workoutStates(workouts, doneIds, anyDates, today),
    [workouts, doneIds, anyDates, today],
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
  const selectedWorkout = anyDates ? (byDate.get(selectedDate) ?? null) : null;

  const loadRx = useCallback(
    (workoutId: string) => {
      if (workoutId in rx) return;
      getResolvedPrescriptions(workoutId)
        .then((r) => setRx((prev) => ({ ...prev, [workoutId]: r.data })))
        .catch((e: unknown) => reportError(e, "load prescriptions"));
    },
    [rx],
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
        // there is one; otherwise make the day first (which creates a program)
        // and read its program_id back.
        let pid = program?.id ?? null;
        if (pid === null) {
          const seedId = await createPlannedWorkout(selectedDate, "");
          const fresh = await getPlannedWorkouts();
          pid =
            fresh.data.workouts.find((w) => w.id === seedId)?.program_id ??
            null;
          if (pid === null) throw new Error("could not resolve a program");
        }
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
      await cacheSet(cacheKeys.sessionRx(sessionId), prescriptions);
      const activeSession: ActiveSession = {
        id: sessionId,
        planned_workout_id: workout?.id ?? null,
        started_at: startedAt,
        workout_label: workout?.label ?? null,
        plan_note: workout?.plan_note ?? null,
        coach_note: workout?.notes ?? null,
      };
      await cacheSet(cacheKeys.activeSession, activeSession);
      await outbox.enqueue({
        kind: "insert",
        table: "sessions",
        payload: {
          id: sessionId,
          planned_workout_id: workout?.id ?? null,
          started_at: startedAt,
        },
      });
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
      await invalidateForSessionClose();
      setOrphan(null);
      setDoneTick((t) => t + 1);
      toast("Session discarded");
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
  const canStart = startGateOpen && !active && !orphan;

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
        state === "NO DATE" ||
        (state === "UPCOMING" && anyDates));
    const canDoNow = canStart && canDoWorkoutNow(state);
    return (
      <>
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
            not on the card (an undated program cannot reschedule, a NO DATE
            day cannot be done ahead) is worse than saying nothing. */}
        {canDoNow && canReschedule && (
          <div className="microcopy">
            Do it now if you’re ahead or behind — the day keeps its date and
            still counts as done. Reschedule only if the date itself was wrong.
          </div>
        )}
        {state === "NO DATE" && (
          <div className="microcopy">
            No date set — reschedule it to today, or pick a day in Edit.
          </div>
        )}
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

  return (
    <div className="screen">
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

      {!active && orphan && (
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
            Started earlier today but this phone lost track of it. Pick it back
            up, finish it, or discard it.
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
      )}

      <h1 className="today-heading">{formatTodayHeading()}</h1>
      {/* provenance (source_note) deliberately not shown here — the week is
          the subject; where a program came from lives with Claude/the coach */}
      {program && <div className="today-context">{program.name}</div>}

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
              {doneCount} DONE · {workouts.length - doneCount - skippedCount} TO
              GO
              {skippedCount > 0 ? ` · ${skippedCount} SKIPPED` : ""}
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
                  <h2 className="selected-day-label">
                    {workoutName(selectedWorkout)}
                  </h2>
                  <span className="section-meta">
                    {stateLabel(states.get(selectedWorkout.id) ?? "UPCOMING")}
                  </span>
                </div>
                {dayDetail(selectedWorkout)}
              </>
            ) : (
              <>
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

      {program && anyDates && laterWorkouts.length > 0 && (
        <section className="rule-section">
          <div className="section-head">
            <span className="field-label">LATER</span>
            <span className="section-meta">{laterWorkouts.length}</span>
          </div>
          {laterWorkouts.map((w) => {
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
                You don’t have to build a plan by hand. Tap the speech-bubble
                button floating over the app, describe how you train or paste in
                what your coach wrote, and it will write the plan for you.
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
    </div>
  );
}

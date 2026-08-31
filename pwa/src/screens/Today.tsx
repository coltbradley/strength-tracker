// Today: the week as a calendar. A Mon–Sun strip shows which days carry
// work and their state (done / skipped / missed / today / rest); tapping a
// day previews it inline below without losing the week. Start is gated to
// today's workout; everything else is editable via the plan editor.
// Anything scheduled outside this week (or undated) lives in a compact
// LATER list. Programs with no dates at all keep the original ruled list —
// a calendar needs dates.

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { Note } from "../components/Note";
import {
  CalendarSheet,
  type CalendarDay,
} from "../components/CalendarSheet";
import {
  createPlannedWorkout,
  getDoneWorkoutIds,
  getExercises,
  getLastActuals,
  getPlannedWorkouts,
  getResolvedPrescriptions,
  getServerSessionSets,
  invalidateForSessionClose,
  syncOpenSessions,
  updatePlannedWorkout,
  weekOrder,
  type OpenSessionRow,
  type WorkoutList,
} from "../lib/data";
import { groupRamps } from "../lib/entries";
import { cacheGet, cacheSet, cacheKeys } from "../lib/db";
import { outbox } from "../lib/sync";
import { uuid } from "../lib/uuid";
import { useArmed } from "../hooks/useArmed";
import { reportError, toast } from "../lib/errors";
import {
  formatPlannedDate,
  formatRxTarget,
  formatTodayHeading,
  formatWeekdayLetter,
  getWeekDates,
  parseLocalDate,
  rxHasNoTm,
  todayLocalIso,
  workoutName,
} from "../lib/format";
import { useUnit } from "../hooks/useUnit";
import { useWeekStartsOn } from "../hooks/useSettings";
import type {
  ActiveSession,
  PlannedWorkoutRow,
  ResolvedPrescriptionRow,
} from "../lib/types";

/** How long the Start buttons wait on the open-session check (see below). */
const GATE_TIMEOUT_MS = 2500;

type WorkoutState =
  "DONE" | "SKIPPED" | "TODAY" | "MISSED" | "UPCOMING" | "NO DATE";

export function Today() {
  const navigate = useNavigate();
  const unit = useUnit();
  const [list, setList] = useState<WorkoutList | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<ActiveSession | null>(null);
  const [rx, setRx] = useState<Record<string, ResolvedPrescriptionRow[]>>({});
  const [loadError, setLoadError] = useState(false);
  // week strip selection + LATER-list accordion
  const [selectedDate, setSelectedDate] = useState<string>(todayLocalIso());
  const [calendarOpen, setCalendarOpen] = useState(false);
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

  // most recent confirmed program drives the week
  const program = list?.programs[0] ?? null;
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
        setFromCache(r.fromCache);
        setLoadError(false);
      })
      .catch((e: unknown) => {
        setLoadError(true);
        reportError(e, "load workouts");
      });
  }, []);

  useEffect(() => {
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
          todayLocalIso(),
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
  }, [reload]);

  useEffect(() => {
    if (!program || workouts.length === 0) return;
    getDoneWorkoutIds(
      program.id,
      workouts.map((w) => w.id),
    )
      .then((r) => setDoneIds(new Set(r.data)))
      .catch((e: unknown) => reportError(e, "load week state"));
  }, [program, workouts, doneTick]);

  const today = todayLocalIso();
  const anyDates = workouts.some((w) => w.scheduled_date !== null);
  const weekStart = useWeekStartsOn();
  // Anchored on the SELECTED day, not on today, so picking a date in another
  // week from the calendar moves the strip to that week instead of silently
  // showing this one.
  const weekDates = useMemo(
    () => getWeekDates(parseLocalDate(selectedDate), weekStart),
    [selectedDate, weekStart],
  );

  const states = useMemo(() => {
    const map = new Map<string, WorkoutState>();
    let todayAssigned = false;
    for (const w of workouts) {
      if (doneIds.has(w.id)) {
        map.set(w.id, "DONE");
      } else if (w.skipped_at !== null) {
        map.set(w.id, "SKIPPED");
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
  }, [workouts, doneIds, anyDates, today]);

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
    state === "UPCOMING" ? "TO COME" : state;

  const moveToToday = (w: PlannedWorkoutRow) =>
    void (async () => {
      try {
        await updatePlannedWorkout(w.id, { scheduled_date: todayLocalIso() });
        toast("Moved to today");
        setSelectedDate(todayLocalIso());
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
        {canStart &&
          (state === "MISSED" ||
            state === "NO DATE" ||
            (state === "UPCOMING" && anyDates)) && (
            <button
              type="button"
              className="btn btn-outline-ink btn-block"
              onClick={() => moveToToday(w)}
            >
              Move to today
            </button>
          )}
        {state === "NO DATE" && (
          <div className="microcopy">
            No date set — move it to today, or pick a day in Edit.
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

      {fromCache && (
        <div className="cache-note">offline — showing cached plan</div>
      )}
      {loadError && !list && (
        <div className="warn-badge">
          Couldn’t load workouts (offline, no cache)
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
              THIS WEEK <span aria-hidden="true">▾</span>
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
              its own spoken label and marks itself with aria-current. */}
          <div className="week-strip" role="group" aria-label="this week">
            {weekDates.map((iso) => {
              const w = byDate.get(iso) ?? null;
              const cellState: WorkoutState | "REST" = w
                ? (states.get(w.id) ?? "UPCOMING")
                : "REST";
              const isToday = iso === today;
              const isSelected = iso === selectedDate;
              return (
                <button
                  key={iso}
                  type="button"
                  aria-current={isSelected ? "date" : undefined}
                  aria-label={`${parseLocalDate(iso).toLocaleDateString(
                    "en-GB",
                    { weekday: "long" },
                  )} ${parseLocalDate(iso).getDate()}${
                    w
                      ? `, ${
                          cellState === "REST"
                            ? "rest day"
                            : stateLabel(
                                cellState as WorkoutState,
                              ).toLowerCase()
                        }`
                      : ", rest day"
                  }`}
                  className={`week-cell ${isToday ? "week-cell-today" : ""} ${isSelected ? "week-cell-selected" : ""}`}
                  onClick={() => {
                    setSelectedDate(iso);
                    if (w) loadRx(w.id);
                  }}
                >
                  <span className="week-cell-letter">
                    {formatWeekdayLetter(iso)}
                  </span>
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
            })}
          </div>

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
                  onClick={() => planDay(selectedDate)}
                >
                  {creating ? "Creating…" : "Plan this day"}
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
          <p className="muted">No confirmed programs yet.</p>
          {/* With no program there was previously NO planning affordance
              anywhere in the app — the whole screen was "Start empty
              session". createPlannedWorkout makes the first program itself. */}
          <button
            type="button"
            className="btn btn-secondary btn-block"
            disabled={creating}
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

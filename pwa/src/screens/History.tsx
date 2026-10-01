// Record (the /history tab). Two views in one screen:
//
// LIST (nothing selected): search, PINNED GOALS (an exercise with a row in
// `goals`: e1RM, target, % and a progress bar), RECENT (most recently
// performed first, "most done" breaks ties, see lib/record.ts), a way into the
// full library, then the day-shaped sections below. Pinning is a quiet
// text toggle; the progress bar is the emphasis, not the button.
//
// DETAIL (an exercise selected): goal card (-/+ when pinned, "Pin as goal"
// when not), per-exercise e1RM chart (goal % in teal), weekly working-set bars,
// recent sets grouped by session date. Exactly two charts.
//
// Then the same record read the OTHER way round. Everything above is
// organised by movement, which cannot answer "what did I actually do on
// Tuesday" — the only way to get that was to ask the coach, at a round trip
// and a token bill, for something SQL already knows. THIS WEEK and SESSIONS
// sit below the exercise sections rather than above them because the screen's
// h1 is the exercise picker and the three sections under it are its subject;
// wedging two unrelated sections between a control and what it controls costs
// more than one scroll does.
//
// ADHERENCE (v_adherence) reads back here as ONE line above each session's
// sets: what the plan asked for, in the plan's own words. Not a compliance
// score — the decisions log rejected streaks and badges as motivational-app
// noise, and a percentage with a green tick is the same thing wearing a
// number. The set rows sit directly beneath carrying the real loads and reps,
// so the comparison is the reader's to make. The app only says what the
// reader cannot derive: how many sets the plan wanted, and whether the two
// loads are even on the same scale.

import { useEffect, useMemo, useRef, useState } from "react";
import { E1rmChart } from "../components/charts/E1rmChart";
import { VolumeChart } from "../components/charts/VolumeChart";
import { SetRow } from "../components/SetRow";
import { CheckinWeek } from "../components/CheckinWeek";
import { BodyweightRow } from "../components/BodyweightRow";
import {
  deleteObservation,
  getAdherence,
  getE1rmSeries,
  getExercises,
  getGoals,
  getRecordIndex,
  removeGoal,
  restoreGoal,
  setGoal,
  getObservations,
  getRecentSets,
  getServerSessionSets,
  getSessionMeta,
  getSetNotesForExercise,
  getWeeklyVolume,
  invalidateForSessionClose,
  invalidateForSetChange,
  summariseAdherence,
  type CoachObservationRow,
  type RxOutcome,
  type SessionMetaRow,
  worstStale,
  type StaleReason,
} from "../lib/data";
import { SessionList, WeekLine } from "../components/SessionHistory";
import {
  getSessionLog,
  getWeeklySummary,
  liveSets,
  weekStartIso,
  type SessionLogEntry,
  type WeeklySummaryRow,
} from "../lib/sessionHistory";
import { useLocalToday } from "../hooks/useLocalToday";
import { reportError, toast } from "../lib/errors";
import { formatRepRange, formatSessionDate } from "../lib/format";
import { cacheGet, cacheKeys } from "../lib/db";
import { outbox } from "../lib/sync";
import type { OutboxEntry } from "../lib/outbox";
import { useUnit } from "../hooks/useUnit";
import { toDisplay, type Unit } from "../lib/units";
import {
  applyPendingToIndex,
  buildRecordLists,
  defaultGoalKg,
  goalStep,
  optimisticPct,
  stepGoalKg,
  RECENT_WINDOW_DAYS,
  type PendingSetRef,
  type RecordIndexEntry,
  type RecordRow,
} from "../lib/record";
import { useArmed } from "../hooks/useArmed";
import { ExercisePicker } from "../components/ExercisePicker";
import type {
  ActiveSession,
  ExerciseRow,
  GoalProgressRow,
  SessionBestE1rmRow,
  SetInsert,
  WeeklyVolumeRow,
} from "../lib/types";

/**
 * One prescription in the plan's own words: "3×3-5 @ 144 KG", with the number
 * of sets actually logged only when it fell short of (or ran past) what was
 * asked. No verdict, no percentage — the sets are rendered directly below.
 *
 * A per-side prescription is quoted PER SIDE, because that is the number the
 * lifter reads off the rack; `load_kg` in the database stays the total.
 */
function formatPlanned(o: RxOutcome, unit: Unit): string {
  const sets = o.plannedSets ?? o.loggedSets;
  const head = `${sets}×${formatRepRange(o.repsMin, o.repsMax)}`;
  const load =
    o.prescribedLoadKg === null
      ? "by feel"
      : o.prescribedEntry === "per_side"
        ? `${toDisplay(o.prescribedLoadKg / 2, unit)} ${unit}/side`
        : `${toDisplay(o.prescribedLoadKg, unit)} ${unit}`;
  const short =
    o.plannedSets !== null && o.loggedSets !== o.plannedSets
      ? ` (${o.loggedSets} logged)`
      : "";
  return `${head} @ ${load}${short}`;
}

/** Tonnage of the most recent week with any volume, for the chart's head. */
function latestTonnage(weeks: WeeklyVolumeRow[]): WeeklyVolumeRow | null {
  return weeks.length === 0 ? null : weeks[weeks.length - 1];
}

/** A row that happened must never render nameless: fall back to the id. */
function nameOf(exercises: ExerciseRow[], id: string): string {
  return exercises.find((e) => e.id === id)?.name ?? id;
}

/** How long an unpin can be taken back. */
const UNDO_MS = 6000;

/** Tracks navigator.onLine. A true reading is not proof of a connection, so
 *  every write still reverts on failure; false is trusted. */
function useOnline(): boolean {
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine !== false,
  );
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return online;
}

/** Unsent set inserts this device will actually send (not another account's
 *  held items). Dead ones count: the lifter logged them. */
function unsentSetsOf(entries: OutboxEntry[]): (PendingSetRef & SetInsert)[] {
  const out: (PendingSetRef & SetInsert)[] = [];
  for (const e of entries) {
    if (e.state === "held") continue;
    if (e.op.kind === "insert" && e.op.table === "sets") {
      out.push(e.op.payload as PendingSetRef & SetInsert);
    }
  }
  return out;
}

export function History({ userId }: { userId: string }) {
  const unit = useUnit();
  const [exercises, setExercises] = useState<ExerciseRow[]>([]);
  const [exercisesLoaded, setExercisesLoaded] = useState(false);
  const [index, setIndex] = useState<RecordIndexEntry[]>([]);
  /** the scan ran out of pages: the oldest exercises may be missing */
  const [indexTruncated, setIndexTruncated] = useState(false);
  /** a failed read with nothing cached is an error, never an empty list */
  const [indexError, setIndexError] = useState(false);
  const [goalsError, setGoalsError] = useState(false);
  const [listStale, setListStale] = useState<StaleReason | null>(null);
  /** what this phone has queued and not yet sent (voids, discards, sets) */
  const [pendingLayer, setPendingLayer] = useState<{
    voidedIds: Set<string>;
    discardedSessions: Set<string>;
    sets: PendingSetRef[];
  }>({ voidedIds: new Set(), discardedSessions: new Set(), sets: [] });
  /** ids of sets in the detail list that are on this phone only */
  const [unsentIds, setUnsentIds] = useState<Set<string>>(new Set());
  const online = useOnline();
  const [unpinArm, setUnpinArm] = useArmed();
  /** the last unpin, offered back for UNDO_MS */
  const [undo, setUndo] = useState<GoalProgressRow | null>(null);
  /** read out by screen readers after a -/+ tap */
  const [announce, setAnnounce] = useState("");
  /** bumped on every local goal change; a slower read started before it is
   *  ignored (R6) */
  const goalsGen = useRef(0);
  const pendingWrites = useRef(0);
  /** every goal; an exercise is PINNED exactly when it has one */
  const [goals, setGoals] = useState<GoalProgressRow[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const [series, setSeries] = useState<SessionBestE1rmRow[]>([]);
  const [volume, setVolume] = useState<WeeklyVolumeRow[]>([]);
  const [recent, setRecent] = useState<SetInsert[]>([]);
  const [meta, setMeta] = useState<Record<string, SessionMetaRow>>({});
  /** session_id -> what each prescription in it asked for */
  const [planned, setPlanned] = useState<Map<string, RxOutcome[]>>(new Map());
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [stale, setStale] = useState<StaleReason | null>(null);
  const [discardArm, setDiscardArm] = useArmed();
  const [voidArm, setVoidArm] = useArmed();
  const [activeId, setActiveId] = useState<string | null>(null);
  // distinct from "empty": a first-run user must not read "nothing logged
  // yet" while the first fetch is still in the air
  const [indexLoading, setIndexLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  /** bumped by a void or a discard: the charts are derived from the sets
   *  that just changed, so they have to be refetched, not just repainted */
  const [reloadTick, setReloadTick] = useState(0);

  // ---- the day-shaped half: this week, and the log of finished sessions ----
  // `useLocalToday` rather than a date read during render: an installed PWA
  // is suspended and resumed with the same heap, so a screen left open on
  // Sunday night would otherwise keep reporting LAST week for ever.
  const today = useLocalToday();
  const weekStart = useMemo(() => weekStartIso(today), [today]);
  const [week, setWeek] = useState<WeeklySummaryRow | null>(null);
  const [weekLoading, setWeekLoading] = useState(true);
  const [sessions, setSessions] = useState<SessionLogEntry[]>([]);
  const [logLoading, setLogLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  /** sets of the open session; undefined means "still reading", which is not
   *  the same claim as the empty array */
  const [openSets, setOpenSets] = useState<SetInsert[] | undefined>(undefined);

  const [observations, setObservations] = useState<CoachObservationRow[]>(
    [],
  );
  const [obsLoading, setObsLoading] = useState(true);
  const [obsDeleteArm, setObsDeleteArm] = useArmed();

  useEffect(() => {
    // A void or discard bumps reloadTick; the read it starts supersedes any
    // still in flight, which must not land on top of it (A-13).
    let cancelled = false;
    void cacheGet<ActiveSession>(cacheKeys.activeSession)
      .then((a) => {
        if (!cancelled) setActiveId(a?.id ?? null);
      })
      .catch((e: unknown) => reportError(e, "read active session"));
    getExercises()
      .then((r) => {
        if (!cancelled) setExercises(r.data);
      })
      .catch((e: unknown) => reportError(e, "load exercises"))
      .finally(() => {
        if (!cancelled) setExercisesLoaded(true);
      });
    // per-exercise last date, recent session count and newest e1RM
    let indexStale: StaleReason | null = null;
    let goalsStale: StaleReason | null = null;
    getRecordIndex()
      .then((r) => {
        if (cancelled) return;
        setIndex(r.data.entries);
        setIndexTruncated(r.data.truncated);
        setIndexError(false);
        indexStale = r.stale ?? null;
        setListStale(worstStale(indexStale, goalsStale));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setIndexError(true);
        reportError(e, "load record index");
      })
      .finally(() => {
        if (!cancelled) setIndexLoading(false);
      });
    // what is queued on this phone but not sent: layered over the index
    void (async () => {
      try {
        const [voidedIds, discardedSessions, entries] = await Promise.all([
          outbox.pendingVoidIds(),
          outbox.pendingDiscardIds(),
          outbox.inspect(),
        ]);
        if (cancelled) return;
        setPendingLayer({
          voidedIds,
          discardedSessions,
          sets: unsentSetsOf(entries),
        });
      } catch (e) {
        if (!cancelled) reportError(e, "read unsent sets");
      }
    })();
    // a goals read that lands after an optimistic edit must not undo it
    const gen = goalsGen.current;
    getGoals()
      .then((r) => {
        if (cancelled) return;
        setGoalsError(false);
        goalsStale = r.stale ?? null;
        setListStale(worstStale(indexStale, goalsStale));
        if (goalsGen.current === gen && pendingWrites.current === 0)
          setGoals(r.data);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setGoalsError(true);
        reportError(e, "load goals");
      });
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  // The log and the week are independent of the selected exercise, so they
  // load once (and again on a void or a discard, both of which change what
  // the week counted and what a day contains).
  useEffect(() => {
    let cancelled = false;
    setLogLoading(true);
    setWeekLoading(true);
    void (async () => {
      try {
        const discarded = await outbox.pendingDiscardIds();
        const log = await getSessionLog(discarded);
        if (cancelled) return;
        setSessions(log.data);
      } catch (e) {
        // leave whatever is on screen: a refetch that cannot reach the server
        // must not blank the log it already drew
        if (!cancelled) reportError(e, "load session log");
      } finally {
        if (!cancelled) setLogLoading(false);
      }
    })();
    void getWeeklySummary(weekStart)
      .then((w) => {
        if (!cancelled) setWeek(w.data);
      })
      .catch((e: unknown) => {
        if (!cancelled) reportError(e, "load weekly summary");
      })
      .finally(() => {
        if (!cancelled) setWeekLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [weekStart, reloadTick]);

  // The coach's own open conclusions. Independent of the exercise picker
  // and of reloadTick: nothing a set or a session does can make this list
  // stale, only the coach writing a new one or the lifter deleting one —
  // and a delete already patches this state directly, without a refetch.
  useEffect(() => {
    let cancelled = false;
    void getObservations()
      .then((r) => {
        if (!cancelled) setObservations(r.data);
      })
      .catch((e: unknown) => {
        if (!cancelled) reportError(e, "load coach observations");
      })
      .finally(() => {
        if (!cancelled) setObsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The open session's sets. Loaded on demand rather than with the list: a
  // day is only ever opened one at a time, and twenty days of sets is a read
  // nobody asked for. `getServerSessionSets` is the existing helper and
  // already caches per session and falls back to that cache offline.
  useEffect(() => {
    if (openId === null) return;
    let cancelled = false;
    setOpenSets(undefined);
    void (async () => {
      const [rows, voided] = await Promise.all([
        getServerSessionSets(openId),
        outbox.pendingVoidIds(),
      ]);
      // v_live_sets has already dropped voids that LANDED; this subtracts the
      // ones still in the outbox, exactly as the per-exercise list above does
      if (!cancelled) setOpenSets(liveSets(rows, voided));
    })();
    return () => {
      cancelled = true;
    };
  }, [openId, reloadTick]);

  // which exercise the charts on screen belong to
  const shownFor = useRef<string | null>(null);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    // switching exercise: drop the previous lift's data rather than leaving
    // it on screen under the new lift's name. A reloadTick refetch keeps it,
    // so a void offline degrades to stale-but-labelled-correctly.
    if (shownFor.current !== null && shownFor.current !== selected) {
      setSeries([]);
      setVolume([]);
      setRecent([]);
      setMeta({});
      setNotes({});
      setPlanned(new Map());
    }
    shownFor.current = selected;
    setDetailLoading(true);
    void (async () => {
      try {
        const [e1, vol, rec] = await Promise.all([
          getE1rmSeries(selected),
          getWeeklyVolume(selected),
          getRecentSets(selected),
        ]);
        if (cancelled) return;
        // A void and a discard are queued writes, so the server can still be
        // returning rows we have already been told to remove — offline for as
        // long as the queue waits, and for one round trip even online. The
        // sets came from v_live_sets, which knows only what has landed; the
        // outbox knows what was asked for. Subtracting one from the other is
        // what keeps a removed set from reappearing under its own "Set
        // removed" toast.
        const [voided, discarded, queued] = await Promise.all([
          outbox.pendingVoidIds(),
          outbox.pendingDiscardIds(),
          outbox.inspect(),
        ]);
        if (cancelled) return;
        const onServer = new Set(rec.data.map((s) => s.id));
        // Sets logged on this phone and not yet sent are real sets the
        // lifter did; show them, marked. Derived numbers (the charts) still
        // come only from the views and do not include them.
        const unsent = unsentSetsOf(queued).filter(
          (s) =>
            s.exercise_id === selected &&
            !onServer.has(s.id) &&
            !voided.has(s.id) &&
            !discarded.has(s.session_id),
        );
        setUnsentIds(new Set(unsent.map((s) => s.id)));
        const live = [
          ...rec.data.filter(
            (s) => !voided.has(s.id) && !discarded.has(s.session_id),
          ),
          ...unsent,
        ];
        setSeries(e1.data);
        setVolume(vol.data);
        setRecent(live);
        setStale(worstStale(e1.stale, vol.stale, rec.stale));
        // post-workout notes + sRPE for the visible sessions; cached so
        // notes read back offline too
        const ids = [...new Set(live.map((s) => s.session_id))];
        getSessionMeta(selected, ids)
          .then((m) => {
            if (!cancelled) setMeta(m.data);
          })
          .catch((e: unknown) => {
            // a swallowed failure here silently loses the post-workout note
            if (!cancelled) reportError(e, "load session notes");
          });
        // prescribed-vs-achieved for the sessions on screen; best effort,
        // because an unreachable v_adherence must not blank the set list
        getAdherence(selected, ids)
          .then((a) => {
            if (!cancelled) setPlanned(summariseAdherence(a.data));
          })
          .catch((e: unknown) => {
            if (!cancelled) reportError(e, "load adherence");
          });
        getSetNotesForExercise(
          selected,
          live.map((s) => s.id),
        )
          .then((n) => {
            if (!cancelled) setNotes(n.data);
          })
          .catch((e: unknown) => {
            if (!cancelled) reportError(e, "load set notes");
          });
      } catch (e) {
        // state is left untouched on failure, so a refetch that cannot reach
        // the server keeps showing what was already on screen
        if (!cancelled) reportError(e, "load history");
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected, reloadTick]);

  const selectedName = useMemo(
    () => nameOf(exercises, selected ?? ""),
    [exercises, selected],
  );

  const goal = useMemo(
    () => goals.find((g) => g.exercise_id === selected) ?? null,
    [goals, selected],
  );
  const goalsRef = useRef(goals);
  goalsRef.current = goals;

  // The server's index with this phone's unsent sets, voids and discards laid
  // over it. Dates, counts and "on phone" only: no e1RM is derived here.
  const layered = useMemo(
    () => applyPendingToIndex(index, pendingLayer),
    [index, pendingLayer],
  );
  const lists = useMemo(
    () =>
      buildRecordLists(layered, goals, (id) => nameOf(exercises, id), search),
    [layered, goals, exercises, search],
  );
  const indexById = useMemo(
    () => new Map(layered.map((e) => [e.exerciseId, e])),
    [layered],
  );

  // Goal writes are direct (they need a connection) and strictly serial: a
  // -/+ tapped three times in a row is three upserts that must land in order.
  // Each write snapshots the goals it started from. If it fails, that snapshot
  // is put back (not a re-read, which can itself fail with nothing cached) and
  // the writes queued behind it, which were built on the failed state, are
  // skipped. The view is re-read only after success, to replace the
  // optimistic numbers with the view's own.
  const writeChain = useRef<Promise<void>>(Promise.resolve());
  const chainBroken = useRef(false);
  const queueGoalWrite = (
    write: () => Promise<void>,
    what: string,
    snapshot: GoalProgressRow[],
    onSaved?: () => void,
  ) => {
    pendingWrites.current += 1;
    writeChain.current = writeChain.current
      .then(async () => {
        if (chainBroken.current) return;
        try {
          await write();
          onSaved?.();
        } catch (e) {
          chainBroken.current = true;
          setGoalsNow(snapshot);
          setUndo(null);
          reportError(e, `${what}: not saved, goal unchanged`);
        }
      })
      .then(async () => {
        pendingWrites.current -= 1;
        if (pendingWrites.current > 0) return;
        chainBroken.current = false;
        const gen = goalsGen.current;
        try {
          const r = await getGoals();
          if (pendingWrites.current === 0 && goalsGen.current === gen)
            setGoals(r.data);
        } catch (e) {
          reportError(e, "refresh goals");
        }
      });
  };
  const setGoalsNow = (next: GoalProgressRow[]) => {
    goalsGen.current += 1;
    goalsRef.current = next;
    setGoals(next);
  };

  const pinExercise = (exerciseId: string, e1rmKg: number | null) => {
    if (
      !online ||
      e1rmKg === null ||
      goalsRef.current.some((g) => g.exercise_id === exerciseId)
    )
      return;
    const snapshot = goalsRef.current;
    const target = defaultGoalKg(e1rmKg, unit);
    setGoalsNow([
      ...snapshot,
      {
        goal_id: "pending",
        exercise_id: exerciseId,
        exercise_name: nameOf(exercises, exerciseId),
        target_e1rm_kg: target,
        target_date: null,
        recent_best_e1rm_kg: null,
        alltime_best_e1rm_kg: null,
        pct_of_target: null,
      },
    ]);
    queueGoalWrite(() => setGoal(exerciseId, target), "pin goal", snapshot);
  };

  const unpinExercise = (exerciseId: string) => {
    if (!online) return;
    const cur = goalsRef.current.find((g) => g.exercise_id === exerciseId);
    if (!cur) return;
    // `goals` has no "set by" column, and the coach's set_goal writes the same
    // row (with a target_date). A goal with a date may be the coach's, so it
    // takes a second tap, and says what would be lost.
    if (cur.target_date && unpinArm !== exerciseId) {
      setUnpinArm(exerciseId);
      return;
    }
    setUnpinArm(null);
    const snapshot = goalsRef.current;
    setGoalsNow(snapshot.filter((g) => g.exercise_id !== exerciseId));
    queueGoalWrite(
      () => removeGoal(exerciseId),
      "unpin goal",
      snapshot,
      () => setUndo(cur),
    );
  };

  /** Undo of an unpin: put the exact row back, target_date and all. */
  const undoUnpin = () => {
    const row = undo;
    if (!row || !online) return;
    setUndo(null);
    if (goalsRef.current.some((g) => g.exercise_id === row.exercise_id)) return;
    const snapshot = goalsRef.current;
    setGoalsNow([...snapshot, row]);
    queueGoalWrite(() => restoreGoal(row), "restore goal", snapshot);
  };

  useEffect(() => {
    if (undo === null) return;
    const t = window.setTimeout(() => setUndo(null), UNDO_MS);
    return () => window.clearTimeout(t);
  }, [undo]);

  const stepGoal = (exerciseId: string, dir: 1 | -1) => {
    if (!online) return;
    const cur = goalsRef.current.find((g) => g.exercise_id === exerciseId);
    if (!cur) return;
    const snapshot = goalsRef.current;
    const target = stepGoalKg(cur.target_e1rm_kg, dir, unit);
    setGoalsNow(
      snapshot.map((g) =>
        g.exercise_id === exerciseId
          ? {
              ...g,
              target_e1rm_kg: target,
              // the ratio the view will compute, against the new target, so
              // the old percentage never sits beside a new goal
              pct_of_target: optimisticPct(g.recent_best_e1rm_kg, target),
            }
          : g,
      ),
    );
    setAnnounce(`Goal now ${toDisplay(target, unit)} ${unit}`);
    queueGoalWrite(() => setGoal(exerciseId, target), "change goal", snapshot);
  };

  /** Late correction: void a set noticed after the session ended. Same
   *  append-only mechanism as in-session voiding. */
  const voidPastSet = async (s: SetInsert) => {
    try {
      await outbox.enqueue({
        kind: "insert",
        table: "set_voids",
        payload: { set_id: s.id },
      });
      setRecent((prev) => prev.filter((x) => x.id !== s.id));
      setVoidArm(null);
      // enqueue() returns as soon as the item is in IndexedDB — the network
      // insert behind it is fire-and-forget. Bumping the reload here put the
      // set_voids POST and the v_live_sets GET in a race, and when the GET won
      // the response still contained the set: it came back on screen, under
      // its own "Set removed" toast, and was written into the cache. Wait for
      // the queue to be walked so the void is on the server before we ask the
      // server what is live. Offline this is a no-op and the pending-void
      // filter in the refetch carries it instead.
      await outbox.flush();
      await invalidateForSetChange();
      setReloadTick((t) => t + 1);
      toast("Set removed");
    } catch (e) {
      reportError(e, "remove set");
    }
  };

  /** Soft delete a past session: it and ALL its sets (every exercise, not
   *  just the one on screen) leave history and charts. */
  const discardSession = async (sessionId: string) => {
    try {
      await outbox.enqueue({
        kind: "update",
        table: "sessions",
        id: sessionId,
        patch: { discarded_at: new Date().toISOString() },
      });
      setRecent((prev) => prev.filter((s) => s.session_id !== sessionId));
      // the same day is very likely the one open in the log below; leaving it
      // expanded would keep its sets on screen under a "discarded" toast
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      setOpenId((id) => (id === sessionId ? null : id));
      setDiscardArm(null);
      // same race as voidPastSet: the queued patch has to reach the server
      // before the refetch asks it what is still live
      await outbox.flush();
      // the discard touches EVERY exercise trained that day, not just the one
      // on screen — clear the whole per-exercise cache family so stale
      // offline reads can't resurrect it
      await invalidateForSessionClose();
      setReloadTick((t) => t + 1);
      toast("Session discarded — every exercise from that day");
    } catch (e) {
      reportError(e, "discard session");
    }
  };

  /** Delete one open observation. Two-tap confirm like DISCARD, since it
   *  is the coach's own conclusion and not something to lose to a
   *  fat-fingered tap. */
  const deleteObservationRow = async (id: string) => {
    try {
      await deleteObservation(id);
      setObservations((prev) => prev.filter((o) => o.id !== id));
      setObsDeleteArm(null);
    } catch (e) {
      reportError(e, "delete coach observation");
    }
  };

  const bySession = useMemo(() => {
    const groups = new Map<string, SetInsert[]>();
    for (const s of recent) {
      const g = groups.get(s.session_id) ?? [];
      g.push(s);
      groups.set(s.session_id, g);
    }
    return [...groups.entries()];
  }, [recent]);

  const tonnage = useMemo(() => latestTonnage(volume), [volume]);

  /** A set that happened must never render as nothing, so an id the library
   *  cannot name falls back to the id rather than to a blank line. */
  const exerciseName = useMemo(() => {
    const byId = new Map(exercises.map((e) => [e.id, e.name]));
    return (id: string) => byId.get(id) ?? id;
  }, [exercises]);

  /** First run: no logged exercise AND no finished session. One empty state,
   *  not three stacked ones saying the same thing in different words. */
  const bare =
    !indexLoading &&
    !logLoading &&
    !indexError &&
    !goalsError &&
    layered.length === 0 &&
    goals.length === 0 &&
    sessions.length === 0;

  const e1Text = (kg: number | null) =>
    kg === null ? "—" : `${toDisplay(kg, unit)} ${unit}`;
  const metaOf = (r: RecordRow) => {
    if (r.lastAt === "") return "NOT LOGGED YET";
    const n = r.recentSessions;
    const count =
      n === 0
        ? `no sessions in ${RECENT_WINDOW_DAYS} days`
        : `${n} ${n === 1 ? "session" : "sessions"} in ${RECENT_WINDOW_DAYS} days`;
    return `${formatSessionDate(r.lastAt)} · ${count}${r.onPhone ? " · on phone, not sent yet" : ""}`;
  };
  const armedNote = (exerciseId: string) => {
    const g = goals.find((x) => x.exercise_id === exerciseId);
    if (!g || unpinArm !== exerciseId) return null;
    return (
      <p className="microcopy rec-armed-note" role="status">
        {e1Text(g.target_e1rm_kg)} by {g.target_date} may be your coach’s goal.
        Tap again to remove it.
      </p>
    );
  };
  const pinLabel = (name: string) => `Pinned goal: ${name}`;
  const needsConn = !online;

  const detailE1 =
    series.length > 0
      ? series[series.length - 1].best_e1rm_kg
      : (indexById.get(selected ?? "")?.e1rmKg ?? null);

  return (
    <div className="screen rec-screen">
      {selected === null ? (
        <>
          <h1 className="screen-title">Record</h1>
          <input
            className="input rec-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search your exercises"
            aria-label="Search your exercises"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </>
      ) : (
        <>
          <button
            type="button"
            className="rec-back"
            onClick={() => setSelected(null)}
          >
            ‹ Record
          </button>
          <h1 className="screen-title">{selectedName}</h1>
        </>
      )}

      {(selected === null ? listStale : stale) === "offline" && (
        <div className="cache-note" role="status">
          offline — showing cached data
        </div>
      )}
      {(selected === null ? listStale : stale) === "error" && (
        <div className="cache-note cache-note-error" role="status">
          couldn’t refresh — showing cached data
        </div>
      )}
      {needsConn && (
        <p className="microcopy rec-conn-note" role="status">
          Needs a connection to pin or change goals.
        </p>
      )}

      {selected === null &&
        (indexLoading || !exercisesLoaded) &&
        layered.length === 0 && <p className="muted">Loading…</p>}

      {selected === null && indexError && layered.length === 0 && (
        <div className="rec-empty" role="alert">
          <p>Couldn’t load your record. Your sets are safe.</p>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setIndexLoading(true);
              setReloadTick((t) => t + 1);
            }}
          >
            Try again
          </button>
        </div>
      )}
      {selected === null && goalsError && !indexError && (
        <div className="cache-note cache-note-error" role="status">
          couldn’t load your goals
        </div>
      )}
      {selected === null && indexTruncated && !indexError && (
        <p className="microcopy">
          Only your most recent exercises are listed; older ones may be
          missing. Search the full library to find them.
        </p>
      )}

      {selected === null && bare && (
        <p className="rec-empty">
          Your record starts with your first finished session.
        </p>
      )}

      {selected === null &&
        !bare &&
        !indexLoading &&
        exercisesLoaded &&
        !(indexError && layered.length === 0) && (
        <>
          {lists.pinned.length > 0 && (
            <section className="rec-section" aria-label="Pinned goals">
              <div className="field-label">PINNED GOALS</div>
              {lists.pinned.map((r) => {
                const g = r.goal as GoalProgressRow;
                const best = g.recent_best_e1rm_kg ?? g.alltime_best_e1rm_kg;
                const pct = g.pct_of_target;
                return (
                  <div key={r.exerciseId} className="rec-card">
                    <div className="rec-card-head">
                      <button
                        type="button"
                        className="rec-open"
                        onClick={() => setSelected(r.exerciseId)}
                      >
                        <b className="rec-name">{r.name}</b>
                        <span className="rec-meta">{metaOf(r)}</span>
                      </button>
                      <button
                        type="button"
                        className="rec-pin rec-pin-on"
                        aria-pressed="true"
                        aria-label={pinLabel(r.name)}
                        disabled={needsConn}
                        onClick={() => unpinExercise(r.exerciseId)}
                      >
                        {unpinArm === r.exerciseId ? "◆ Remove?" : "◆ Pinned"}
                      </button>
                    </div>
                    {armedNote(r.exerciseId)}
                    <button
                      type="button"
                      className="rec-open rec-progress"
                      onClick={() => setSelected(r.exerciseId)}
                    >
                      <span className="rec-progress-row">
                        <span className="rec-e1">{e1Text(best)}</span>
                        <span className="rec-meta">
                          {e1Text(g.target_e1rm_kg)}
                          {pct !== null ? ` · ${Math.round(pct)}%` : ""}
                        </span>
                      </span>
                      <span className="rec-bar" aria-hidden="true">
                        <span
                          className="rec-bar-fill"
                          style={{
                            width: `${Math.min(100, Math.max(0, pct ?? 0))}%`,
                          }}
                        />
                      </span>
                    </button>
                  </div>
                );
              })}
            </section>
          )}

          <section className="rec-section" aria-label="Recent">
            <div className="field-label">RECENT</div>
            {lists.recent.map((r) => (
              <div key={r.exerciseId} className="rec-row">
                <button
                  type="button"
                  className="rec-open"
                  onClick={() => setSelected(r.exerciseId)}
                >
                  <b className="rec-name">{r.name}</b>
                  <span className="rec-meta">{metaOf(r)}</span>
                </button>
                <span className="rec-row-e1">{e1Text(r.e1rmKg)}</span>
                <button
                  type="button"
                  className="rec-pin"
                  aria-pressed="false"
                  aria-label={pinLabel(r.name)}
                  disabled={r.e1rmKg === null || needsConn}
                  onClick={() => pinExercise(r.exerciseId, r.e1rmKg)}
                >
                  ◇ Pin
                </button>
              </div>
            ))}
            {lists.recent.length === 0 &&
              lists.pinned.length === 0 &&
              search.trim() !== "" && (
                <p className="muted">
                  Nothing matches “{search.trim()}”. Try the full library.
                </p>
              )}
          </section>

          <button
            type="button"
            className="rec-library"
            onClick={() => setPickerOpen(true)}
          >
            Search the full library
          </button>
        </>
      )}

      {selected !== null && (
        <>
          <section className="rec-goalcard" aria-label="Goal">
            <div>
              <span className="field-label">GOAL · ESTIMATED 1RM</span>
              <b className="rec-goal-val">
                {goal ? e1Text(goal.target_e1rm_kg) : "No goal yet"}
              </b>
              <span className="sr-only" role="status" aria-live="polite">
                {announce}
              </span>
              {goal?.pct_of_target != null && (
                <span className="goal-pct">{goal.pct_of_target}% OF GOAL</span>
              )}
            </div>
            {goal ? (
              <div className="rec-goal-actions">
                <button
                  type="button"
                  className="rec-step"
                  aria-label={`Lower goal by ${goalStep(unit)} ${unit}`}
                  disabled={needsConn}
                  onClick={() => stepGoal(selected, -1)}
                >
                  −
                </button>
                <button
                  type="button"
                  className="rec-step"
                  aria-label={`Raise goal by ${goalStep(unit)} ${unit}`}
                  disabled={needsConn}
                  onClick={() => stepGoal(selected, 1)}
                >
                  +
                </button>
                <button
                  type="button"
                  className="rec-pin rec-pin-on"
                  aria-pressed="true"
                  aria-label={pinLabel(selectedName)}
                  disabled={needsConn}
                  onClick={() => unpinExercise(selected)}
                >
                  {unpinArm === selected ? "◆ Remove?" : "◆ Pinned"}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-primary rec-pin-goal"
                disabled={detailE1 === null || needsConn}
                onClick={() => pinExercise(selected, detailE1)}
              >
                Pin as goal
              </button>
            )}
          </section>
          {armedNote(selected)}
          {!goal && detailE1 === null && !detailLoading && (
            <p className="microcopy">
              A goal needs a working set of 1–8 reps to measure against.
            </p>
          )}

          <section className="rule-section">
            <div className="section-head">
              <span className="field-label">E1RM · {unit.toUpperCase()}</span>
              {detailE1 !== null && (
                <span className="section-meta">LATEST {e1Text(detailE1)}</span>
              )}
            </div>
            {detailLoading && series.length === 0 ? (
              <div className="chart-empty">Loading…</div>
            ) : (
              <E1rmChart
                series={series}
                goalKg={goal?.target_e1rm_kg ?? null}
              />
            )}
          </section>

          <section className="rule-section">
            <div className="section-head">
              <span className="field-label">WEEKLY WORKING SETS</span>
              {/* tonnage was already fetched with the bars and thrown away;
                  it is one figure, so it rides in the head rather than
                  earning a second chart */}
              {tonnage !== null && (
                <span className="section-meta">
                  {Math.round(
                    toDisplay(tonnage.tonnage_kg, unit),
                  ).toLocaleString()}{" "}
                  {unit} LAST WEEK
                </span>
              )}
            </div>
            {detailLoading && volume.length === 0 ? (
              <div className="chart-empty">Loading…</div>
            ) : (
              <VolumeChart weeks={volume} />
            )}
          </section>

          <section className="rule-section">
            <div className="section-head">
              <span className="field-label">RECENT SETS</span>
            </div>
            {bySession.length === 0 && (
              <p className="muted">
                {detailLoading ? "Loading…" : "Nothing logged yet."}
              </p>
            )}
            {bySession.map(([sessionId, ss]) => {
              const outcomes = planned.get(sessionId) ?? [];
              const bw = meta[sessionId]?.bodyweight_kg;
              const rpe = meta[sessionId]?.session_rpe;
              return (
                <div key={sessionId} className="history-session">
                  <div className="history-date">
                    {formatSessionDate(ss[0].performed_at)}
                    {ss.some((x) => unsentIds.has(x.id)) && (
                      <span className="rec-onphone">on phone, not sent yet</span>
                    )}
                    {/* the word, not ✕ — ✕ is reserved for single-set voids;
                      discarding takes the whole day with it */}
                    {sessionId !== activeId && (
                      <button
                        type="button"
                        className={`drawer-action ${discardArm === sessionId ? "drawer-action-armed" : ""}`}
                        aria-label={
                          discardArm === sessionId
                            ? "confirm discard session"
                            : "discard session"
                        }
                        onClick={() =>
                          discardArm === sessionId
                            ? void discardSession(sessionId)
                            : setDiscardArm(sessionId)
                        }
                      >
                        {discardArm === sessionId ? "DISCARD?" : "DISCARD"}
                      </button>
                    )}
                  </div>
                  {(rpe != null || bw != null) && (
                    <div className="muted-mono">
                      {[
                        rpe != null ? `sRPE ${rpe}` : null,
                        // captured on the End screen and, until now, never read
                        // back anywhere
                        bw != null ? `BW ${toDisplay(bw, unit)} ${unit}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  )}
                  {meta[sessionId]?.notes && (
                    <div className="detail-note">
                      <span className="detail-note-label">NOTE</span>
                      {meta[sessionId].notes}
                    </div>
                  )}
                  {/* the plan sits directly on top of the sets that answered
                      it — nothing between them to compare across */}
                  {outcomes.length > 0 && (
                    <div className="muted-mono">
                      PLANNED{" "}
                      {outcomes.map((o) => formatPlanned(o, unit)).join(" · ")}
                    </div>
                  )}
                  {outcomes.some((o) => o.entryAmbiguous) && (
                    <div className="microcopy">
                      Prescribed per side; these sets recorded no entry mode, so
                      the two loads may not compare.
                    </div>
                  )}
                  {ss
                    .slice()
                    .sort((a, b) => a.set_index - b.set_index)
                    .map((s) => (
                      <div key={s.id} className="logged-set-wrap">
                        <SetRow
                          set={s}
                          unit={unit}
                          onVoid={
                            sessionId !== activeId
                              ? () => void voidPastSet(s)
                              : undefined
                          }
                          voidArmed={voidArm === s.id}
                          onArmVoid={() => setVoidArm(s.id)}
                        />
                        {notes[s.id] && (
                          <div className="set-note-preview">{notes[s.id]}</div>
                        )}
                      </div>
                    ))}
                </div>
              );
            })}
          </section>
        </>
      )}

      {/* A standing fact about the person, not about any one exercise's
          history — same component, same behaviour as the identical row
          on Today, rendered regardless of `bare` for the same reason
          Today doesn't gate it on having a program either. */}
      {selected === null && <BodyweightRow />}

      {selected === null && !bare && (
        <>
          <section className="rule-section">
            <div className="section-head">
              <span className="field-label">THIS WEEK</span>
              {/* the Monday the numbers are counted from, so the line cannot
                  be mistaken for a rolling seven days */}
              <span className="section-meta">
                FROM {formatSessionDate(weekStart)}
              </span>
            </div>
            <WeekLine row={week} unit={unit} loading={weekLoading} />
          </section>

          <section className="rule-section">
            <div className="section-head">
              <span className="field-label">CHECK-INS</span>
            </div>
            <CheckinWeek today={today} userId={userId} />
          </section>

          <section className="rule-section">
            <div className="section-head">
              <span className="field-label">WHAT THE COACH IS WATCHING</span>
            </div>
            {obsLoading && observations.length === 0 && (
              <p className="muted">Loading…</p>
            )}
            {!obsLoading && observations.length === 0 && (
              <p className="muted">Nothing open right now.</p>
            )}
            {observations.map((o) => (
              <div key={o.id} className="history-session">
                <div className="history-date">
                  <span className="muted-mono">{o.topic.toUpperCase()}</span>
                  <button
                    type="button"
                    className={`drawer-action ${obsDeleteArm === o.id ? "drawer-action-armed" : ""}`}
                    aria-label={
                      obsDeleteArm === o.id
                        ? "confirm delete observation"
                        : "delete observation"
                    }
                    onClick={() =>
                      obsDeleteArm === o.id
                        ? void deleteObservationRow(o.id)
                        : setObsDeleteArm(o.id)
                    }
                  >
                    {obsDeleteArm === o.id ? "DELETE?" : "DELETE"}
                  </button>
                </div>
                <div className="detail-note">{o.observation}</div>
                {o.check_back_on && (
                  <div className="muted-mono">
                    CHECK BACK {formatSessionDate(o.check_back_on)}
                  </div>
                )}
              </div>
            ))}
          </section>

          <section className="rule-section">
            <div className="section-head">
              <span className="field-label">SESSIONS</span>
            </div>
            <SessionList
              sessions={sessions}
              loading={logLoading}
              unit={unit}
              openId={openId}
              onToggle={(id) => setOpenId((cur) => (cur === id ? null : id))}
              openSets={openSets}
              exerciseName={exerciseName}
            />
          </section>
        </>
      )}

      {undo !== null && (
        <div className="rec-undo" role="status">
          <span>Unpinned {nameOf(exercises, undo.exercise_id)}.</span>
          <button
            type="button"
            className="rec-undo-btn"
            disabled={needsConn}
            onClick={undoUnpin}
          >
            Undo
          </button>
        </div>
      )}

      {pickerOpen && (
        <ExercisePicker
          title="EXERCISE"
          exercises={exercises}
          badge={(ex) => (indexById.has(ex.id) ? "LOGGED" : null)}
          preferBadged
          onPick={(ex) => {
            setSelected(ex.id);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

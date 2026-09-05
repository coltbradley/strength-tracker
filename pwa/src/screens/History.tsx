// History: per-exercise e1RM chart (goal % in teal), weekly working-set bars,
// recent sets grouped by session date. Exactly two charts.
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
import {
  getAdherence,
  getE1rmSeries,
  getExercises,
  getGoalProgress,
  getLoggedExerciseIds,
  getRecentSets,
  getSessionMeta,
  getSetNotesForExercise,
  getWeeklyVolume,
  invalidateForSessionClose,
  invalidateForSetChange,
  summariseAdherence,
  type RxOutcome,
  type SessionMetaRow,
} from "../lib/data";
import { reportError, toast } from "../lib/errors";
import { formatRepRange, formatSessionDate } from "../lib/format";
import { cacheGet, cacheKeys } from "../lib/db";
import { outbox } from "../lib/sync";
import { useUnit } from "../hooks/useUnit";
import { toDisplay, type Unit } from "../lib/units";
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

export function History() {
  const unit = useUnit();
  const [exercises, setExercises] = useState<ExerciseRow[]>([]);
  const [withData, setWithData] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const [series, setSeries] = useState<SessionBestE1rmRow[]>([]);
  const [volume, setVolume] = useState<WeeklyVolumeRow[]>([]);
  const [goal, setGoal] = useState<GoalProgressRow | null>(null);
  const [recent, setRecent] = useState<SetInsert[]>([]);
  const [meta, setMeta] = useState<Record<string, SessionMetaRow>>({});
  /** session_id -> what each prescription in it asked for */
  const [planned, setPlanned] = useState<Map<string, RxOutcome[]>>(new Map());
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [fromCache, setFromCache] = useState(false);
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

  useEffect(() => {
    void cacheGet<ActiveSession>(cacheKeys.activeSession)
      .then((a) => setActiveId(a?.id ?? null))
      .catch((e: unknown) => reportError(e, "read active session"));
    getExercises()
      .then((r) => setExercises(r.data))
      .catch((e: unknown) => reportError(e, "load exercises"));
    // only which exercises have data — not every set ever logged
    getLoggedExerciseIds()
      .then((r) => {
        const ids = new Set(r.data);
        setWithData(ids);
        setSelected((cur) => cur ?? [...ids][0] ?? null);
      })
      .catch((e: unknown) => reportError(e, "load history index"))
      .finally(() => setIndexLoading(false));
  }, [reloadTick]);

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
      setGoal(null);
      setRecent([]);
      setMeta({});
      setNotes({});
      setPlanned(new Map());
    }
    shownFor.current = selected;
    setDetailLoading(true);
    void (async () => {
      try {
        const [e1, vol, g, rec] = await Promise.all([
          getE1rmSeries(selected),
          getWeeklyVolume(selected),
          getGoalProgress(selected),
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
        const [voided, discarded] = await Promise.all([
          outbox.pendingVoidIds(),
          outbox.pendingDiscardIds(),
        ]);
        if (cancelled) return;
        const live = rec.data.filter(
          (s) => !voided.has(s.id) && !discarded.has(s.session_id),
        );
        setSeries(e1.data);
        setVolume(vol.data);
        setGoal(g.data);
        setRecent(live);
        setFromCache(e1.fromCache || vol.fromCache || rec.fromCache);
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
    () => exercises.find((e) => e.id === selected)?.name ?? selected ?? "",
    [exercises, selected],
  );

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

  return (
    <div className="screen">
      {/* the screen's h1 is the exercise on show; the button is the control */}
      <h1>
        <button
          type="button"
          className="hist-picker"
          onClick={() => setPickerOpen(true)}
        >
          <span>{(selectedName || "Pick exercise").toUpperCase()}</span>
          <span className="chev" aria-hidden="true">
            ▾
          </span>
        </button>
      </h1>

      {fromCache && (
        <div className="cache-note">offline — showing cached data</div>
      )}

      {indexLoading && !selected && <p className="muted">Loading…</p>}

      {!indexLoading && !selected && (
        <p className="muted">
          Nothing logged yet — finish a session and it shows up here.
        </p>
      )}

      {selected && (
        <>
          <section className="rule-section">
            <div className="section-head">
              <span className="field-label">E1RM · {unit.toUpperCase()}</span>
              {goal?.pct_of_target != null && (
                <span className="goal-pct">{goal.pct_of_target}% OF GOAL</span>
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

      {pickerOpen && (
        <ExercisePicker
          title="EXERCISE"
          exercises={exercises}
          badge={(ex) => (withData.has(ex.id) ? "LOGGED" : null)}
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

// History: per-exercise e1RM chart (goal % in teal), weekly working-set bars,
// recent sets grouped by session date. Exactly two charts.

import { useEffect, useMemo, useRef, useState } from "react";
import { E1rmChart } from "../components/charts/E1rmChart";
import { VolumeChart } from "../components/charts/VolumeChart";
import { SetRow } from "../components/SetRow";
import {
  getE1rmSeries,
  getExercises,
  getGoalProgress,
  getLastActuals,
  getRecentSets,
  getSessionMeta,
  getSetNotesForExercise,
  getWeeklyVolume,
  type SessionMetaRow,
} from "../lib/data";
import { reportError, toast } from "../lib/errors";
import { formatSessionDate } from "../lib/format";
import { cacheDeleteByPrefix, cacheGet, cacheKeys } from "../lib/db";
import { outbox } from "../lib/sync";
import { useUnit } from "../hooks/useUnit";
import { useArmed } from "../hooks/useArmed";
import type {
  ActiveSession,
  ExerciseRow,
  GoalProgressRow,
  SessionBestE1rmRow,
  SetInsert,
  WeeklyVolumeRow,
} from "../lib/types";

export function History() {
  const unit = useUnit();
  const [exercises, setExercises] = useState<ExerciseRow[]>([]);
  const [withData, setWithData] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  const [series, setSeries] = useState<SessionBestE1rmRow[]>([]);
  const [volume, setVolume] = useState<WeeklyVolumeRow[]>([]);
  const [goal, setGoal] = useState<GoalProgressRow | null>(null);
  const [recent, setRecent] = useState<SetInsert[]>([]);
  const [meta, setMeta] = useState<Record<string, SessionMetaRow>>({});
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
    getLastActuals()
      .then((r) => {
        const ids = new Set(Object.keys(r.data));
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
        setSeries(e1.data);
        setVolume(vol.data);
        setGoal(g.data);
        setRecent(rec.data);
        setFromCache(e1.fromCache || vol.fromCache || rec.fromCache);
        // post-workout notes + sRPE for the visible sessions; cached so
        // notes read back offline too
        const ids = [...new Set(rec.data.map((s) => s.session_id))];
        getSessionMeta(selected, ids)
          .then((m) => {
            if (!cancelled) setMeta(m.data);
          })
          .catch((e: unknown) => {
            // a swallowed failure here silently loses the post-workout note
            if (!cancelled) reportError(e, "load session notes");
          });
        getSetNotesForExercise(
          selected,
          rec.data.map((s) => s.id),
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

  const pickerList = useMemo(() => {
    const q = search.toLowerCase();
    const matches = (e: ExerciseRow) => e.name.toLowerCase().includes(q);
    if (q === "") {
      const dataFirst = exercises.filter((e) => withData.has(e.id));
      return dataFirst.length > 0 ? dataFirst : exercises.slice(0, 30);
    }
    return exercises.filter(matches).slice(0, 30);
  }, [exercises, withData, search]);

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
      await cacheDeleteByPrefix([
        "recent:",
        "e1rm:",
        "volume:",
        "goal:",
        "lastActuals:",
      ]);
      setReloadTick((t) => t + 1);
      toast("Set voided");
    } catch (e) {
      reportError(e, "void set");
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
      // the discard touches EVERY exercise trained that day, not just the one
      // on screen — clear the whole per-exercise cache family so stale
      // offline reads can't resurrect it
      await cacheDeleteByPrefix([
        "recent:",
        "e1rm:",
        "volume:",
        "goal:",
        "sessionMeta:",
        "setNotes:",
        "lastActuals:",
        "doneWorkouts:",
      ]);
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

  return (
    <div className="screen">
      <button
        type="button"
        className="hist-picker"
        onClick={() => {
          setPickerOpen(true);
          setSearch("");
        }}
      >
        <span>{(selectedName || "Pick exercise").toUpperCase()}</span>
        <span className="chev">▾</span>
      </button>

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
            {bySession.map(([sessionId, ss]) => (
              <div key={sessionId} className="history-session">
                <div className="history-date">
                  {formatSessionDate(ss[0].performed_at)}
                  {/* the word, not ✕ — ✕ is reserved for single-set voids;
                      discarding takes the whole day with it */}
                  {sessionId !== activeId && (
                    <button
                      type="button"
                      className={`drawer-action ${discardArm === sessionId ? "set-void-armed" : ""}`}
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
                {meta[sessionId]?.session_rpe != null && (
                  <div className="muted-mono">
                    sRPE {meta[sessionId].session_rpe}
                  </div>
                )}
                {meta[sessionId]?.notes && (
                  <div className="detail-note">
                    <span className="detail-note-label">NOTE</span>
                    {meta[sessionId].notes}
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
            ))}
          </section>
        </>
      )}

      {pickerOpen && (
        <div className="sheet-backdrop" onClick={() => setPickerOpen(false)}>
          <div
            className="sheet sheet-tall"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sheet-head">
              <span className="sheet-title">EXERCISE</span>
              <button
                type="button"
                className="sheet-close"
                onClick={() => setPickerOpen(false)}
              >
                CANCEL
              </button>
            </div>
            <input
              className="input"
              placeholder="Search exercises…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
            <div className="search-results">
              {pickerList.map((ex) => (
                <button
                  key={ex.id}
                  type="button"
                  className="drawer-row"
                  onClick={() => {
                    setSelected(ex.id);
                    setPickerOpen(false);
                  }}
                >
                  <span className="drawer-name">{ex.name}</span>
                  {withData.has(ex.id) && (
                    <span className="drawer-tag">LOGGED</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

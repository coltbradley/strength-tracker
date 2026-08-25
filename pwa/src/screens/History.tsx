// History: per-exercise e1RM line chart (with goal overlay), weekly
// working-set bars, recent sets grouped by session. Exactly two charts.

import { useEffect, useMemo, useState } from "react";
import { E1rmChart } from "../components/charts/E1rmChart";
import { VolumeChart } from "../components/charts/VolumeChart";
import {
  getE1rmSeries,
  getExercises,
  getGoalProgress,
  getLastActuals,
  getRecentSets,
  getWeeklyVolume,
} from "../lib/data";
import { reportError } from "../lib/errors";
import { useUnit } from "../hooks/useUnit";
import { SetRow } from "../components/SetRow";
import type {
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
  const [fromCache, setFromCache] = useState(false);

  useEffect(() => {
    getExercises()
      .then((r) => setExercises(r.data))
      .catch((e: unknown) => reportError(e, "load exercises"));
    getLastActuals()
      .then((r) => {
        const ids = new Set(Object.keys(r.data));
        setWithData(ids);
        // default selection: first exercise with data
        setSelected((cur) => cur ?? [...ids][0] ?? null);
      })
      .catch((e: unknown) => reportError(e, "load history index"));
  }, []);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
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
      } catch (e) {
        if (!cancelled) reportError(e, "load history");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

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

  const bySession = useMemo(() => {
    const groups = new Map<string, SetInsert[]>();
    for (const s of recent) {
      const g = groups.get(s.session_id) ?? [];
      g.push(s);
      groups.set(s.session_id, g);
    }
    return [...groups.entries()];
  }, [recent]);

  const fmtDay = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  return (
    <div className="screen">
      <button
        type="button"
        className="btn btn-secondary btn-block"
        onClick={() => {
          setPickerOpen(true);
          setSearch("");
        }}
      >
        {selectedName || "Pick exercise"} <span className="chev">▾</span>
      </button>

      {fromCache && (
        <div className="cache-note">offline — showing cached data</div>
      )}

      {selected && (
        <>
          <section className="card">
            <div className="card-title">
              e1RM ({unit})
              {goal?.pct_of_target != null && (
                <span className="muted"> · {goal.pct_of_target}% of goal</span>
              )}
            </div>
            <E1rmChart series={series} goalKg={goal?.target_e1rm_kg ?? null} />
          </section>

          <section className="card">
            <div className="card-title">Weekly working sets</div>
            <VolumeChart weeks={volume} />
          </section>

          <section className="card">
            <div className="card-title">Recent sets</div>
            {bySession.length === 0 && (
              <p className="muted">Nothing logged yet.</p>
            )}
            {bySession.map(([sessionId, ss]) => (
              <div key={sessionId} className="history-session">
                <div className="history-date">{fmtDay(ss[0].performed_at)}</div>
                {ss
                  .slice()
                  .sort((a, b) => a.set_index - b.set_index)
                  .map((s) => (
                    <SetRow key={s.id} set={s} unit={unit} />
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
            <div className="sheet-title">Exercise</div>
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
                  <span>{ex.name}</span>
                  {withData.has(ex.id) && <span className="muted">logged</span>}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setPickerOpen(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

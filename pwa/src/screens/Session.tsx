// Set entry — the core screen. Steppers only, no keyboard. Everything the
// screen needs is served from the IndexedDB cache written at session start,
// so it works fully offline mid-gym. Sets are append-only: a mistake is
// corrected by logging another set, never edited.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Stepper } from "../components/Stepper";
import { RestTimer } from "../components/RestTimer";
import { cacheGet, cacheSet, cacheKeys } from "../lib/db";
import {
  getExercises,
  getLastActuals,
  getServerSessionSets,
  mergeSets,
  type LastActuals,
} from "../lib/data";
import { outbox } from "../lib/sync";
import { uuid } from "../lib/uuid";
import { prefillSet } from "../lib/prefill";
import { reportError } from "../lib/errors";
import { useUnit } from "../hooks/useUnit";
import { stepKg, toDisplay, formatLoad } from "../lib/units";
import type {
  ActiveSession,
  ExerciseRow,
  ResolvedPrescriptionRow,
  SetInsert,
  SetType,
} from "../lib/types";

interface ExtraExercise {
  exercise_id: string;
  name: string;
}

interface ExerciseEntry {
  exercise_id: string;
  name: string;
  rx: ResolvedPrescriptionRow | null;
}

const DEFAULT_REST_SECONDS = 120;
const SET_TYPES: SetType[] = ["warmup", "working", "backoff"];

export function Session() {
  const navigate = useNavigate();
  const unit = useUnit();

  const [active, setActive] = useState<ActiveSession | null | undefined>(
    undefined,
  );
  const [rx, setRx] = useState<ResolvedPrescriptionRow[]>([]);
  const [extras, setExtras] = useState<ExtraExercise[]>([]);
  const [sets, setSets] = useState<SetInsert[]>([]);
  const [lastActuals, setLastActuals] = useState<LastActuals>({});
  const [currentId, setCurrentId] = useState<string | null>(null);

  const [loadKg, setLoadKg] = useState(20);
  const [reps, setReps] = useState(8);
  const [setType, setSetType] = useState<SetType>("working");
  const [timerEndsAt, setTimerEndsAt] = useState<number | null>(null);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [allExercises, setAllExercises] = useState<ExerciseRow[]>([]);

  const sessionId = active?.id ?? null;

  // ---- bootstrap -----------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const a = await cacheGet<ActiveSession>(cacheKeys.activeSession);
        if (cancelled) return;
        if (!a) {
          setActive(null);
          return;
        }
        setActive(a);
        const [rxCached, extrasCached, actuals] = await Promise.all([
          cacheGet<ResolvedPrescriptionRow[]>(cacheKeys.sessionRx(a.id)),
          cacheGet<ExtraExercise[]>(cacheKeys.sessionExtras(a.id)),
          getLastActuals(a.id).catch(() => ({ data: {} as LastActuals })),
        ]);
        if (cancelled) return;
        setRx(rxCached ?? []);
        setExtras(extrasCached ?? []);
        setLastActuals(actuals.data);
        const [server, pending] = await Promise.all([
          getServerSessionSets(a.id),
          outbox.pendingSets(a.id),
        ]);
        if (cancelled) return;
        setSets(mergeSets(server, pending));
      } catch (e) {
        reportError(e, "load session");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // redirect if no active session
  useEffect(() => {
    if (active === null) navigate("/", { replace: true });
  }, [active, navigate]);

  // ---- exercise list -------------------------------------------------------

  const entries: ExerciseEntry[] = useMemo(() => {
    const fromRx = rx.map((r) => ({
      exercise_id: r.exercise_id,
      name: r.exercise_name,
      rx: r,
    }));
    const extraEntries = extras
      .filter((e) => !fromRx.some((f) => f.exercise_id === e.exercise_id))
      .map((e) => ({ exercise_id: e.exercise_id, name: e.name, rx: null }));
    return [...fromRx, ...extraEntries];
  }, [rx, extras]);

  const current = useMemo(
    () =>
      entries.find((e) => e.exercise_id === currentId) ?? entries[0] ?? null,
    [entries, currentId],
  );

  const setsFor = useCallback(
    (exerciseId: string) => sets.filter((s) => s.exercise_id === exerciseId),
    [sets],
  );

  // ---- prefill on exercise switch ------------------------------------------

  const prefilledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!current || prefilledFor.current === current.exercise_id) return;
    prefilledFor.current = current.exercise_id;
    const logged = setsFor(current.exercise_id);
    const lastThis = logged[logged.length - 1];
    const p = prefillSet({
      prescription: current.rx
        ? {
            resolved_load_kg: current.rx.resolved_load_kg,
            plate_load_kg: current.rx.plate_load_kg,
            reps_min: current.rx.reps_min,
            reps_max: current.rx.reps_max,
          }
        : null,
      lastThisSession: lastThis
        ? { load_kg: lastThis.load_kg, reps: lastThis.reps }
        : null,
      lastSession: lastActuals[current.exercise_id] ?? null,
    });
    setLoadKg(p.loadKg);
    setReps(p.reps);
    setSetType("working");
  }, [current, setsFor, lastActuals]);

  // ---- actions -------------------------------------------------------------

  const logSet = async () => {
    if (!current || !sessionId) return;
    try {
      const logged = setsFor(current.exercise_id);
      const set: SetInsert = {
        id: uuid(),
        session_id: sessionId,
        exercise_id: current.exercise_id,
        prescription_id: current.rx?.id ?? null,
        set_index: logged.length,
        set_type: setType,
        load_kg: loadKg,
        reps,
        performed_at: new Date().toISOString(),
      };
      await outbox.enqueue({ kind: "insert", table: "sets", payload: set });
      const next = [...sets, set];
      setSets(next);
      await cacheSet(cacheKeys.sessionSets(sessionId), next);
      const rest = current.rx?.rest_seconds ?? DEFAULT_REST_SECONDS;
      setTimerEndsAt(Date.now() + rest * 1000);
      setSetType("working");
    } catch (e) {
      reportError(e, "log set");
    }
  };

  const openSearch = () => {
    setSearchOpen(true);
    setSearch("");
    if (allExercises.length === 0) {
      getExercises()
        .then((r) => setAllExercises(r.data))
        .catch((e: unknown) => reportError(e, "load exercises"));
    }
  };

  const addExercise = async (ex: ExerciseRow) => {
    if (!sessionId) return;
    const nextExtras = extras.some((e) => e.exercise_id === ex.id)
      ? extras
      : [...extras, { exercise_id: ex.id, name: ex.name }];
    setExtras(nextExtras);
    await cacheSet(cacheKeys.sessionExtras(sessionId), nextExtras);
    setCurrentId(ex.id);
    setSearchOpen(false);
    setDrawerOpen(false);
  };

  // ---- render --------------------------------------------------------------

  if (active === undefined) return <div className="screen muted">Loading…</div>;
  if (!active) return null;

  const currentSets = current ? setsFor(current.exercise_id) : [];
  const filtered = allExercises
    .filter((e) => e.name.toLowerCase().includes(search.toLowerCase()))
    .slice(0, 30);

  return (
    <div className="screen session">
      {current ? (
        <>
          <div className="session-head">
            <button
              type="button"
              className="session-exercise"
              onClick={() => setDrawerOpen(true)}
            >
              {current.name} <span className="chev">▾</span>
            </button>
            {current.rx && (
              <div className="rx-context">
                target {current.rx.sets}×
                {current.rx.reps_min === current.rx.reps_max
                  ? current.rx.reps_min
                  : `${current.rx.reps_min}–${current.rx.reps_max}`}
                {current.rx.plate_load_kg !== null ||
                current.rx.resolved_load_kg !== null
                  ? ` @ ${formatLoad(current.rx.plate_load_kg ?? current.rx.resolved_load_kg ?? 0, unit)}`
                  : current.rx.load_pct_tm !== null
                    ? " · no TM set"
                    : ""}
              </div>
            )}
            <div className="rx-context muted">
              logged {currentSets.length}
              {current.rx ? ` / ${current.rx.sets}` : ""} sets
            </div>
          </div>

          <Stepper
            label={`load (${unit})`}
            value={loadKg}
            display={String(toDisplay(loadKg, unit))}
            step={stepKg(unit, false)}
            fineStep={stepKg(unit, true)}
            onChange={setLoadKg}
          />
          <Stepper
            label="reps"
            value={reps}
            display={String(reps)}
            step={1}
            min={0}
            onChange={(v) => setReps(Math.round(v))}
          />

          <div className="seg seg-types">
            {SET_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                className={`seg-btn ${setType === t ? "seg-on" : ""}`}
                onClick={() => setSetType(t)}
              >
                {t}
              </button>
            ))}
          </div>

          <button
            type="button"
            className="btn btn-primary btn-log"
            onClick={() => void logSet()}
          >
            Log set
          </button>

          {currentSets.length > 0 && (
            <div className="logged-sets">
              {currentSets.map((s) => (
                <div key={s.id} className="logged-set">
                  <span className="muted">#{s.set_index + 1}</span>
                  <span>
                    {toDisplay(s.load_kg, unit)} {unit} × {s.reps}
                  </span>
                  <span className="muted">{s.set_type}</span>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="session-empty">
          <p className="muted">No exercises yet.</p>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={openSearch}
          >
            Add exercise
          </button>
        </div>
      )}

      <div className="session-footer">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setDrawerOpen(true)}
        >
          Exercises
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => navigate("/end")}
        >
          Finish
        </button>
      </div>

      <RestTimer endsAt={timerEndsAt} onDismiss={() => setTimerEndsAt(null)} />

      {drawerOpen && (
        <div className="sheet-backdrop" onClick={() => setDrawerOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">Exercises</div>
            {entries.map((e) => {
              const done = setsFor(e.exercise_id).length;
              return (
                <button
                  key={e.exercise_id}
                  type="button"
                  className={`drawer-row ${current?.exercise_id === e.exercise_id ? "drawer-on" : ""}`}
                  onClick={() => {
                    setCurrentId(e.exercise_id);
                    setDrawerOpen(false);
                  }}
                >
                  <span>{e.name}</span>
                  <span className="muted">
                    {done}
                    {e.rx ? `/${e.rx.sets}` : ""}
                  </span>
                </button>
              );
            })}
            <button
              type="button"
              className="btn btn-secondary"
              onClick={openSearch}
            >
              Add exercise
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setDrawerOpen(false)}
            >
              Close
            </button>
          </div>
        </div>
      )}

      {searchOpen && (
        <div className="sheet-backdrop" onClick={() => setSearchOpen(false)}>
          <div
            className="sheet sheet-tall"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sheet-title">Add exercise</div>
            <input
              className="input"
              placeholder="Search exercises…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
            <div className="search-results">
              {filtered.map((ex) => (
                <button
                  key={ex.id}
                  type="button"
                  className="drawer-row"
                  onClick={() => void addExercise(ex)}
                >
                  <span>{ex.name}</span>
                  <span className="muted">{ex.equipment ?? ""}</span>
                </button>
              ))}
              {allExercises.length === 0 && (
                <p className="muted">Loading exercise list…</p>
              )}
            </div>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setSearchOpen(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

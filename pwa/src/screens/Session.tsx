// Set entry — the core screen. Steppers only, no keyboard. Everything the
// screen needs is served from the IndexedDB cache written at session start,
// so it works fully offline mid-gym. Sets are append-only: a mistake is
// corrected by logging another set, never edited.
//
// State notes:
// - Entries are keyed by prescription id (or `extra:<exercise_id>` for
//   unprescribed additions) so the same exercise under two prescriptions
//   stays two distinct entries. set_index stays scoped per EXERCISE across
//   entries (matches the DB model).
// - `setsRef` is the synchronous source of truth for logged sets: log taps
//   compute set_index from it and update it atomically, so a double-tap can
//   never mint a duplicate index or drop a set. Bootstrap results merge INTO
//   it (union by id) rather than replacing it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Stepper } from "../components/Stepper";
import { RestTimer } from "../components/RestTimer";
import { SetRow } from "../components/SetRow";
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
import { formatRxTarget, rxHasNoTm } from "../lib/format";
import { reportError } from "../lib/errors";
import { useUnit } from "../hooks/useUnit";
import { stepKg, toDisplay } from "../lib/units";
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
  /** prescription id, or `extra:<exercise_id>` for unprescribed additions */
  key: string;
  exercise_id: string;
  name: string;
  rx: ResolvedPrescriptionRow | null;
}

const DEFAULT_REST_SECONDS = 120;
const SET_TYPES: SetType[] = ["warmup", "working", "backoff"];
const LOG_LOCK_MS = 400;
// DB checks: reps between 0 and 100; load_kg numeric(6,2)
const MAX_REPS = 100;
const MAX_LOAD_KG = 999;

export function Session() {
  const navigate = useNavigate();
  const unit = useUnit();

  const [active, setActive] = useState<ActiveSession | null | undefined>(
    undefined,
  );
  const [rx, setRx] = useState<ResolvedPrescriptionRow[]>([]);
  const [extras, setExtras] = useState<ExtraExercise[]>([]);
  const [sets, setSets] = useState<SetInsert[]>([]);
  const [setsLoaded, setSetsLoaded] = useState(false);
  const [lastActuals, setLastActuals] = useState<LastActuals>({});
  const [currentEntryId, setCurrentEntryId] = useState<string | null>(null);

  const [loadKg, setLoadKg] = useState(20);
  const [reps, setReps] = useState(8);
  const [setType, setSetType] = useState<SetType>("working");
  const [timerEndsAt, setTimerEndsAt] = useState<number | null>(null);
  const [logLocked, setLogLocked] = useState(false);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [allExercises, setAllExercises] = useState<ExerciseRow[]>([]);

  const sessionId = active?.id ?? null;

  // Synchronous source of truth for logged sets; setSets mirrors it for
  // rendering. All mutations go through applySets.
  const setsRef = useRef<SetInsert[]>([]);
  const applySets = useCallback(
    (updater: (prev: SetInsert[]) => SetInsert[]): SetInsert[] => {
      setsRef.current = updater(setsRef.current);
      setSets(setsRef.current);
      return setsRef.current;
    },
    [],
  );

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
        // Merge INTO current state (a set may have been logged while this
        // load was in flight) — never replace.
        applySets((prev) => mergeSets(mergeSets(server, pending), prev));
      } catch (e) {
        reportError(e, "load session");
      } finally {
        if (!cancelled) setSetsLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applySets]);

  // redirect if no active session
  useEffect(() => {
    if (active === null) navigate("/", { replace: true });
  }, [active, navigate]);

  // ---- exercise entries ----------------------------------------------------

  const entries: ExerciseEntry[] = useMemo(() => {
    const fromRx = rx.map((r) => ({
      key: r.id,
      exercise_id: r.exercise_id,
      name: r.exercise_name,
      rx: r,
    }));
    const extraEntries = extras
      .filter((e) => !fromRx.some((f) => f.exercise_id === e.exercise_id))
      .map((e) => ({
        key: `extra:${e.exercise_id}`,
        exercise_id: e.exercise_id,
        name: e.name,
        rx: null,
      }));
    return [...fromRx, ...extraEntries];
  }, [rx, extras]);

  const current = useMemo(
    () => entries.find((e) => e.key === currentEntryId) ?? entries[0] ?? null,
    [entries, currentEntryId],
  );

  /** all sets for an exercise, across entries (set_index scope) */
  const setsForExercise = useCallback(
    (exerciseId: string) => sets.filter((s) => s.exercise_id === exerciseId),
    [sets],
  );

  /** sets attributed to one entry (by prescription link) */
  const setsForEntry = useCallback(
    (entry: ExerciseEntry) =>
      entry.rx
        ? sets.filter((s) => s.prescription_id === entry.rx?.id)
        : sets.filter(
            (s) =>
              s.exercise_id === entry.exercise_id && s.prescription_id === null,
          ),
    [sets],
  );

  // ---- prefill on entry switch ---------------------------------------------

  const prefilledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!current || prefilledFor.current === current.key) return;
    prefilledFor.current = current.key;
    const logged = setsForExercise(current.exercise_id);
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
  }, [current, setsForExercise, lastActuals]);

  // ---- actions -------------------------------------------------------------

  const logSet = () => {
    if (!current || !sessionId || logLocked || !setsLoaded) return;
    setLogLocked(true);
    window.setTimeout(() => setLogLocked(false), LOG_LOCK_MS);

    // set_index from the synchronous ref: max existing index + 1, per exercise
    const nextIndex =
      setsRef.current
        .filter((s) => s.exercise_id === current.exercise_id)
        .reduce((m, s) => Math.max(m, s.set_index), -1) + 1;
    const set: SetInsert = {
      id: uuid(),
      session_id: sessionId,
      exercise_id: current.exercise_id,
      prescription_id: current.rx?.id ?? null,
      set_index: nextIndex,
      set_type: setType,
      load_kg: loadKg,
      reps,
      performed_at: new Date().toISOString(),
    };
    const next = applySets((prev) => [...prev, set]);
    cacheSet(cacheKeys.sessionSets(sessionId), next).catch((e: unknown) =>
      reportError(e, "cache session sets"),
    );
    outbox
      .enqueue({ kind: "insert", table: "sets", payload: set })
      .catch((e: unknown) => reportError(e, "log set"));

    const rest = current.rx?.rest_seconds ?? DEFAULT_REST_SECONDS;
    setTimerEndsAt(Date.now() + rest * 1000);
    setSetType("working");
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
    // if the exercise is already on the list (prescribed or added), select it
    const existing = entries.find((e) => e.exercise_id === ex.id);
    if (existing) {
      setCurrentEntryId(existing.key);
      setSearchOpen(false);
      setDrawerOpen(false);
      return;
    }
    const nextExtras = [...extras, { exercise_id: ex.id, name: ex.name }];
    setExtras(nextExtras);
    await cacheSet(cacheKeys.sessionExtras(sessionId), nextExtras);
    setCurrentEntryId(`extra:${ex.id}`);
    setSearchOpen(false);
    setDrawerOpen(false);
  };

  // ---- render --------------------------------------------------------------

  if (active === undefined) return <div className="screen muted">Loading…</div>;
  if (!active) return null;

  const currentEntrySets = current ? setsForEntry(current) : [];
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
                target {formatRxTarget(current.rx, unit)}
                {rxHasNoTm(current.rx) ? " · no TM set" : ""}
              </div>
            )}
            <div className="rx-context muted">
              logged {currentEntrySets.length}
              {current.rx ? ` / ${current.rx.sets}` : ""} sets
            </div>
          </div>

          <Stepper
            label={`load (${unit})`}
            value={loadKg}
            display={String(toDisplay(loadKg, unit))}
            step={stepKg(unit, false)}
            fineStep={stepKg(unit, true)}
            max={MAX_LOAD_KG}
            onChange={setLoadKg}
          />
          <Stepper
            label="reps"
            value={reps}
            display={String(reps)}
            step={1}
            min={0}
            max={MAX_REPS}
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
            disabled={logLocked || !setsLoaded}
            onClick={logSet}
          >
            {setsLoaded ? "Log set" : "Loading…"}
          </button>

          {currentEntrySets.length > 0 && (
            <div className="logged-sets">
              {currentEntrySets.map((s) => (
                <SetRow key={s.id} set={s} unit={unit} />
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
              const done = setsForEntry(e).length;
              return (
                <button
                  key={e.key}
                  type="button"
                  className={`drawer-row ${current?.key === e.key ? "drawer-on" : ""}`}
                  onClick={() => {
                    setCurrentEntryId(e.key);
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

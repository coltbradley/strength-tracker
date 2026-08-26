// Set entry — the core screen. Everything the screen needs is served from
// the IndexedDB cache written at session start, so it works fully offline
// mid-gym. Sets are append-only: a mistake is corrected by logging another
// set, never edited.
//
// State notes (preserved from the review round):
// - Entries are keyed by prescription id (or `extra:<exercise_id>`), so the
//   same exercise under two prescriptions stays two distinct entries.
//   set_index stays scoped per EXERCISE across entries.
// - `setsRef` is the synchronous source of truth for logged sets: log taps
//   compute set_index from it atomically; bootstrap merges INTO it by id.
// - Rest: the timer starts when a set is logged; when the NEXT set is logged
//   the elapsed rest is stamped onto it as rest_seconds_actual (append-only —
//   never an update to a prior row). DONE hides the strip but keeps the
//   clock running for recording; > 3600 s elapsed records null.
// - Sheets (drawer / search / pad / plates) are mutually exclusive and the
//   rest strip hides while one is open.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Stepper } from "../components/Stepper";
import { RestTimer } from "../components/RestTimer";
import { SetRow } from "../components/SetRow";
import { NumberPad, type PadRequest } from "../components/NumberPad";
import { PlateSheet } from "../components/PlateSheet";
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
import { split } from "../lib/plates";
import { formatClock, formatRxTarget, rxHasNoTm } from "../lib/format";
import { reportError } from "../lib/errors";
import { useUnit } from "../hooks/useUnit";
import {
  useBarKg,
  useDefaultRestSeconds,
  usePlatesOnHand,
} from "../hooks/useSettings";
import { fromDisplay, kgToLb, stepKg, toDisplay } from "../lib/units";
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

interface RestState {
  startedAt: number;
  targetSeconds: number;
  forLabel: string;
}

type PadKind = "load" | "reps" | "rest";
interface PadSpec {
  kind: PadKind;
  fromPlates?: boolean;
}

const SET_TYPES: SetType[] = ["warmup", "working", "backoff"];
const LOG_LOCK_MS = 400;
// DB checks: reps between 0 and 100; rest_seconds_actual <= 3600
const MAX_REPS = 100;
const MAX_LOAD_KG = 999;
const MAX_REST_SECONDS = 3600;

export function Session() {
  const navigate = useNavigate();
  const unit = useUnit();
  const defaultRest = useDefaultRestSeconds();
  const inventory = usePlatesOnHand(unit);
  const barKg = useBarKg(unit);

  const [active, setActive] = useState<ActiveSession | null | undefined>(
    undefined,
  );
  const [rx, setRx] = useState<ResolvedPrescriptionRow[]>([]);
  const [extras, setExtras] = useState<ExtraExercise[]>([]);
  const [sets, setSets] = useState<SetInsert[]>([]);
  const [setsLoaded, setSetsLoaded] = useState(false);
  const [lastActuals, setLastActuals] = useState<LastActuals>({});
  const [equipMap, setEquipMap] = useState<Record<string, string | null>>({});
  const [currentEntryId, setCurrentEntryId] = useState<string | null>(null);

  const [loadKg, setLoadKg] = useState(20);
  const [reps, setReps] = useState(8);
  const [setType, setSetType] = useState<SetType>("working");
  const [logLocked, setLogLocked] = useState(false);

  const [rest, setRest] = useState<RestState | null>(null);
  // survives DONE so the next log can still record elapsed rest
  const restRef = useRef<{ startedAt: number } | null>(null);

  const [sheet, setSheet] = useState<"drawer" | "search" | "plates" | null>(
    null,
  );
  const [pad, setPad] = useState<PadSpec | null>(null);
  const [search, setSearch] = useState("");
  const [allExercises, setAllExercises] = useState<ExerciseRow[]>([]);
  const [exercisesFailed, setExercisesFailed] = useState(false);

  // The bootstrap load can come up empty (first run, offline, cold cache);
  // opening the search sheet retries rather than showing a lying spinner.
  useEffect(() => {
    if (sheet !== "search" || allExercises.length > 0) return;
    let cancelled = false;
    setExercisesFailed(false);
    getExercises()
      .then((r) => {
        if (cancelled) return;
        setAllExercises(r.data);
        setEquipMap(Object.fromEntries(r.data.map((e) => [e.id, e.equipment])));
      })
      .catch(() => {
        if (!cancelled) setExercisesFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet]);

  const sessionId = active?.id ?? null;

  // Synchronous source of truth for logged sets.
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
        const [rxCached, extrasCached, actuals, exercises] = await Promise.all([
          cacheGet<ResolvedPrescriptionRow[]>(cacheKeys.sessionRx(a.id)),
          cacheGet<ExtraExercise[]>(cacheKeys.sessionExtras(a.id)),
          getLastActuals(a.id).catch(() => ({ data: {} as LastActuals })),
          getExercises().catch(() => ({ data: [] as ExerciseRow[] })),
        ]);
        if (cancelled) return;
        setRx(rxCached ?? []);
        setExtras(extrasCached ?? []);
        setLastActuals(actuals.data);
        setEquipMap(
          Object.fromEntries(exercises.data.map((e) => [e.id, e.equipment])),
        );
        setAllExercises(exercises.data);
        const [server, pending] = await Promise.all([
          getServerSessionSets(a.id),
          outbox.pendingSets(a.id),
        ]);
        if (cancelled) return;
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

  const setsForExercise = useCallback(
    (exerciseId: string) => sets.filter((s) => s.exercise_id === exerciseId),
    [sets],
  );

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

  const equipment = current ? (equipMap[current.exercise_id] ?? null) : null;
  const plateable = equipment === "barbell" || equipment === "machine";
  const machine = equipment === "machine";

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

  // ---- rest helpers --------------------------------------------------------

  const restElapsedSeconds = (): number | null => {
    if (!restRef.current) return null;
    return (Date.now() - restRef.current.startedAt) / 1000;
  };

  const recordableRest = (): number | null => {
    const el = restElapsedSeconds();
    if (el === null || el > MAX_REST_SECONDS) return null;
    return Math.max(0, Math.round(el));
  };

  // ---- actions -------------------------------------------------------------

  const logSet = () => {
    if (!current || !sessionId || logLocked || !setsLoaded) return;
    setLogLocked(true);
    window.setTimeout(() => setLogLocked(false), LOG_LOCK_MS);

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
      rest_seconds_actual: recordableRest(),
    };
    const next = applySets((prev) => [...prev, set]);
    cacheSet(cacheKeys.sessionSets(sessionId), next).catch((e: unknown) =>
      reportError(e, "cache session sets"),
    );
    outbox
      .enqueue({ kind: "insert", table: "sets", payload: set })
      .catch((e: unknown) => reportError(e, "log set"));

    const now = Date.now();
    restRef.current = { startedAt: now };
    setRest({
      startedAt: now,
      targetSeconds: current.rx?.rest_seconds ?? defaultRest,
      forLabel: `${current.name} set ${nextIndex + 1}`,
    });
    setSetType("working");
  };

  const openSheet = (kind: "drawer" | "search" | "plates") => {
    setSheet(kind);
    setPad(null);
    setSearch("");
  };

  const openPad = (kind: PadKind, fromPlates = false) => {
    setPad({ kind, fromPlates });
    setSheet(null);
  };

  const addExercise = async (ex: ExerciseRow) => {
    if (!sessionId) return;
    const existing = entries.find((e) => e.exercise_id === ex.id);
    if (existing) {
      setCurrentEntryId(existing.key);
      setSheet(null);
      return;
    }
    const nextExtras = [...extras, { exercise_id: ex.id, name: ex.name }];
    setExtras(nextExtras);
    await cacheSet(cacheKeys.sessionExtras(sessionId), nextExtras);
    setCurrentEntryId(`extra:${ex.id}`);
    setSheet(null);
  };

  // ---- pad request ---------------------------------------------------------

  const padRequest = (): PadRequest | null => {
    if (!pad || !current) return null;
    const U = unit.toUpperCase();
    if (pad.kind === "load") {
      return {
        label: `${current.name.toUpperCase()} · LOAD IN ${U}`,
        action: pad.fromPlates ? "BACK TO PLATES" : "SET LOAD",
        initial: String(toDisplay(loadKg, unit)),
        allowDecimal: true,
        onCommit: (v) => {
          const kg = Math.min(MAX_LOAD_KG, Math.max(0, fromDisplay(v, unit)));
          setLoadKg(Math.round(kg * 100) / 100);
          setPad(null);
          if (pad.fromPlates) setSheet("plates");
        },
        onCancel: () => {
          setPad(null);
          if (pad.fromPlates) setSheet("plates");
        },
      };
    }
    if (pad.kind === "reps") {
      return {
        label: `${current.name.toUpperCase()} · REPS`,
        action: "SET REPS",
        initial: String(reps),
        allowDecimal: false,
        onCommit: (v) => {
          setReps(Math.min(MAX_REPS, Math.max(0, Math.round(v))));
          setPad(null);
        },
        onCancel: () => setPad(null),
      };
    }
    // rest: type the seconds REMAINING; target = elapsed + typed
    const el = restElapsedSeconds() ?? 0;
    const remaining = rest
      ? Math.max(0, Math.round(rest.targetSeconds - el))
      : 0;
    return {
      label: "REST · SECONDS REMAINING",
      action: "SET REST",
      initial: String(remaining),
      allowDecimal: false,
      onCommit: (v) => {
        const want = Math.min(MAX_REST_SECONDS, Math.max(0, Math.round(v)));
        // elapsed re-read at commit time so typing delay doesn't skew it
        const nowEl = Math.round(restElapsedSeconds() ?? 0);
        setRest((r) => (r ? { ...r, targetSeconds: nowEl + want } : r));
        setPad(null);
      },
      onCancel: () => setPad(null),
    };
  };

  // ---- render --------------------------------------------------------------

  if (active === undefined) return <div className="screen muted">Loading…</div>;
  if (!active) return null;

  const currentEntrySets = current ? setsForEntry(current) : [];
  const exerciseSets = current ? setsForExercise(current.exercise_id) : [];
  const nextSetNo =
    exerciseSets.reduce((m, s) => Math.max(m, s.set_index), -1) + 2;

  const filtered = allExercises
    .filter((e) => e.name.toLowerCase().includes(search.toLowerCase()))
    .slice(0, 30);

  const hint = plateable
    ? (() => {
        const r = split(loadKg, machine ? 0 : barKg, inventory);
        return r.plates.length > 0
          ? r.plates
              .map(
                (p) =>
                  `${p.count > 1 ? `${p.count}×` : ""}${toDisplay(p.plate, unit)}`,
              )
              .join("·")
          : "BAR ONLY";
      })()
    : null;

  const loadSub =
    unit === "lb"
      ? `${Math.round(loadKg * 10) / 10} kg stored`
      : `${Math.round(kgToLb(loadKg) * 10) / 10} lb`;

  /** rest AFTER a given set: next exercise-set's stored value, or live timer */
  const restAfter = (s: SetInsert): string | null => {
    const nextSet = exerciseSets.find((x) => x.set_index === s.set_index + 1);
    if (nextSet)
      return nextSet.rest_seconds_actual !== null
        ? `rest ${formatClock(nextSet.rest_seconds_actual)}`
        : null;
    // last set of the exercise: live rest if it's the one being timed
    const isLast = exerciseSets.every((x) => x.set_index <= s.set_index);
    if (isLast && restRef.current) {
      const el = restElapsedSeconds();
      if (el !== null && el <= MAX_REST_SECONDS)
        return `rest ${formatClock(el)}`;
    }
    return null;
  };

  const req = padRequest();
  const sheetOpen = sheet !== null || pad !== null;

  return (
    <div className="session-shell">
      <div className="session-scroll">
        {current ? (
          <>
            <button
              type="button"
              className="session-head"
              onClick={() => openSheet("drawer")}
            >
              <span className="session-exercise">
                {current.name} <span className="chev">▾</span>
              </span>
              {current.rx && (
                <span className="rx-context">
                  TARGET {formatRxTarget(current.rx, unit).toUpperCase()}
                  {current.rx.rest_seconds !== null
                    ? ` · REST ${formatClock(current.rx.rest_seconds)}`
                    : ""}
                  {rxHasNoTm(current.rx) ? " · NO TM SET" : ""}
                </span>
              )}
              <span className="session-progress">
                LOGGED {currentEntrySets.length}
                {current.rx ? ` / ${current.rx.sets}` : ""}
                {!current.rx && currentEntrySets.length === 1
                  ? " SET"
                  : " SETS"}
                {equipment ? ` · ${equipment.toUpperCase()}` : ""}
              </span>
            </button>

            <section className="rule-section">
              <div className="section-head">
                <span className="field-label">LOAD · {unit.toUpperCase()}</span>
                {hint !== null && (
                  <button
                    type="button"
                    className="plate-hint"
                    onClick={() => openSheet("plates")}
                  >
                    {hint} ›
                  </button>
                )}
              </div>
              <Stepper
                label="load"
                accent
                display={String(toDisplay(loadKg, unit))}
                subText={loadSub}
                onTapValue={() => openPad("load")}
                value={loadKg}
                min={0}
                max={MAX_LOAD_KG}
                onChange={setLoadKg}
                steps={[
                  {
                    label: `− ${unit === "lb" ? 5 : 2.5}`,
                    delta: -stepKg(unit, false),
                  },
                  {
                    label: `+ ${unit === "lb" ? 5 : 2.5}`,
                    delta: stepKg(unit, false),
                  },
                  {
                    label: `− ${unit === "lb" ? 1 : 0.5}`,
                    delta: -stepKg(unit, true),
                    fine: true,
                  },
                  {
                    label: `+ ${unit === "lb" ? 1 : 0.5}`,
                    delta: stepKg(unit, true),
                    fine: true,
                  },
                ]}
              />
            </section>

            <section className="rule-section">
              <div className="section-head">
                <span className="field-label">REPS</span>
              </div>
              <Stepper
                label="reps"
                inline
                display={String(reps)}
                onTapValue={() => openPad("reps")}
                value={reps}
                min={0}
                max={MAX_REPS}
                onChange={(v) => setReps(Math.round(v))}
                steps={[
                  { label: "−", delta: -1 },
                  { label: "+", delta: 1 },
                ]}
              />
            </section>

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
              {setsLoaded ? `LOG SET ${nextSetNo}` : "LOADING…"}
            </button>

            {currentEntrySets.length > 0 && (
              <section className="rule-section">
                <div className="section-head">
                  <span className="field-label">LOGGED · APPEND ONLY</span>
                  <span className="section-meta">
                    {currentEntrySets.length}
                    {current.rx ? ` OF ${current.rx.sets}` : ""}
                  </span>
                </div>
                <div className="logged-sets">
                  {currentEntrySets
                    .slice()
                    .sort((a, b) => b.set_index - a.set_index)
                    .map((s) => (
                      <SetRow
                        key={s.id}
                        set={s}
                        unit={unit}
                        restLabel={restAfter(s)}
                      />
                    ))}
                </div>
                <div className="microcopy">
                  Wrong number? Log the right set — the record keeps both.
                </div>
              </section>
            )}
          </>
        ) : (
          <div className="session-empty">
            <p className="muted">No exercises yet.</p>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => openSheet("search")}
            >
              Add exercise
            </button>
          </div>
        )}
      </div>

      {!sheetOpen && (
        <RestTimer
          rest={rest}
          onAdjust={(d) =>
            setRest((r) =>
              r ? { ...r, targetSeconds: Math.max(0, r.targetSeconds + d) } : r,
            )
          }
          onEdit={() => openPad("rest")}
          onDone={() => setRest(null)}
        />
      )}

      <div className="session-footer">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => openSheet("drawer")}
        >
          Exercises
        </button>
        <button
          type="button"
          className="btn btn-outline-ink"
          onClick={() => navigate("/end")}
        >
          Finish
        </button>
      </div>

      {sheet === "drawer" && (
        <div className="sheet-backdrop" onClick={() => setSheet(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <span className="sheet-title">
                EXERCISES
                {active.workout_label
                  ? ` · ${active.workout_label.toUpperCase()}`
                  : ""}
              </span>
              <button
                type="button"
                className="sheet-close"
                onClick={() => setSheet(null)}
              >
                CLOSE
              </button>
            </div>
            {entries.map((e) => {
              const done = setsForEntry(e).length;
              const eq = equipMap[e.exercise_id];
              return (
                <button
                  key={e.key}
                  type="button"
                  className={`drawer-row ${current?.key === e.key ? "drawer-on" : ""}`}
                  onClick={() => {
                    setCurrentEntryId(e.key);
                    setSheet(null);
                  }}
                >
                  <span className="drawer-name">{e.name}</span>
                  <span className="drawer-tag">
                    {eq ? eq.toUpperCase() : ""}
                  </span>
                  <span
                    className={`drawer-count ${e.rx && done >= e.rx.sets ? "drawer-count-done" : ""}`}
                  >
                    {done}
                    {e.rx ? `/${e.rx.sets}` : ""}
                  </span>
                </button>
              );
            })}
            <button
              type="button"
              className="btn btn-outline-ink"
              onClick={() => openSheet("search")}
            >
              Add exercise
            </button>
          </div>
        </div>
      )}

      {sheet === "search" && (
        <div className="sheet-backdrop" onClick={() => setSheet(null)}>
          <div
            className="sheet sheet-tall"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sheet-head">
              <span className="sheet-title">
                ADD EXERCISE
                {allExercises.length > 0
                  ? ` · ${allExercises.length} IN LIBRARY`
                  : ""}
              </span>
              <button
                type="button"
                className="sheet-close"
                onClick={() => setSheet(null)}
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
              {filtered.map((ex) => (
                <button
                  key={ex.id}
                  type="button"
                  className="drawer-row"
                  onClick={() => void addExercise(ex)}
                >
                  <span className="drawer-name">{ex.name}</span>
                  <span
                    className={`drawer-tag ${
                      ex.equipment === "barbell" || ex.equipment === "machine"
                        ? "drawer-tag-accent"
                        : ""
                    }`}
                  >
                    {ex.equipment ? ex.equipment.toUpperCase() : ""}
                  </span>
                </button>
              ))}
              {allExercises.length === 0 && (
                <p className="muted">
                  {exercisesFailed
                    ? "Exercise list unavailable offline — it caches after the first online load."
                    : "Loading exercise list…"}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {sheet === "plates" && current && (
        <PlateSheet
          exerciseName={current.name}
          targetKg={loadKg}
          unit={unit}
          machine={machine}
          onTypeTarget={() => openPad("load", true)}
          onClose={() => setSheet(null)}
        />
      )}

      {req && <NumberPad req={req} />}
    </div>
  );
}

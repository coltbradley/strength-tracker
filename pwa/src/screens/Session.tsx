// Set entry — the core screen. The workout is ONE accordion list: every
// exercise visible, exactly one open at a time, the logging surface lives
// inside the open item. Everything the screen needs is served from the
// IndexedDB cache written at session start (with a best-effort refresh when
// the prescription snapshot is empty), so it works fully offline mid-gym.
// Sets are append-only: a mistake is corrected by voiding and relogging.
//
// State notes (preserved from the review rounds):
// - Entries are keyed by prescription id (or `extra:<exercise_id>`), so the
//   same exercise under two prescriptions stays two distinct entries.
//   set_index stays scoped per EXERCISE across entries.
// - Every logged set must be visible somewhere: sets whose prescription_id
//   is null or dangling are claimed by the first rx entry for their
//   exercise, or get a synthesized fallback entry.
// - `setsRef` is the synchronous source of truth for logged sets: log taps
//   compute set_index from it atomically; bootstrap merges INTO it by id.
// - Rest: the timer starts when a set is logged; the NEXT set records the
//   elapsed rest (append-only). Voiding the set that started the clock
//   cancels it. The clock survives Home round-trips via the cache.
// - Supersets: consecutive rx entries sharing superset_group get A1/A2 tags
//   and a bracket rail. Suggestion only — logging order is never enforced.
// - Per-set notes live in set_notes (editable, last-write-wins), cached per
//   session and queued through the outbox like everything else.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Stepper } from "../components/Stepper";
import { Note } from "../components/Note";
import { RestTimer } from "../components/RestTimer";
import { SetRow } from "../components/SetRow";
import { NumberPad, type PadRequest } from "../components/NumberPad";
import { PlateSheet } from "../components/PlateSheet";
import { cacheDelete, cacheGet, cacheSet, cacheKeys } from "../lib/db";
import {
  getExercises,
  getLastActuals,
  getResolvedPrescriptions,
  getServerSessionSets,
  getSetNotesByIds,
  mergeSets,
  type LastActuals,
} from "../lib/data";
import { outbox } from "../lib/sync";
import { uuid } from "../lib/uuid";
import { prefillSet } from "../lib/prefill";
import { split } from "../lib/plates";
import {
  formatClock,
  formatRepRange,
  rxHasNoTm,
  rxLoadKg,
} from "../lib/format";
import { reportError, toast } from "../lib/errors";
import { useUnit } from "../hooks/useUnit";
import { useArmed } from "../hooks/useArmed";
import {
  useDefaultRestSeconds,
  useExerciseBarKg,
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
  /** first bracket's prescription id, or `extra:<exercise_id>` */
  key: string;
  exercise_id: string;
  name: string;
  /** consecutive prescriptions for this exercise (a coach's ramp brackets,
   *  e.g. 1×8-15, 1×6-8, 3×3-5) — ONE entry, walked through in order.
   *  Empty = unprescribed. */
  brackets: ResolvedPrescriptionRow[];
}

/** total prescribed working sets across an entry's brackets */
function totalSets(entry: ExerciseEntry): number {
  return entry.brackets.reduce((n, b) => n + b.sets, 0);
}

/** the bracket the (n+1)th working set falls into */
function bracketFor(
  entry: ExerciseEntry,
  n: number,
): ResolvedPrescriptionRow | null {
  let acc = 0;
  for (const b of entry.brackets) {
    acc += b.sets;
    if (n < acc) return b;
  }
  return entry.brackets[entry.brackets.length - 1] ?? null;
}

interface RestState {
  startedAt: number;
  targetSeconds: number;
  forLabel: string;
}

/** Cached mirror of the rest clock. targetSeconds null = strip dismissed but
 *  the clock still runs for rest_seconds_actual recording. */
interface RestCache {
  startedAt: number;
  targetSeconds: number | null;
  forLabel: string | null;
}

type PadKind = "load" | "reps" | "rest";
interface PadSpec {
  kind: PadKind;
  fromPlates?: boolean;
}

// backoff stays a legal DB value (legacy sets render fine); it's just no
// longer offered — warmup or working covers how the coach programs
const SET_TYPES: SetType[] = ["warmup", "working"];
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

  const [active, setActive] = useState<ActiveSession | null | undefined>(
    undefined,
  );
  const [rx, setRx] = useState<ResolvedPrescriptionRow[]>([]);
  const [extras, setExtras] = useState<ExtraExercise[]>([]);
  const [sets, setSets] = useState<SetInsert[]>([]);
  const [setsLoaded, setSetsLoaded] = useState(false);
  const [lastActuals, setLastActuals] = useState<LastActuals>({});
  const [equipMap, setEquipMap] = useState<Record<string, string | null>>({});
  const [openKey, setOpenKey] = useState<string | null>(null);

  const [loadKg, setLoadKg] = useState(20);
  const [reps, setReps] = useState(8);
  const [setType, setSetType] = useState<SetType>("working");
  const [logLocked, setLogLocked] = useState(false);

  const [rest, setRest] = useState<RestState | null>(null);
  // survives DONE so the next log can still record elapsed rest
  const restRef = useRef<{ startedAt: number } | null>(null);

  // corrections: voided set ids (append-only voiding) and skipped entry keys
  const [voids, setVoids] = useState<Set<string>>(new Set());
  const [skips, setSkips] = useState<Set<string>>(new Set());
  const [voidArm, setVoidArm] = useArmed();

  // per-set notes (set_id -> note); "" = cleared
  const [setNotes, setSetNotes] = useState<Record<string, string>>({});
  const [noteEditingId, setNoteEditingId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

  const [sheet, setSheet] = useState<"search" | "plates" | null>(null);
  const [pad, setPad] = useState<PadSpec | null>(null);
  const [search, setSearch] = useState("");
  const [allExercises, setAllExercises] = useState<ExerciseRow[]>([]);
  const [exercisesFailed, setExercisesFailed] = useState(false);

  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());

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
        let a: ActiveSession | null | undefined;
        try {
          a = await cacheGet<ActiveSession>(cacheKeys.activeSession);
        } catch (e) {
          // a broken cache read must not strand the screen on "Loading…"
          reportError(e, "read active session");
          a = null;
        }
        if (cancelled) return;
        if (!a) {
          setActive(null);
          return;
        }
        setActive(a);
        const [
          rxCachedRaw,
          extrasCached,
          voidsCached,
          skipsCached,
          restCached,
          notesCached,
          actuals,
          exercises,
        ] = await Promise.all([
          cacheGet<ResolvedPrescriptionRow[]>(cacheKeys.sessionRx(a.id)),
          cacheGet<ExtraExercise[]>(cacheKeys.sessionExtras(a.id)),
          cacheGet<string[]>(cacheKeys.sessionVoids(a.id)),
          cacheGet<string[]>(cacheKeys.sessionSkips(a.id)),
          cacheGet<RestCache>(cacheKeys.sessionRest(a.id)),
          cacheGet<Record<string, string>>(cacheKeys.sessionSetNotes(a.id)),
          getLastActuals(a.id).catch(() => ({ data: {} as LastActuals })),
          getExercises().catch(() => ({ data: [] as ExerciseRow[] })),
        ]);
        if (cancelled) return;
        // An empty prescription snapshot is usually an offline/cold start
        // that failed silently — retry now that we may be online, and heal
        // the cache so the session isn't permanently target-less.
        let rxCached = rxCachedRaw ?? [];
        if (rxCached.length === 0 && a.planned_workout_id) {
          try {
            const fresh = await getResolvedPrescriptions(a.planned_workout_id);
            if (fresh.data.length > 0) {
              rxCached = fresh.data;
              await cacheSet(cacheKeys.sessionRx(a.id), fresh.data);
            }
          } catch {
            // still offline: by-feel logging, prefill from history
          }
        }
        if (cancelled) return;
        // rehydrate the rest clock (lost otherwise on Home round-trips and
        // page evictions); a clock past the recordable window is dropped
        if (
          restCached &&
          (Date.now() - restCached.startedAt) / 1000 <= MAX_REST_SECONDS
        ) {
          restRef.current = { startedAt: restCached.startedAt };
          if (restCached.targetSeconds !== null) {
            setRest({
              startedAt: restCached.startedAt,
              targetSeconds: restCached.targetSeconds,
              forLabel: restCached.forLabel ?? "",
            });
          }
        }
        setRx(rxCached);
        setExtras(extrasCached ?? []);
        const voided = new Set(voidsCached ?? []);
        setVoids(voided);
        setSkips(new Set(skipsCached ?? []));
        setSetNotes(notesCached ?? {});
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
        const merged = applySets((prev) =>
          mergeSets(mergeSets(server, pending), prev).filter(
            (s) => !voided.has(s.id),
          ),
        );
        // notes may have been written on another device — best-effort merge
        getSetNotesByIds(merged.map((s) => s.id))
          .then((fresh) => {
            if (cancelled || Object.keys(fresh).length === 0) return;
            setSetNotes((prev) => {
              const next = { ...fresh, ...prev }; // local unsynced edits win
              cacheSet(cacheKeys.sessionSetNotes(a.id), next).catch(
                () => undefined,
              );
              return next;
            });
          })
          .catch(() => undefined);
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

  // mirror the rest clock to the cache; runs on every rest change (log,
  // adjust, dismiss) — restRef keeps startedAt even after the strip is done
  useEffect(() => {
    if (!sessionId) return;
    const startedAt = restRef.current?.startedAt;
    if (startedAt === undefined) return;
    const snapshot: RestCache = {
      startedAt,
      targetSeconds: rest?.targetSeconds ?? null,
      forLabel: rest?.forLabel ?? null,
    };
    cacheSet(cacheKeys.sessionRest(sessionId), snapshot).catch(() => undefined);
  }, [rest, sessionId]);

  // ---- exercise entries ----------------------------------------------------

  const knownRxIds = useMemo(() => new Set(rx.map((r) => r.id)), [rx]);

  /** a set whose prescription link points at nothing in this session's
   *  snapshot (null, or a prescription since deleted) */
  const isOrphanSet = useCallback(
    (s: SetInsert) =>
      s.prescription_id === null || !knownRxIds.has(s.prescription_id),
    [knownRxIds],
  );

  const entries: ExerciseEntry[] = useMemo(() => {
    // consecutive same-exercise prescriptions collapse into one entry with
    // bracket structure (a ramp reads as one exercise, not three rows);
    // NON-consecutive repeats (squat early + squat finisher) stay distinct
    const fromRx: ExerciseEntry[] = [];
    for (const r of rx) {
      const last = fromRx[fromRx.length - 1];
      if (
        last &&
        last.exercise_id === r.exercise_id &&
        last.brackets[0].superset_group === r.superset_group
      )
        last.brackets.push(r);
      else
        fromRx.push({
          key: r.id,
          exercise_id: r.exercise_id,
          name: r.exercise_name,
          brackets: [r],
        });
    }
    const covered = new Set(fromRx.map((f) => f.exercise_id));
    const extraEntries: ExerciseEntry[] = extras
      .filter((e) => !covered.has(e.exercise_id))
      .map((e) => ({
        key: `extra:${e.exercise_id}`,
        exercise_id: e.exercise_id,
        name: e.name,
        brackets: [],
      }));
    for (const e of extraEntries) covered.add(e.exercise_id);
    // No logged set may be invisible: synthesize entries for exercises that
    // have sets but no rx/extra entry (lost extras cache, plan edited
    // mid-session, sets logged on another device).
    const orphanIds = [
      ...new Set(
        sets
          .filter((s) => !covered.has(s.exercise_id) && isOrphanSet(s))
          .map((s) => s.exercise_id),
      ),
    ];
    const fallback: ExerciseEntry[] = orphanIds.map((id) => ({
      key: `extra:${id}`,
      exercise_id: id,
      name:
        allExercises.find((e) => e.id === id)?.name ?? id.replace(/_/g, " "),
      brackets: [],
    }));
    return [...fromRx, ...extraEntries, ...fallback];
  }, [rx, extras, sets, allExercises, isOrphanSet]);

  const openEntry = useMemo(
    () => entries.find((e) => e.key === openKey) ?? null,
    [entries, openKey],
  );

  const setsForExercise = useCallback(
    (exerciseId: string) => sets.filter((s) => s.exercise_id === exerciseId),
    [sets],
  );

  const setsForEntry = useCallback(
    (entry: ExerciseEntry) => {
      if (entry.brackets.length > 0) {
        const ids = new Set(entry.brackets.map((b) => b.id));
        // the FIRST rx entry for an exercise also claims that exercise's
        // orphan sets, so nothing logged can disappear from the UI
        const claimsOrphans =
          rx.find((r) => r.exercise_id === entry.exercise_id)?.id === entry.key;
        return sets.filter(
          (s) =>
            (s.prescription_id !== null && ids.has(s.prescription_id)) ||
            (claimsOrphans &&
              s.exercise_id === entry.exercise_id &&
              isOrphanSet(s)),
        );
      }
      return sets.filter(
        (s) => s.exercise_id === entry.exercise_id && isOrphanSet(s),
      );
    },
    [sets, rx, isOrphanSet],
  );

  /** working sets logged against an entry — the number that answers
   *  "am I done with this exercise" (warmups don't count toward the plan) */
  const workingCount = useCallback(
    (entry: ExerciseEntry) =>
      setsForEntry(entry).filter((s) => s.set_type === "working").length,
    [setsForEntry],
  );

  const entryDone = useCallback(
    (e: ExerciseEntry): boolean =>
      skips.has(e.key) ||
      (e.brackets.length > 0
        ? workingCount(e) >= totalSets(e)
        : setsForEntry(e).length > 0),
    [skips, workingCount, setsForEntry],
  );
  const doneEntries = entries.filter(entryDone).length;

  // default open: first incomplete entry, once, AFTER sets have merged —
  // otherwise a mid-workout reload opens exercise 1 instead of where the
  // user actually is
  const defaultOpened = useRef(false);
  useEffect(() => {
    if (!setsLoaded || defaultOpened.current || entries.length === 0) return;
    defaultOpened.current = true;
    setOpenKey(entries.find((e) => !entryDone(e))?.key ?? null);
  }, [setsLoaded, entries, entryDone]);

  // superset grouping: consecutive entries sharing a non-null group get
  // A1/A2 tags and a bracket rail
  const supersetInfo = useMemo(() => {
    const map = new Map<
      string,
      { tag: string; first: boolean; last: boolean }
    >();
    let i = 0;
    while (i < entries.length) {
      const group = entries[i].brackets[0]?.superset_group ?? null;
      if (group === null) {
        i++;
        continue;
      }
      let j = i;
      while (
        j < entries.length &&
        (entries[j].brackets[0]?.superset_group ?? null) === group
      )
        j++;
      if (j - i > 1) {
        const letter = String.fromCharCode(64 + group); // 1->A, 2->B
        for (let k = i; k < j; k++)
          map.set(entries[k].key, {
            tag: `${letter}${k - i + 1}`,
            first: k === i,
            last: k === j - 1,
          });
      }
      i = j;
    }
    return map;
  }, [entries]);

  // "NEXT ▸" hint once the open exercise is complete — suggestion, not
  // auto-advance
  const nextEntry = useMemo(() => {
    if (!openEntry || !entryDone(openEntry)) return null;
    const idx = entries.findIndex((e) => e.key === openEntry.key);
    return entries.slice(idx + 1).find((e) => !entryDone(e)) ?? null;
  }, [openEntry, entries, entryDone]);

  const equipment = openEntry
    ? (equipMap[openEntry.exercise_id] ?? null)
    : null;
  const plateable = equipment === "barbell" || equipment === "machine";
  // per-exercise bar (0 = plate-loaded, e.g. leg press); persisted choice
  const exerciseBarKg = useExerciseBarKg(
    openEntry?.exercise_id ?? null,
    unit,
    equipment,
  );

  // ---- accordion -----------------------------------------------------------

  const toggleOpen = (key: string) => {
    setOpenKey((prev) => (prev === key ? null : key));
  };

  useEffect(() => {
    if (openKey)
      itemRefs.current
        .get(openKey)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [openKey]);

  // ---- prefill on entry open / bracket advance -----------------------------

  // the bracket the NEXT working set falls into; walking into a new bracket
  // re-prefills (its rep range, its load if set) mid-exercise
  const currentBracket = openEntry
    ? bracketFor(openEntry, workingCount(openEntry))
    : null;
  const prefillKey = openEntry
    ? `${openEntry.key}:${currentBracket?.id ?? "free"}`
    : null;

  const prefilledFor = useRef<string | null>(null);
  useEffect(() => {
    // wait for the sets merge: a mid-workout reload otherwise prefills from
    // the wrong bracket and can clobber staged values while a sheet is open
    if (!setsLoaded || !openEntry || prefillKey === null) return;
    if (prefilledFor.current === prefillKey) return;
    prefilledFor.current = prefillKey;
    const logged = setsForExercise(openEntry.exercise_id);
    const lastThis = logged[logged.length - 1];
    const p = prefillSet({
      prescription: currentBracket
        ? {
            resolved_load_kg: currentBracket.resolved_load_kg,
            plate_load_kg: currentBracket.plate_load_kg,
            reps_min: currentBracket.reps_min,
            reps_max: currentBracket.reps_max,
          }
        : null,
      lastThisSession: lastThis
        ? { load_kg: lastThis.load_kg, reps: lastThis.reps }
        : null,
      lastSession: lastActuals[openEntry.exercise_id] ?? null,
    });
    setLoadKg(p.loadKg);
    setReps(p.reps);
    setSetType("working");
  }, [
    setsLoaded,
    openEntry,
    prefillKey,
    currentBracket,
    setsForExercise,
    lastActuals,
  ]);

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
    if (!openEntry || !sessionId || logLocked || !setsLoaded) return;
    setLogLocked(true);
    window.setTimeout(() => setLogLocked(false), LOG_LOCK_MS);
    setVoidArm(null);
    // logging on a skipped exercise means it's happening after all
    if (skips.has(openEntry.key)) {
      const unskipped = new Set(skips);
      unskipped.delete(openEntry.key);
      persistSkips(unskipped);
    }

    const nextIndex =
      setsRef.current
        .filter((s) => s.exercise_id === openEntry.exercise_id)
        .reduce((m, s) => Math.max(m, s.set_index), -1) + 1;
    const set: SetInsert = {
      id: uuid(),
      session_id: sessionId,
      exercise_id: openEntry.exercise_id,
      // the set links to the BRACKET it fulfills, so adherence analytics see
      // the coach's actual scheme (warmups link to the upcoming bracket)
      prescription_id: currentBracket?.id ?? null,
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
      targetSeconds: currentBracket?.rest_seconds ?? defaultRest,
      forLabel: `${openEntry.name} set ${nextIndex + 1}`,
    });
    setSetType("working");
  };

  const openSheet = (kind: "search" | "plates") => {
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
      setOpenKey(existing.key);
      setSheet(null);
      return;
    }
    const nextExtras = [...extras, { exercise_id: ex.id, name: ex.name }];
    setExtras(nextExtras);
    await cacheSet(cacheKeys.sessionExtras(sessionId), nextExtras);
    setOpenKey(`extra:${ex.id}`);
    setSheet(null);
  };

  /** Void a logged set: hide it from every view via an append-only
   *  set_voids insert. The row itself is never edited or deleted. */
  const voidSet = (s: SetInsert) => {
    if (!sessionId) return;
    setVoidArm(null);
    // voiding the set that started the current rest cancels the clock —
    // the rest was being measured from a set that no longer counts
    const startedClock = setsRef.current.every(
      (x) => x.id === s.id || x.performed_at <= s.performed_at,
    );
    if (startedClock && restRef.current) {
      restRef.current = null;
      setRest(null);
      cacheDelete(cacheKeys.sessionRest(sessionId)).catch(() => undefined);
    }
    const nextVoids = new Set(voids);
    nextVoids.add(s.id);
    setVoids(nextVoids);
    cacheSet(cacheKeys.sessionVoids(sessionId), [...nextVoids]).catch(
      (e: unknown) => reportError(e, "cache voids"),
    );
    const next = applySets((prev) => prev.filter((x) => x.id !== s.id));
    cacheSet(cacheKeys.sessionSets(sessionId), next).catch((e: unknown) =>
      reportError(e, "cache session sets"),
    );
    outbox
      .enqueue({
        kind: "insert",
        table: "set_voids",
        payload: { set_id: s.id },
      })
      .catch((e: unknown) => reportError(e, "void set"));
    toast(`Set ${s.set_index + 1} voided`);
  };

  const persistSkips = (next: Set<string>) => {
    setSkips(next);
    if (sessionId)
      cacheSet(cacheKeys.sessionSkips(sessionId), [...next]).catch(
        (e: unknown) => reportError(e, "cache skips"),
      );
  };

  const toggleSkip = (entry: ExerciseEntry) => {
    const next = new Set(skips);
    if (next.has(entry.key)) next.delete(entry.key);
    else next.add(entry.key);
    persistSkips(next);
  };

  /** Extras with no logged sets can be removed outright (session-local). */
  const removeExtra = async (entry: ExerciseEntry) => {
    if (!sessionId || entry.brackets.length > 0) return;
    const nextExtras = extras.filter(
      (e) => e.exercise_id !== entry.exercise_id,
    );
    setExtras(nextExtras);
    await cacheSet(cacheKeys.sessionExtras(sessionId), nextExtras);
    // drop any lingering skip so re-adding doesn't arrive pre-skipped
    if (skips.has(entry.key)) {
      const nextSkips = new Set(skips);
      nextSkips.delete(entry.key);
      persistSkips(nextSkips);
    }
    if (openKey === entry.key) setOpenKey(null);
  };

  // ---- per-set notes -------------------------------------------------------

  const openNote = (setId: string) => {
    setNoteEditingId(setId);
    setNoteDraft(setNotes[setId] ?? "");
  };

  const saveNote = (setId: string) => {
    if (!sessionId) return;
    const note = noteDraft.trim();
    const next = { ...setNotes, [setId]: note };
    setSetNotes(next);
    setNoteEditingId(null);
    cacheSet(cacheKeys.sessionSetNotes(sessionId), next).catch(() => undefined);
    outbox
      .enqueue({
        kind: "insert",
        table: "set_notes",
        payload: { set_id: setId, note },
      })
      .catch((e: unknown) => reportError(e, "save set note"));
  };

  // ---- pad request ---------------------------------------------------------

  const padRequest = (): PadRequest | null => {
    if (!pad || !openEntry) return null;
    const U = unit.toUpperCase();
    if (pad.kind === "load") {
      return {
        label: `${openEntry.name.toUpperCase()} · LOAD IN ${U}`,
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
        label: `${openEntry.name.toUpperCase()} · REPS`,
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

  const entrySets = openEntry ? setsForEntry(openEntry) : [];
  const exerciseSets = openEntry ? setsForExercise(openEntry.exercise_id) : [];

  const filtered = allExercises
    .filter((e) => e.name.toLowerCase().includes(search.toLowerCase()))
    .slice(0, 30);

  const hint = plateable
    ? (() => {
        const r = split(loadKg, exerciseBarKg, inventory);
        return r.plates.length > 0
          ? r.plates
              .map(
                (p) =>
                  `${p.count > 1 ? `${p.count}×` : ""}${toDisplay(p.plate, unit)}`,
              )
              .join("·")
          : exerciseBarKg > 0
            ? "BAR ONLY"
            : "EMPTY";
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
    const isLast = exerciseSets.every((x) => x.set_index <= s.set_index);
    if (isLast && restRef.current) {
      const el = restElapsedSeconds();
      if (el !== null && el <= MAX_REST_SECONDS)
        return `rest ${formatClock(el)}`;
    }
    return null;
  };

  /** "1×8-15 @ 90 · 3×3-5" — an entry's full prescribed scheme */
  const bracketSpec = (b: ResolvedPrescriptionRow): string => {
    const load = rxLoadKg(b);
    const base = `${b.sets}×${formatRepRange(b.reps_min, b.reps_max)}`;
    return load !== null ? `${base} @ ${toDisplay(load, unit)} ${unit}` : base;
  };
  const scheme = (entry: ExerciseEntry): string =>
    entry.brackets.map(bracketSpec).join(" · ");

  /** "LOG WARMUP SET", "LOG SET 2 OF 5", or "LOG EXTRA SET" past the plan */
  const logLabel = (entry: ExerciseEntry): string => {
    if (!setsLoaded) return "LOADING…";
    if (setType === "warmup") return "LOG WARMUP SET";
    const n = workingCount(entry) + 1;
    if (entry.brackets.length === 0) return `LOG SET ${n}`;
    return n > totalSets(entry)
      ? "LOG EXTRA SET"
      : `LOG SET ${n} OF ${totalSets(entry)}`;
  };

  const req = padRequest();
  const sheetOpen = sheet !== null || pad !== null;

  return (
    <div className="session-shell">
      <div className="session-scroll">
        {(active.plan_note || active.coach_note) && (
          <div className="session-notes">
            {active.plan_note && (
              <Note label="PLAN NOTE" text={active.plan_note} />
            )}
            {active.coach_note && (
              <Note label="COACH" text={active.coach_note} />
            )}
          </div>
        )}

        <section className="rule-section">
          <div className="section-head">
            <span className="field-label">
              {active.workout_label
                ? active.workout_label.toUpperCase()
                : "WORKOUT"}
            </span>
            {entries.length > 0 && (
              <span className="section-meta">
                {doneEntries} OF {entries.length} DONE
              </span>
            )}
          </div>

          {entries.map((entry) => {
            const isOpen = entry.key === openKey;
            const prescribed = entry.brackets.length > 0;
            const done = prescribed
              ? workingCount(entry)
              : setsForEntry(entry).length;
            const total = prescribed ? totalSets(entry) : null;
            const skipped = skips.has(entry.key);
            const removable = !prescribed && setsForEntry(entry).length === 0;
            const superset = supersetInfo.get(entry.key);
            return (
              <div
                key={entry.key}
                ref={(el) => {
                  if (el) itemRefs.current.set(entry.key, el);
                  else itemRefs.current.delete(entry.key);
                }}
                className={`wk-item ${isOpen ? "wk-item-on" : ""}`}
              >
                <div className="wk-row">
                  {superset && (
                    <span
                      className={`wk-superset-rail ${superset.first ? "wk-superset-rail-start" : ""} ${superset.last ? "wk-superset-rail-end" : ""}`}
                    >
                      <span className="wk-superset-tag">{superset.tag}</span>
                    </span>
                  )}
                  {isOpen ? (
                    <button
                      type="button"
                      className="wk-header-open"
                      aria-expanded="true"
                      aria-label={`collapse ${entry.name}`}
                      onClick={() => toggleOpen(entry.key)}
                    >
                      {entry.name} <span className="chev">▾</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="wk-main"
                      aria-expanded="false"
                      onClick={() => toggleOpen(entry.key)}
                    >
                      <span
                        className={`wk-name ${skipped ? "wk-name-skipped" : ""}`}
                      >
                        {entry.name}
                      </span>
                      <span className="wk-target">
                        {skipped
                          ? "SKIPPED"
                          : prescribed
                            ? scheme(entry).toUpperCase()
                            : "NO TARGET · BY FEEL"}
                      </span>
                      <span
                        className={`wk-count ${total !== null && done >= total ? "wk-count-done" : ""}`}
                      >
                        {done}
                        {total !== null ? `/${total}` : ""}
                      </span>
                    </button>
                  )}
                  {!isOpen && (
                    <button
                      type="button"
                      className="drawer-action"
                      onClick={() =>
                        removable ? void removeExtra(entry) : toggleSkip(entry)
                      }
                    >
                      {removable ? "REMOVE" : skipped ? "UNSKIP" : "SKIP"}
                    </button>
                  )}
                </div>

                {isOpen && (
                  <div className="wk-open">
                    <span className="rx-context">
                      {prescribed ? (
                        <>
                          TARGET {scheme(entry).toUpperCase()}
                          {entry.brackets.length > 1 && currentBracket
                            ? ` · NOW ${formatRepRange(currentBracket.reps_min, currentBracket.reps_max)} REPS`
                            : ""}
                          {currentBracket?.rest_seconds != null
                            ? ` · REST ${formatClock(currentBracket.rest_seconds)}`
                            : ""}
                          {entry.brackets.some(rxHasNoTm) ? " · NO TM SET" : ""}
                        </>
                      ) : (
                        `NO TARGET · BY FEEL${equipment ? ` · ${equipment.toUpperCase()}` : ""}`
                      )}
                    </span>

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

                    <section className="rule-section">
                      <div className="section-head">
                        <span className="field-label">
                          LOAD · {unit.toUpperCase()}
                        </span>
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
                        ]}
                      />
                    </section>

                    {/* once the plan is met, NEXT leads and extra sets recede */}
                    <button
                      type="button"
                      className={`btn ${total !== null && done >= total ? "btn-outline-ink" : "btn-primary"} btn-log`}
                      disabled={logLocked || !setsLoaded}
                      onClick={logSet}
                    >
                      {logLabel(entry)}
                    </button>

                    {nextEntry && (
                      <button
                        type="button"
                        className="btn btn-primary btn-block"
                        onClick={() => setOpenKey(nextEntry.key)}
                      >
                        Next · {nextEntry.name}
                      </button>
                    )}

                    {entrySets.length > 0 && (
                      <section className="rule-section">
                        <div className="section-head">
                          <span className="field-label">LOGGED</span>
                          <span className="section-meta">
                            {done}
                            {total !== null ? ` OF ${total}` : ""}
                          </span>
                        </div>
                        <div className="logged-sets">
                          {entrySets
                            .slice()
                            .sort((a, b) => b.set_index - a.set_index)
                            .map((s) => (
                              <div key={s.id} className="logged-set-wrap">
                                <SetRow
                                  set={s}
                                  unit={unit}
                                  restLabel={restAfter(s)}
                                  onVoid={() => voidSet(s)}
                                  voidArmed={voidArm === s.id}
                                  onArmVoid={() => setVoidArm(s.id)}
                                />
                                {noteEditingId === s.id ? (
                                  <div className="set-note-editor">
                                    <textarea
                                      className="input note-input set-note-input"
                                      rows={2}
                                      autoFocus
                                      value={noteDraft}
                                      onChange={(e) =>
                                        setNoteDraft(e.target.value)
                                      }
                                      placeholder="Note on this set…"
                                    />
                                    <div className="set-note-actions">
                                      <button
                                        type="button"
                                        className="btn btn-ghost"
                                        onClick={() => setNoteEditingId(null)}
                                      >
                                        Cancel
                                      </button>
                                      <button
                                        type="button"
                                        className="btn btn-secondary"
                                        onClick={() => saveNote(s.id)}
                                      >
                                        Save
                                      </button>
                                    </div>
                                  </div>
                                ) : setNotes[s.id] ? (
                                  <button
                                    type="button"
                                    className="set-note-preview"
                                    onClick={() => openNote(s.id)}
                                  >
                                    {setNotes[s.id]}
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    className="set-note-add"
                                    onClick={() => openNote(s.id)}
                                  >
                                    + NOTE
                                  </button>
                                )}
                              </div>
                            ))}
                        </div>
                        <div className="microcopy">
                          Wrong number? Void the set (✕) and log the right one.
                        </div>
                      </section>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {entries.length === 0 && (
            <p className="microcopy">
              Nothing planned for this session. Add an exercise to start logging
              — load and reps prefill from your last time.
            </p>
          )}
          <button
            type="button"
            className="btn btn-outline-ink btn-block"
            onClick={() => openSheet("search")}
          >
            Add exercise
          </button>
        </section>
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
          className="btn btn-ghost"
          aria-label="back to Today — session keeps running"
          onClick={() => navigate("/")}
        >
          Home
        </button>
        <button
          type="button"
          className="btn btn-outline-ink"
          onClick={() => navigate("/end")}
        >
          Finish
        </button>
      </div>

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

      {sheet === "plates" && openEntry && (
        <PlateSheet
          exerciseId={openEntry.exercise_id}
          exerciseName={openEntry.name}
          targetKg={loadKg}
          unit={unit}
          equipment={equipment}
          onTypeTarget={() => openPad("load", true)}
          onClose={() => setSheet(null)}
        />
      )}

      {req && <NumberPad req={req} />}
    </div>
  );
}
